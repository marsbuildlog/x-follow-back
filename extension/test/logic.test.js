// 单元测试: node --test extension/test/
// 覆盖出过 bug 的核心纯逻辑: 响应解析 / 错误解释 / 队列合并 / 停顿判定 / 请求重放构造
const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../src/shared/logic.js');
const {
  localDateStr, rolloverDaily, atName, parseFollowers, interpret,
  mergeUsers, findPendingItem, evaluateStall, buildApiRequest,
  rateLimitBackoffMs, windowExhaustedWaitMs,
} = globalThis.RefollowLogic;

// ---------- 测试工具 ----------
// 构造 BlueVerifiedFollowers 风格响应(基于 2026-10 实测结构)
function userResult(overrides = {}) {
  return {
    __typename: 'User',
    rest_id: overrides.rest_id || '1001',
    is_blue_verified: true,
    core: { name: overrides.name || 'User A', screen_name: overrides.screen_name || 'usera' },
    follow_request_sent: false,
    relationship_perspectives: Object.assign(
      { blocked_by: false, blocking: false, followed_by: true, following: false, live_following: false, muting: false },
      overrides.rel || {}
    ),
  };
}
function wrap(entries) {
  return JSON.stringify({
    data: { user: { result: { timeline: { timeline: { instructions: [{ entries }] } } } } },
  });
}
function userEntry(result, entryId = 'user-1') {
  return { entryId, content: { itemContent: { user_results: { result } } } };
}

// ---------- parseFollowers ----------
test('parseFollowers: 解析实测新结构(core 身份 + relationship_perspectives 状态)', () => {
  const out = parseFollowers(wrap([userEntry(userResult())]));
  assert.equal(out.error, null);
  assert.equal(out.users.length, 1);
  const u = out.users[0];
  assert.equal(u.userId, '1001');
  assert.equal(u.screenName, 'usera');
  assert.equal(u.name, 'User A');
  assert.equal(u.following, false); // 我还没关注他 → 待回关
  assert.equal(u.followedBy, true); // 他关注了我
  assert.equal(u.blue, true);
});

test('parseFollowers: relationship_perspectives.following=true 时标记已关注', () => {
  const out = parseFollowers(wrap([userEntry(userResult({ rel: { following: true } }))]));
  assert.equal(out.users[0].following, true);
});

test('parseFollowers: 兼容旧 legacy 结构', () => {
  const legacyShape = {
    rest_id: '2002',
    is_blue_verified: true,
    legacy: { screen_name: 'legacyuser', name: 'Legacy', following: true, followed_by: false },
  };
  const out = parseFollowers(wrap([userEntry(legacyShape)]));
  const u = out.users[0];
  assert.equal(u.screenName, 'legacyuser');
  assert.equal(u.following, true);
  assert.equal(u.followedBy, false);
});

test('parseFollowers: 提取 cursor-bottom 游标', () => {
  const entries = [
    userEntry(userResult()),
    { entryId: 'cursor-bottom-1700000000', content: { value: 'aaa|bbb' } },
  ];
  const out = parseFollowers(wrap(entries));
  assert.equal(out.cursor, 'aaa|bbb');
});

test('parseFollowers: 空页(仅游标) → 0 人但 cursor 仍存在(终止条件依据)', () => {
  const entries = [{ entryId: 'cursor-bottom-x', content: { value: 'end' } }];
  const out = parseFollowers(wrap(entries));
  assert.equal(out.users.length, 0);
  assert.equal(out.cursor, 'end');
});

test('parseFollowers: errors 响应返回错误信息', () => {
  const out = parseFollowers('{"errors":[{"code":144,"message":"No user found"}]}');
  assert.match(out.error, /144/);
});

test('parseFollowers: 非 JSON 响应返回错误', () => {
  const out = parseFollowers('<html>forbidden</html>');
  assert.match(out.error, /响应不是 JSON/);
});

test('parseFollowers: 结构无法识别时报错并带原始片段', () => {
  const out = parseFollowers('{"data":{}}');
  assert.match(out.error, /结构无法识别|无法解析/);
});

// ---------- interpret ----------
test('interpret: 200 成功', () => {
  const r = interpret({ status: 200, ok: true, body: '{"data":{"user":{}}}' });
  assert.equal(r.ok, true);
});

test('interpret: 429 判定为限流', () => {
  const r = interpret({ status: 429, ok: false, body: '' });
  assert.equal(r.rateLimited, true);
  assert.equal(r.ok, false);
});

test('interpret: 透传响应头限流信息(rl)', () => {
  const r = interpret({ status: 429, ok: false, body: '', rl: { limit: 50, remaining: 0, reset: 1900000000 } });
  assert.equal(r.rateLimited, true);
  assert.equal(r.rateReset, 1900000000);
  assert.equal(r.rateRemaining, 0);
  // 无 rl 头时不设置字段
  const r2 = interpret({ status: 200, ok: true, body: '{}' });
  assert.equal(r2.rateReset, undefined);
  // rl 头字段非数值时忽略
  const r3 = interpret({ status: 200, ok: true, body: '{}', rl: { reset: 'NaN' } });
  assert.equal(r3.rateReset, undefined);
});

test('rateLimitBackoffMs: 有 reset 头时精确等到窗口重置+缓冲', () => {
  const now = 1_000_000_000_000;
  const reset = Math.floor(now / 1000) + 120; // 120秒后重置
  const ms = rateLimitBackoffMs({ rateReset: reset }, now, 15 * 60_000);
  assert.equal(ms, 120 * 1000 + 5000); // reset + 5秒缓冲
});

test('rateLimitBackoffMs: reset 已过不等待, 无头用兜底, 异常大值封顶20分钟', () => {
  const now = 1_000_000_000_000;
  assert.equal(rateLimitBackoffMs({ rateReset: Math.floor(now / 1000) - 10 }, now, 60_000), 0);
  assert.equal(rateLimitBackoffMs({}, now, 60_000), 60_000);
  assert.equal(rateLimitBackoffMs({ rateReset: Math.floor(now / 1000) + 9999 }, now, 60_000), 20 * 60_000);
});

test('windowExhaustedWaitMs: remaining=0 时等到重置, 否则为 0', () => {
  const now = 1_000_000_000_000;
  const reset = Math.floor(now / 1000) + 60;
  assert.equal(windowExhaustedWaitMs({ rateRemaining: 0, rateReset: reset }, now), 60 * 1000 + 5000);
  assert.equal(windowExhaustedWaitMs({ rateRemaining: 3, rateReset: reset }, now), 0);
  assert.equal(windowExhaustedWaitMs({}, now), 0);
});

test('interpret: GraphQL code 88 判定为限流', () => {
  const r = interpret({ status: 200, ok: true, body: '{"errors":[{"code":88,"message":"Rate limit exceeded"}]}' });
  assert.equal(r.rateLimited, true);
});

test('interpret: code 161 判定为达到关注上限', () => {
  const r = interpret({ status: 200, ok: true, body: '{"errors":[{"code":161,"message":"You are unable to follow more people at this time."}]}' });
  assert.equal(r.followLimited, true);
});

test('interpret: 403 提示模板过期', () => {
  const r = interpret({ status: 403, ok: false, body: 'Forbidden' });
  assert.match(r.errorText, /模板已过期/);
});

test('interpret: already followed 视为成功(幂等)', () => {
  const r = interpret({ status: 200, ok: true, body: '{"errors":[{"code":-1,"message":"You already followed this user"}]}' });
  assert.equal(r.ok, true);
});

test('interpret: 其他 5xx 记录原始错误', () => {
  const r = interpret({ status: 503, ok: false, body: 'upstream connect error' });
  assert.equal(r.ok, false);
  assert.match(r.errorText, /503/);
});

// ---------- mergeUsers ----------
function makeTask(queue) { return { queue }; }

test('mergeUsers: 新人追加, 已关注标 skipped', () => {
  const t = makeTask([]);
  const added = mergeUsers(t, [
    { userId: '1', following: false, screenName: 'a', name: 'A' },
    { userId: '2', following: true, screenName: 'b', name: 'B' },
  ]);
  assert.equal(added, 2);
  assert.equal(t.queue[0].status, 'pending');
  assert.equal(t.queue[1].status, 'skipped');
});

test('mergeUsers: 按 userId 去重, 已有状态不受影响', () => {
  const t = makeTask([{ userId: '1', status: 'done', screenName: 'a', name: 'A', error: null }]);
  const added = mergeUsers(t, [{ userId: '1', following: false, screenName: 'a', name: 'A' }]);
  assert.equal(added, 0);
  assert.equal(t.queue.length, 1);
  assert.equal(t.queue[0].status, 'done'); // 状态未被覆盖
});

test('mergeUsers: 幂等——同一批用户合并两次不产生重复', () => {
  const t = makeTask([]);
  const users = [{ userId: '1', following: false, screenName: 'a', name: 'A' }];
  mergeUsers(t, users);
  mergeUsers(t, users);
  assert.equal(t.queue.length, 1);
});

// ---------- findPendingItem(重复关注 bug 的回归测试) ----------
test('findPendingItem: 按 userId 定位 pending 项', () => {
  const queue = [{ userId: '1', status: 'done' }, { userId: '2', status: 'pending' }];
  const item = findPendingItem(queue, '2');
  assert.equal(item.userId, '2');
});

test('findPendingItem: 状态非 pending(已完成/已跳过) → null, 防止重复关注', () => {
  const queue = [{ userId: '2', status: 'done' }];
  assert.equal(findPendingItem(queue, '2'), null);
  assert.equal(findPendingItem(queue, 'missing'), null);
});

// ---------- evaluateStall(持续失败暂停判定) ----------
test('evaluateStall: 窗口外的旧失败被剪掉, 不触发暂停', () => {
  const now = 1_000_000;
  const r = evaluateStall([now - 40 * 60_000], now, 30 * 60_000, 30 * 60_000);
  assert.equal(r.kept.length, 0);
  assert.equal(r.shouldPause, false);
});

test('evaluateStall: 窗口内失败未满 stall 时长 → 不暂停', () => {
  const now = 1_000_000;
  const r = evaluateStall([now - 20 * 60_000, now - 5 * 60_000], now, 30 * 60_000, 30 * 60_000);
  assert.equal(r.shouldPause, false);
});

test('evaluateStall: 窗口内最早失败距今达到 stall 时长 → 暂停', () => {
  const now = 1_000_000;
  const r = evaluateStall([now - 31 * 60_000, now - 2 * 60_000], now, 60 * 60_000, 30 * 60_000);
  assert.equal(r.shouldPause, true);
});

// ---------- buildApiRequest(重放构造) ----------
const formEntry = {
  method: 'POST',
  url: 'https://x.com/i/api/1.1/friendships/create.json',
  search: '',
  body: 'include_entities=1&user_id=5&screen_name=zz&skip_status=1',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': 'old' },
};

test('buildApiRequest: form body 仅替换 user_id 并移除 screen_name 冲突', () => {
  const { url, init } = buildApiRequest(formEntry, { user_id: '999' }, 'newcsrf');
  assert.equal(url, formEntry.url);
  assert.equal(init.method, 'POST');
  assert.match(init.body, /user_id=999/);
  assert.doesNotMatch(init.body, /screen_name=/); // user_id 替换时删除 screen_name
  assert.match(init.body, /include_entities=1/);  // 其余参数保留
  assert.equal(init.headers['x-csrf-token'], 'newcsrf'); // csrf 刷新
  assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
});

test('buildApiRequest: GET 请求替换查询参数', () => {
  const entry = {
    method: 'GET',
    url: 'https://x.com/i/api/1.1/friendships/show.json',
    search: '?cursor=-1&count=20',
    body: null,
    headers: {},
  };
  const { url, init } = buildApiRequest(entry, { cursor: '555', count: '200' }, 'csrf');
  assert.match(url, /cursor=555/);
  assert.match(url, /count=200/);
  assert.equal(init.body, undefined);
});

test('buildApiRequest: JSON body 合并参数', () => {
  const entry = {
    method: 'POST',
    url: 'https://x.com/i/api/x/json',
    search: '',
    body: '{"variables":{"a":1}}',
    headers: { 'content-type': 'application/json' },
  };
  const { init } = buildApiRequest(entry, { user_id: '42' }, null);
  const parsed = JSON.parse(init.body);
  assert.equal(parsed.user_id, '42');
  assert.deepEqual(parsed.variables, { a: 1 });
});

test('buildApiRequest: 无 csrf 时不覆盖请求头', () => {
  const { init } = buildApiRequest(formEntry, { user_id: '1' }, null);
  assert.equal(init.headers['x-csrf-token'], 'old');
});

// ---------- 日常工具 ----------
test('rolloverDaily: 跨天归零', () => {
  const r = rolloverDaily({ date: '2000-01-01', followed: 400 }, new Date('2026-10-09T10:00:00'));
  assert.equal(r.followed, 0);
});

test('rolloverDaily: 同日保留', () => {
  const now = new Date('2026-10-09T10:00:00');
  const today = localDateStr(now);
  const r = rolloverDaily({ date: today, followed: 37 }, now);
  assert.equal(r.followed, 37);
});

test('atName: screenName 缺失时退回 userId(不再出现 @undefined)', () => {
  assert.equal(atName({ screenName: 'abc' }), '@abc');
  assert.equal(atName({ userId: '123' }), '@123');
  assert.equal(atName(undefined), '@undefined');
});
