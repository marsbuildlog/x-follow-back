// 池子自动供血单元测试: 触发判定/收割 URL 构造(ADR-0004 遗留B)
// node --test extension/test/
const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../src/shared/harvest.js');
const { shouldRun, searchUrl, MIN_GAP_MS } = globalThis.RFHarvest;

test('shouldRun: 没在跑且距上次够久 → true', () => {
  assert.equal(shouldRun({ running: false, lastAt: 1000 }, 1000 + MIN_GAP_MS), true);
  assert.equal(shouldRun({ running: false, lastAt: 1000 }, 1000 + MIN_GAP_MS - 1), false);
});

test('shouldRun: 正在跑 → 永远 false', () => {
  assert.equal(shouldRun({ running: true, lastAt: 0 }, 1e12), false);
});

test('shouldRun: 从没跑过(lastAt 缺省) → true', () => {
  assert.equal(shouldRun({ running: false }, 5000), true);
  assert.equal(shouldRun(null, 5000), false); // null 按"未知状态"不跑, 调用方兜底
});

test('searchUrl: 取第一个标签, 去#归一化并编码', () => {
  assert.equal(searchUrl(['蓝V互关', '其他']), 'https://x.com/search?q=' + encodeURIComponent('#蓝V互关') + '&f=live');
  assert.equal(searchUrl(['#蓝色V互关']), 'https://x.com/search?q=' + encodeURIComponent('#蓝色V互关') + '&f=live');
});

test('searchUrl: 无标签/空标签退化成通用词 x', () => {
  assert.equal(searchUrl([]), 'https://x.com/search?q=%23x&f=live');
  assert.equal(searchUrl(['  ', '#']), 'https://x.com/search?q=%23x&f=live');
  assert.equal(searchUrl(null), 'https://x.com/search?q=%23x&f=live');
});
