// tid 收割池单元测试: node --test extension/test/
// 覆盖轮换核心: 入库去重/容量/冷却基准/同路径约束/成败写回(ADR-0004)
const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../src/shared/tidpool.js');
const { add, pick, markResult, CAP } = globalThis.RFTidPool;

const T1 = 'a'.repeat(94);
const T2 = 'b'.repeat(94);
const T3 = 'c'.repeat(94);
const SEARCH = '/i/api/graphql/qId123/SearchTimeline';
const HOME = '/i/api/graphql/qId456/HomeTimeline';
const CD = 70000;

test('add: 形状不合格式不入池', () => {
  assert.equal(add([], 'short', SEARCH, 1000).length, 0);
  assert.equal(add([], null, SEARCH, 1000).length, 0);
});

test('add: 同 tid 同路径去重并刷新时间戳, 最新在前', () => {
  let pool = add([], T1, SEARCH, 1000);
  pool = add(pool, T1, SEARCH, 2000);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].at, 2000);
  // 同 tid 不同路径 = 两条独立条目
  pool = add(pool, T1, HOME, 3000);
  assert.equal(pool.length, 2);
});

test('add: 容量截断, 保留最新', () => {
  let pool = [];
  for (let i = 0; i < CAP + 5; i++) pool = add(pool, String(i).padEnd(94, 'x'), SEARCH, i);
  assert.equal(pool.length, CAP);
  assert.equal(pool[0].at, CAP + 4); // 最新
});

test('pick: 捕获后冷却期内不可用(页面刚用过), 过期可用', () => {
  const pool = add([], T1, SEARCH, 1000);
  assert.equal(pick(pool, { path: SEARCH, now: 1000 + CD - 1, cooldownMs: CD }), null);
  assert.equal(pick(pool, { path: SEARCH, now: 1000 + CD, cooldownMs: CD }).t, T1);
});

test('pick: 只取同路径——池里全是别的路径时返回 null(跨路径未证实, ADR-0004)', () => {
  const pool = add([], T1, HOME, 1000);
  assert.equal(pick(pool, { path: SEARCH, now: 999999, cooldownMs: CD }), null);
  assert.equal(pick(pool, { path: HOME, now: 999999, cooldownMs: CD }).t, T1);
});

test('pick: 多个可用时取最新捕获的', () => {
  let pool = add([], T1, SEARCH, 1000);
  pool = add(pool, T2, SEARCH, 2000);
  pool = add(pool, T3, SEARCH, 3000);
  const e = pick(pool, { path: SEARCH, now: 3000 + CD, cooldownMs: CD });
  assert.equal(e.t, T3);
});

test('markResult + pick: 我们成功后进入冷却; 失败不延长冷却(ADR-0002)', () => {
  let pool = add([], T1, SEARCH, 1000);
  // 成功 → ok 起算冷却
  pool = markResult(pool, T1, SEARCH, true, 100000);
  assert.equal(pick(pool, { path: SEARCH, now: 100000 + CD - 1, cooldownMs: CD }), null);
  assert.equal(pick(pool, { path: SEARCH, now: 100000 + CD, cooldownMs: CD }).t, T1);
  // 失败 → ok 不变, 冷却窗口不变
  pool = markResult(pool, T1, SEARCH, false, 100000 + 10);
  assert.equal(pool[0].fail, 100010);
  assert.equal(pick(pool, { path: SEARCH, now: 100000 + CD, cooldownMs: CD }).t, T1);
});

test('markResult: 不存在的 tid 原样返回', () => {
  const pool = add([], T1, SEARCH, 1000);
  assert.deepEqual(markResult(pool, T2, SEARCH, true, 5), pool);
});
