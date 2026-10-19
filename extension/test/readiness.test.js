// 就绪清单纯逻辑单测(ADR-0010)
const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../src/shared/constants.js');
require('../src/shared/readiness.js');
const { evaluate, isConsoleHostAlive } = globalThis.RFReadiness;

test('evaluate: 无身份/无模板时必备项未齐', () => {
  const r = evaluate({}, null);
  assert.equal(r.ready, false);
  assert.equal(r.items.find((i) => i.id === 'identity').ok, false);
  assert.equal(r.items.find((i) => i.id === 'bearer'), undefined);
  assert.equal(r.items.find((i) => i.id === 'tpl:SearchTimeline').ok, false);
  assert.equal(r.items.find((i) => i.id === 'tpl:UserByScreenName'), undefined);
  assert.equal(r.items.find((i) => i.id === 'tpl:BlueVerifiedFollowers'), undefined);
  assert.equal(r.items.find((i) => i.id === 'tpl:Following'), undefined);
  assert.equal(r.items.find((i) => i.id === 'follow-tpl'), undefined);
  const author = r.items.find((i) => i.id === 'author-visit');
  assert.equal(author.ok, false);
  assert.equal(author.optional, false);
  const lists = r.items.find((i) => i.id === 'follow-lists');
  assert.equal(lists.ok, false);
  assert.equal(lists.optional, undefined);
});

test('evaluate: 仅有 handle 无 bearer 时登录身份未齐', () => {
  const r = evaluate({}, 'me');
  const id = r.items.find((i) => i.id === 'identity');
  assert.equal(id.ok, false);
  assert.match(id.hint, /Bearer/);
  assert.equal(id.action, 'open-x');
});

test('evaluate: 查询齐兑底缺 → ○ 且不挡 ready', () => {
  const snap = {
    rf_bearer: 'Bearer x',
    'rf_tpl:TweetDetail': { p: '/i/api/graphql/q/TweetDetail', q: 'q', v0: {} },
    'rf_tpl:SearchTimeline': { p: '/i/api/graphql/q/SearchTimeline', q: 'q', v0: {} },
    'rf_tpl:BlueVerifiedFollowers': { p: '/i/api/graphql/q/BlueVerifiedFollowers', q: 'q', v0: {} },
    'rf_tpl:Following': { p: '/i/api/graphql/q/Following', q: 'q', v0: {} },
    'rf_tpl:UserByScreenName': { p: '/i/api/graphql/q/UserByScreenName', q: 'q', v0: {} },
  };
  const r = evaluate(snap, 'me');
  assert.equal(r.ready, true);
  const author = r.items.find((i) => i.id === 'author-visit');
  assert.equal(author.ok, false);
  assert.equal(author.optional, true);
  assert.match(author.hint, /查询已旁听/);
});

test('evaluate: 必备材料齐全则 ready', () => {
  const snap = {
    rf_bearer: 'Bearer x',
    rf_follow_tpl_seen: Date.now(),
    'rf_tpl:TweetDetail': { p: '/i/api/graphql/q/TweetDetail', q: 'q', v0: {} },
    'rf_tpl:SearchTimeline': { p: '/i/api/graphql/q/SearchTimeline', q: 'q', v0: {} },
    'rf_tpl:BlueVerifiedFollowers': { p: '/i/api/graphql/q/BlueVerifiedFollowers', q: 'q', v0: {} },
    'rf_tpl:Following': { p: '/i/api/graphql/q/Following', q: 'q', v0: {} },
    'rf_tpl:UserByScreenName': { p: '/i/api/graphql/q/UserByScreenName', q: 'q', v0: {} },
  };
  const r = evaluate(snap, 'me');
  assert.equal(r.ready, true);
  const id = r.items.find((i) => i.id === 'identity');
  assert.equal(id.ok, true);
  assert.match(id.hint, /@me/);
  assert.equal(id.action, null);
  const author = r.items.find((i) => i.id === 'author-visit');
  assert.equal(author.ok, true);
  assert.match(author.hint, /已旁听/);
  const lists = r.items.find((i) => i.id === 'follow-lists');
  assert.equal(lists.ok, true);
});

test('isConsoleHostAlive: 15s 窗口', () => {
  const now = 1_000_000;
  assert.equal(isConsoleHostAlive({ rf_console_host: { at: now - 14_000 } }, now), true);
  assert.equal(isConsoleHostAlive({ rf_console_host: { at: now - 16_000 } }, now), false);
  assert.equal(isConsoleHostAlive({}, now), false);
});

test('evaluate: 搜索模板默认指向 #蓝V互关', () => {
  const r = evaluate({}, 'me');
  const search = r.items.find((i) => i.id === 'tpl:SearchTimeline');
  assert.equal(search.ok, false);
  assert.equal(search.action, 'open-url');
  assert.equal(search.btnLabel, '#蓝V互关');
  assert.match(search.url, /hashtag\/%E8%93%9DV%E4%BA%92%E5%85%B3|hashtag\/蓝V互关/);
});

test('evaluate: 用户查询与兑底合并引导作者主页', () => {
  const r = evaluate({}, 'me');
  const author = r.items.find((i) => i.id === 'author-visit');
  assert.equal(author.ok, false);
  assert.equal(author.optional, false);
  assert.equal(author.action, 'open-url');
  assert.equal(author.url, 'https://x.com/marsbuildlog');
  assert.equal(author.btnLabel, '@marsbuildlog');
  assert.match(author.hint, /取关再关注/);
  assert.equal(author.label, '用户查询与回关兑底');
});

test('evaluate: 认证粉丝与关注列表合并, 位于作者引导下方', () => {
  const r = evaluate({}, 'me');
  const ids = r.items.map((i) => i.id);
  assert.equal(ids.indexOf('identity'), 0);
  assert.equal(ids.indexOf('author-visit'), 1);
  assert.equal(ids.indexOf('follow-lists'), 2);
  const lists = r.items.find((i) => i.id === 'follow-lists');
  assert.equal(lists.ok, false);
  assert.equal(lists.label, '认证粉丝与关注列表');
  assert.equal(lists.buttons.length, 2);
  assert.equal(lists.buttons[0].url, 'https://x.com/me/verified_followers');
  assert.equal(lists.buttons[1].url, 'https://x.com/me/following');
});

test('evaluate: 仅缺关注列表时只留一个按钮', () => {
  const snap = {
    'rf_tpl:BlueVerifiedFollowers': { p: '/i/api/graphql/q/BlueVerifiedFollowers', q: 'q', v0: {} },
  };
  const r = evaluate(snap, 'me');
  const lists = r.items.find((i) => i.id === 'follow-lists');
  assert.equal(lists.ok, false);
  assert.equal(lists.buttons.length, 1);
  assert.equal(lists.buttons[0].label, '关注列表');
  assert.match(lists.hint, /认证粉丝已旁听/);
});
