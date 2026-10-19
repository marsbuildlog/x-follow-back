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
  assert.equal(r.items.find((i) => i.id === 'tpl:SearchTimeline').ok, false);
  assert.equal(r.items.find((i) => i.id === 'follow-tpl').optional, true);
});

test('evaluate: 必备材料齐全则 ready', () => {
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
  assert.equal(r.items.find((i) => i.id === 'identity').ok, true);
});

test('isConsoleHostAlive: 15s 窗口', () => {
  const now = 1_000_000;
  assert.equal(isConsoleHostAlive({ rf_console_host: { at: now - 14_000 } }, now), true);
  assert.equal(isConsoleHostAlive({ rf_console_host: { at: now - 16_000 } }, now), false);
  assert.equal(isConsoleHostAlive({}, now), false);
});
