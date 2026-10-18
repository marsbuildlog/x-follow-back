// 单元测试: node --test extension/test/
// 覆盖出过 bug 的核心纯逻辑: 响应解析 / 错误解释 / 队列合并 / 停顿判定 / 请求重放构造
const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../src/shared/logic.js');
const {
  localDateStr, rolloverDaily, atName, parseFollowers, parseFollowList, interpret,
  mergeUsers, findPendingItem, evaluateStall, buildApiRequest,
  rateLimitBackoffMs, windowExhaustedWaitMs,
  parseSearchTimeline, passesRatio, afEligible, pickNextItem,
  mergeAfCandidates, upsertPosts, duePost, duePostAcrossTags, markScanned,
  nextAutoSearchTag, shouldAutoSearch, isFollowLimitFailure,
} = globalThis.XFollowBackLogic;

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

// ---------- parseFollowList(未回关名单) ----------
function listUserResult(overrides = {}) {
  return {
    __typename: 'User',
    rest_id: overrides.rest_id || '2001',
    core: { name: overrides.name || 'User B', screen_name: overrides.screen_name || 'userb' },
    legacy: Object.assign({
      description: 'bio here', followers_count: 1234, friends_count: 567,
      following: false, followed_by: false,
    }, overrides.legacy || {}),
    relationship_perspectives: Object.assign({ followed_by: false, following: false }, overrides.rel || {}),
  };
}

test('parseFollowList: 提取 bio/粉丝数/关注数与关注关系', () => {
  const out = parseFollowList(wrap([
    userEntry(listUserResult(), 'user-0'),
    userEntry(listUserResult({ rest_id: '2002', screen_name: 'userc', rel: { followed_by: true } }), 'user-1'),
  ]));
  assert.equal(out.error, null);
  assert.equal(out.users.length, 2);
  const a = out.users[0];
  assert.equal(a.userId, '2001');
  assert.equal(a.screenName, 'userb');
  assert.equal(a.name, 'User B');
  assert.equal(a.description, 'bio here');
  assert.equal(a.followersCount, 1234);
  assert.equal(a.friendsCount, 567);
  assert.equal(a.followedBy, false); // 我关注了他但他没关注我 → 入未回关名单
  assert.equal(out.users[1].followedBy, true);
});

test('parseFollowList: 解析 cursor-bottom 游标', () => {
  const entries = [userEntry(listUserResult()), { entryId: 'cursor-bottom-0', content: { value: 'CUR' } }];
  const out = parseFollowList(wrap(entries));
  assert.equal(out.error, null);
  assert.equal(out.cursor, 'CUR');
});

test('parseFollowList: 缺 legacy 时计数回退为 0 不炸', () => {
  const r = listUserResult();
  delete r.legacy;
  const out = parseFollowList(wrap([userEntry(r)]));
  assert.equal(out.error, null);
  assert.equal(out.users[0].description, '');
  assert.equal(out.users[0].followersCount, 0);
  assert.equal(out.users[0].friendsCount, 0);
});

test('parseFollowList: errors 响应返回 error', () => {
  const out = parseFollowList(JSON.stringify({ errors: [{ code: 88, message: 'Rate limit exceeded' }] }));
  assert.match(out.error, /Rate limit/);
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

test('interpret: 403 包裹的 code 161 判定为今日上限(实测样本)', () => {
  const body = JSON.stringify({ errors: [{ code: 161, message: 'You are unable to follow more people at this time. Learn more <a href=...>' }] });
  const r = interpret({ status: 403, ok: false, body });
  assert.equal(r.followLimited, true);
  assert.equal(r.rateLimited, false);
  assert.match(r.errorText, /已超过上限/);
});

test('interpret: 403 无已知错误码 → 提示模板过期', () => {
  const r = interpret({ status: 403, ok: false, body: 'Forbidden' });
  assert.equal(r.followLimited, false);
  assert.match(r.errorText, /模板已过期/);
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

// ---------- 主动关注: parseSearchTimeline ----------
// 构造 SearchTimeline 风格响应(推文条目 + 会话模块 + 游标)
function tweetResult(overrides = {}) {
  return {
    __typename: 'Tweet',
    rest_id: overrides.postId || '9001',
    legacy: Object.assign(
      { id_str: overrides.postId || '9001', full_text: '互关贴' },
      overrides.tweetLegacy || {}
    ),
    core: { user_results: { result: {
      __typename: 'User',
      rest_id: overrides.userId || '1001',
      is_blue_verified: overrides.blue !== false,
      core: { name: overrides.name || 'User A', screen_name: overrides.screenName || 'usera' },
      legacy: Object.assign(
        { screen_name: overrides.screenName || 'usera', name: overrides.name || 'User A',
          followers_count: 100, friends_count: 500, protected: false },
        overrides.userLegacy || {}
      ),
      relationship_perspectives: Object.assign({ following: false, followed_by: false }, overrides.rel || {}),
    } } },
  };
}
function searchWrap(entries, cursorVal = null) {
  const all = cursorVal ? entries.concat([{ entryId: 'cursor-bottom-2', content: { value: cursorVal, entryType: 'TimelineTimelineCursor' } }]) : entries;
  return JSON.stringify({
    data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ entries: all }] } } } },
  });
}

test('parseSearchTimeline: 解析推文条目/用户/游标', () => {
  const body = searchWrap([
    { entryId: 'tweet-9001', content: { itemContent: { tweet_results: { result: tweetResult() } } } },
    { entryId: 'profile-conversation-9002', content: { entryType: 'TimelineTimelineModule', items: [
      { entryId: 'tweet-9003', item: { itemContent: { tweet_results: { result: tweetResult({ postId: '9003', userId: '1002', screenName: 'userb' }) } } } },
    ] } },
  ], 'CUR');
  const out = parseSearchTimeline(body);
  assert.equal(out.error, null);
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].postId, '9001');
  assert.equal(out.items[0].user.screenName, 'usera');
  assert.equal(out.items[0].user.followers, 100);
  assert.equal(out.items[1].user.screenName, 'userb');
  assert.equal(out.cursor, 'CUR');
});

test('parseSearchTimeline: 转推标记/墓碑/无游标', () => {
  const body = searchWrap([
    { entryId: 'tweet-9001', content: { itemContent: { tweet_results: { result: tweetResult({ tweetLegacy: { retweeted_status_result: { result: {} } } }) } } } },
    { entryId: 'tweet-9002', content: { itemContent: { tombstone: {} } } },
  ]);
  const out = parseSearchTimeline(body);
  assert.equal(out.error, null);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].isRetweet, true);
  assert.equal(out.cursor, null);
});

test('parseSearchTimeline: 非法响应报错', () => {
  assert.ok(parseSearchTimeline('not-json').error);
  assert.ok(parseSearchTimeline('{"data":{}}').error);
});

// ---------- 主动关注: 求粉特征与候选人资格 ----------
test('passesRatio: 粉丝/关注 < 1.2 过关; 计数缺失放行; 零关注看人气', () => {
  assert.equal(passesRatio(100, 500, 1.2), true);   // 0.2 → 在求粉
  assert.equal(passesRatio(120, 100, 1.2), false);  // 1.2 不小于 1.2
  assert.equal(passesRatio(100, 50, 1.2), false);   // 2.0 → 不缺粉
  assert.equal(passesRatio(null, null, 1.2), true); // 字段缺失放行
  assert.equal(passesRatio(50000, 0, 1.2), false);  // 大V不关注别人 → 不回关
  assert.equal(passesRatio(0, 0, 1.2), true);
});

test('afEligible: 蓝V/非保护/未关注/比值 四道门槛依次判', () => {
  const base = { userId: '1', blue: true, isProtected: false, following: false, followers: 100, friends: 500 };
  assert.equal(afEligible(base, 1.2).ok, true);
  assert.equal(afEligible({ ...base, blue: false }, 1.2).reason, 'not-blue');
  assert.equal(afEligible({ ...base, isProtected: true }, 1.2).reason, 'protected');
  assert.equal(afEligible({ ...base, following: true }, 1.2).reason, 'already-following');
  assert.equal(afEligible({ ...base, followers: 9999 }, 1.2).reason, 'ratio');
  assert.equal(afEligible(null, 1.2).ok, false);
});

// ---------- 主动关注: 回关优先逐条取数 ----------
test('pickNextItem: 回关队列优先, 空了取主动关注, 都不在 running 返回 null', () => {
  const fb = (state, ids) => ({ state, queue: ids.map((id) => ({ userId: id, status: 'pending' })) });
  const af = (state, ids) => ({ state, queue: ids.map((id) => ({ userId: id, status: 'pending' })) });
  assert.equal(pickNextItem(fb('running', ['1']), af('running', ['2'])).src, 'fb');
  assert.equal(pickNextItem(fb('running', []), af('running', ['2'])).src, 'af');
  assert.equal(pickNextItem(fb('running', ['1']), af('done', ['2'])).src, 'fb');
  // 回关任务 idle(未启动)时, 主动关注 running 也可消费
  assert.equal(pickNextItem(fb('idle', ['1']), af('running', ['2'])).src, 'af');
  // 主动关注 idle 时即便回关队列空也不取
  assert.equal(pickNextItem(fb('running', []), af('idle', ['2'])), null);
  assert.equal(pickNextItem(fb('done', []), af('done', ['2'])), null);
});

// ---------- 主动关注: 队列合并(去重/排除回关队列/容量上限) ----------
test('mergeAfCandidates: 追加带来源, 剔除已有与回关队列, 达上限停', () => {
  const t = { queue: [] };
  const r1 = mergeAfCandidates(t, [
    { userId: '1', screenName: 'a', name: 'A', source: '#tag' },
    { userId: '2', screenName: 'b', name: 'B', source: '#tag' },
  ], new Set(['2']), 100);
  assert.equal(r1.added, 1);
  assert.equal(t.queue[0].source, '#tag');
  assert.equal(t.queue[0].status, 'pending');
  const r2 = mergeAfCandidates(t, [{ userId: '1', screenName: 'a', name: 'A' }], new Set(), 100);
  assert.equal(r2.added, 0); // 幂等
  const r3 = mergeAfCandidates(t, [{ userId: '3' }, { userId: '4' }], new Set(), 2);
  assert.deepEqual([r3.added, r3.capped], [1, true]);
  assert.equal(t.queue.length, 2);
});

// ---------- 主动关注: 互关帖池调度 ----------
test('upsertPosts/duePost/markScanned: 去重、到期调度、三次封顶', () => {
  const pool = [];
  const now = 1_000_000_000_000;
  // 同档无评论数时退化为雪花新→旧
  assert.equal(upsertPosts(pool, ['100', '200', '100'], now).added, 2);
  assert.equal(upsertPosts(pool, ['100'], now).added, 0);
  const p = duePost(pool, now, 3);
  assert.equal(p.postId, '200');
  // 首扫完成 → 隔两天再到期; 剩未首扫的 100
  markScanned(p, now, 2 * 86400_000);
  assert.equal(p.scanCount, 1);
  assert.equal(duePost(pool, now, 3).postId, '100');
  assert.equal(duePost(pool, now + 86400_000, 3).postId, '100');
  // 扫掉 100 后, 两天时刻 200 重扫到期
  markScanned(duePost(pool, now + 86400_000, 3), now + 86400_000, 2 * 86400_000);
  assert.equal(duePost(pool, now + 2 * 86400_000, 3).postId, '200');
  // 扫满三次后不再到期
  markScanned(p, now + 2 * 86400_000, 2 * 86400_000);
  markScanned(p, now + 4 * 86400_000, 2 * 86400_000);
  assert.equal(p.scanCount, 3);
  const q2 = duePost(pool, now + 3 * 86400_000, 3);
  markScanned(q2, now + 3 * 86400_000, 2 * 86400_000);
  markScanned(q2, now + 5 * 86400_000, 2 * 86400_000);
  markScanned(q2, now + 7 * 86400_000, 2 * 86400_000);
  assert.equal(duePost(pool, now + 100 * 86400_000, 3), null);
});

test('duePostAcrossTags: 跨标签取最优到期帖(未首扫优先, 同档评论数/雪花)', () => {
  const now = 1_000_000_000_000;
  const tags = { '蓝V互关': { posts: [] }, '其他': { posts: [] } };
  upsertPosts(tags['蓝V互关'].posts, ['100', '200'], now);
  upsertPosts(tags['其他'].posts, ['150'], now + 60_000); // 晚入池, 雪花介于两者之间
  const hit = duePostAcrossTags(tags, now + 60_000, 3);
  assert.equal(hit.tag, '蓝V互关');
  assert.equal(hit.post.postId, '200'); // 同评论数(均缺省)→最新雪花
  // 蓝V互关 全部扫完(隔两天再到期) → 落到其他标签未首扫帖
  for (const p of tags['蓝V互关'].posts) markScanned(p, now + 60_000, 2 * 86400_000);
  assert.equal(duePostAcrossTags(tags, now + 60_000, 3).tag, '其他');
  assert.equal(duePostAcrossTags(tags, now + 60_000, 3).post.postId, '150');
  // 全部不到期 → null
  markScanned(tags['其他'].posts[0], now + 60_000, 2 * 86400_000);
  assert.equal(duePostAcrossTags(tags, now + 60_000, 3), null);
});

test('duePost/upsertPosts: 未首扫优先; 同档评论数大先扫; 帖池存评论数', () => {
  const now = 1_000_000_000_000;
  const pool = [];
  upsertPosts(pool, ['100'], now);                                    // 旧格式(无评论数)
  upsertPosts(pool, [{ postId: '100', replyCount: 90 }], now + 1);   // 重见时回填
  assert.equal(pool.find((p) => p.postId === '100').replyCount, 90);
  // 老帖已首扫过但仍到期 + 新帖: 未首扫档优先(不被老帖 90 评论霸占)
  markScanned(pool[0], now, 0); // scanCount=1, nextScanAt=now → 立刻到期
  upsertPosts(pool, [{ postId: '300', replyCount: 2 }, { postId: '200', replyCount: 50 }], now);
  assert.equal(duePost(pool, now + 2, 3).postId, '200'); // 未首扫里评论数 50 > 2
  markScanned(pool.find((p) => p.postId === '200'), now, 2 * 86400_000);
  assert.equal(duePost(pool, now + 2, 3).postId, '300'); // 剩未首扫 300
  markScanned(pool.find((p) => p.postId === '300'), now, 2 * 86400_000);
  // 未首扫清空 → 落到已扫老帖 100
  assert.equal(duePost(pool, now + 2, 3).postId, '100');
  // 两天后三帖都重扫到期: 同档按评论数 90 > 50 > 2 → 100
  assert.equal(duePost(pool, now + 2 * 86400_000, 3).postId, '100');
});

// ---------- interpret: 160 已关注 → skipped 语义 ----------
test('interpret: 403 code 160 识别为 alreadyFollowing(非故障)', () => {
  const r = interpret({ status: 403, body: JSON.stringify({ errors: [{ code: 160, message: 'You are not authorized to follow this user.' }] }) });
  assert.equal(r.ok, false);
  assert.equal(r.alreadyFollowing, true);
  assert.equal(r.followLimited, false);
});

// ---------- 主动关注: 新版 SearchTimeline schema(实测 2026-10, 用户对象无 legacy) ----------
function newSchemaUser(overrides = {}) {
  return {
    __typename: 'User',
    rest_id: overrides.userId || '1915998627878797312',
    is_blue_verified: overrides.blue !== false,
    core: { name: overrides.name || 'User A', screen_name: overrides.screenName || 'usera' },
    privacy: { protected: !!overrides.protected },
    relationship_counts: { followers: overrides.followers ?? 217, following: overrides.following ?? 189 },
    relationship_perspectives: Object.assign({ following: false, followed_by: false }, overrides.rel || {}),
  };
}
function newTweetEntry(result, entryId = 'tweet-9001') {
  const tid = entryId.replace('tweet-', '');
  return { entryId, content: { entryType: 'TimelineTimelineItem', itemContent: { tweet_results: { result: {
    __typename: 'Tweet', rest_id: tid, legacy: { id_str: tid },
    core: { user_results: { result } },
  } } } } };
}
test('parseSearchTimeline: 新版 schema——计数取 relationship_counts, 保护取 privacy, cursor 取 TimelineReplaceEntry', () => {
  const body = JSON.stringify({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries: [
      newTweetEntry(newSchemaUser()),
      newTweetEntry(newSchemaUser({ userId: '2', screenName: 'userb', blue: false, protected: true, followers: 9999, following: 5 }), 'tweet-9002'),
    ] },
    { type: 'TimelineReplaceEntry', entry_id_to_replace: 'cursor-bottom-0',
      entry: { entryId: 'cursor-bottom-0', content: { entryType: 'TimelineTimelineCursor', value: 'CURSOR_X' } } },
  ] } } } } });
  const out = parseSearchTimeline(body);
  assert.equal(out.error, null);
  assert.equal(out.items.length, 2);
  const u = out.items[0].user;
  assert.equal(u.screenName, 'usera');
  assert.equal(u.followers, 217);   // 新 schema 计数字段名不同, 必须取得到(求粉特征依赖它)
  assert.equal(u.friends, 189);
  assert.equal(u.isProtected, false);
  assert.equal(out.cursor, 'CURSOR_X');
  assert.equal(afEligible(u, 1.2).ok, true);
  const ub = out.items[1].user;
  assert.equal(ub.blue, false);
  assert.equal(afEligible(ub, 1.2).reason, 'not-blue');
});

// ---------- 池子断供自动补池(ADR-0006) ----------
const NOW = 1_800_000_000_000;
const OPTS = { pendingTarget: 20, scanMax: 3, poolMin: 10, cooldownMs: 60 * 60 * 1000 };
// 构造 n 个存活帖(scanCount=0), 默认都在两天重扫冷却里(nextScanAt 在未来)
const alivePosts = (n, overrides = {}) =>
  Array.from({ length: n }, (_, i) => ({ postId: 'p' + i, scanCount: 0, nextScanAt: NOW + 2 * 864e5, ...overrides }));
function afFixture(overrides = {}) {
  return Object.assign({
    state: 'running',
    queue: [{ status: 'pending' }],   // 待关注 1 < 50
    tags: { 蓝V互关: { posts: [{ postId: 'p1', scanCount: 3, nextScanAt: NOW - 1 }] } }, // 全部扫完→池子枯竭
    lastAutoSearchAt: 0,
  }, overrides);
}

test('shouldAutoSearch: 列表见底+池子枯竭+冷却已过 → 触发', () => {
  assert.equal(shouldAutoSearch(afFixture(), NOW, OPTS), true);
});

test('shouldAutoSearch: 存活帖不足 POOL_MIN → 触发(即使都还在两天重扫冷却里)', () => {
  const af = afFixture({ tags: { 蓝V互关: { posts: alivePosts(9) } } });
  assert.equal(shouldAutoSearch(af, NOW, OPTS), true);
});

test('shouldAutoSearch: 存活帖达 POOL_MIN 但无到期帖 → 触发(今天没得扫, 抓新帖——原始场景)', () => {
  const af = afFixture({ tags: { 蓝V互关: { posts: alivePosts(10) } } });
  assert.equal(shouldAutoSearch(af, NOW, OPTS), true);
});

test('shouldAutoSearch: 存活充足+还有到期帖 → 不触发(扫描还没供完血); 存活不足则优先抓', () => {
  const enough = afFixture({ tags: { 蓝V互关: { posts: alivePosts(12, { nextScanAt: NOW - 1 }) } } });
  assert.equal(shouldAutoSearch(enough, NOW, OPTS), false);
  const scarce = afFixture({ tags: { 蓝V互关: { posts: alivePosts(9, { nextScanAt: NOW - 1 }) } } });
  assert.equal(shouldAutoSearch(scarce, NOW, OPTS), true);
});

test('shouldAutoSearch: 死帖(scanCount≥SCAN_MAX)不计入存活', () => {
  const af = afFixture({ tags: { 蓝V互关: { posts: [...alivePosts(0), { postId: 'd1', scanCount: 3, nextScanAt: NOW - 1 }, { postId: 'd2', scanCount: 5, nextScanAt: NOW - 1 }] } } });
  assert.equal(shouldAutoSearch(af, NOW, OPTS), true);
});

test('shouldAutoSearch: 待关注已达水位 → 不触发(需求侧不缺人)', () => {
  const af = afFixture({ queue: Array.from({ length: 20 }, () => ({ status: 'pending' })) });
  assert.equal(shouldAutoSearch(af, NOW, OPTS), false);
});

test('shouldAutoSearch: 冷却未过 → 不触发(防搜索只回旧帖时每 tick 空烧桶)', () => {
  const af = afFixture({ lastAutoSearchAt: NOW - 60_000 });
  assert.equal(shouldAutoSearch(af, NOW, OPTS), false);
  const af2 = afFixture({ lastAutoSearchAt: NOW - OPTS.cooldownMs });
  assert.equal(shouldAutoSearch(af2, NOW, OPTS), true);
});

test('shouldAutoSearch: done(队列见底)也算可运行——这是断供的主场景', () => {
  const af = afFixture({ state: 'done', queue: [] });
  assert.equal(shouldAutoSearch(af, NOW, OPTS), true);
  const paused = afFixture({ state: 'paused' });
  assert.equal(shouldAutoSearch(paused, NOW, OPTS), false);
  const idle = afFixture({ state: 'idle' });
  assert.equal(shouldAutoSearch(idle, NOW, OPTS), false);
});

test('nextAutoSearchTag: 环形轮换 + 去#/空白(与 settings 存储形式一致) + 失效回第一个', () => {
  const tags = ['#蓝V互关', 'FollowBack', ' 互推 '];
  assert.equal(nextAutoSearchTag(tags, null), '蓝V互关');          // 首次取第一个(去#)
  assert.equal(nextAutoSearchTag(tags, '#蓝V互关'), 'FollowBack');  // 依次轮换
  assert.equal(nextAutoSearchTag(tags, 'followback'), '互推');      // 大小写不敏感匹配 + 去空白
  assert.equal(nextAutoSearchTag(tags, '不存在的'), '蓝V互关');     // 失效回第一个
  assert.equal(nextAutoSearchTag([], null), null);                 // 未配置不抓
});

// ---------- 手动关注失败捕获(ADR-0007) ----------
test('isFollowLimitFailure: 403 包 161(单日上限) → 是额度类失败', () => {
  const body = JSON.stringify({ errors: [{ code: 161, message: 'You are unable to follow more people at this time.' }] });
  assert.equal(isFollowLimitFailure(403, body), true);
});

test('isFollowLimitFailure: 403 包 160(已关注)/保护账号等 → 不是额度类, 不收', () => {
  const already = JSON.stringify({ errors: [{ code: 160, message: 'You already follow this user.' }] });
  assert.equal(isFollowLimitFailure(403, already), false);
  const protectedAcc = JSON.stringify({ errors: [{ code: 108, message: 'You cannot follow a protected account.' }] });
  assert.equal(isFollowLimitFailure(403, protectedAcc), false);
});

test('isFollowLimitFailure: 429 直接算; 文本兕底(非 JSON 错误页带限流字样)也算', () => {
  assert.equal(isFollowLimitFailure(429, ''), true);
  assert.equal(isFollowLimitFailure(403, 'unable to follow more people'), true);
  // GraphQL 关注常 200 包 errors[{code:161}]——按错误码收, 不绑 403
  assert.equal(isFollowLimitFailure(200, JSON.stringify({ errors: [{ code: 161 }] })), true);
  assert.equal(isFollowLimitFailure(404, JSON.stringify({ errors: [{ code: 161 }] })), true);
  assert.equal(isFollowLimitFailure(200, ''), false);
  assert.equal(isFollowLimitFailure(404, JSON.stringify({ errors: [{ code: 160 }] })), false);
});
