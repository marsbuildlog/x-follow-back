// Route 1 直连纯逻辑单元测试: 头筛选/请求构造/对照头集(ADR-0004)
// node --test extension/test/
const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../src/shared/route1.js');
const { pickDirectHeaders, buildRequest, headerSets } = globalThis.RFRoute1;

// 基于 2026-10 实测形状构造的 GET 形态 SearchTimeline 模板(s 含首见 variables/features/fieldToggles)
const TPL_GET = {
  p: '/i/api/graphql/qid123/SearchTimeline',
  q: 'qid123',
  m: 'GET',
  f: { rweb_tipjar_consumption_enabled: true },
  s: '?variables=%7B%22rawQuery%22%3A%22%23tag%22%2C%22count%22%3A20%7D'
    + '&features=%7B%22rweb_tipjar_consumption_enabled%22%3Atrue%7D'
    + '&fieldToggles=%7B%22withArticleRichContentState%22%3Afalse%7D',
};

test('buildRequest GET: 只换 variables, 保留 features/fieldToggles', () => {
  const r = buildRequest(TPL_GET, { rawQuery: '#other', count: 20 });
  assert.equal(r.method, 'GET');
  assert.equal(r.body, null);
  assert.equal(r.isPost, false);
  assert.ok(r.url.startsWith('https://x.com/i/api/graphql/qid123/SearchTimeline?'));
  const sp = new URLSearchParams(r.url.split('?')[1]);
  assert.equal(sp.get('variables'), JSON.stringify({ rawQuery: '#other', count: 20 }));
  assert.equal(JSON.parse(sp.get('features')).rweb_tipjar_consumption_enabled, true);
  assert.equal(JSON.parse(sp.get('fieldToggles')).withArticleRichContentState, false);
});

test('buildRequest GET: 无 s 也能构造(仅 variables 参数)', () => {
  const r = buildRequest({ p: '/i/api/graphql/q/O', q: 'q', m: 'GET' }, { a: 1 });
  const sp = new URLSearchParams(r.url.split('?')[1]);
  assert.equal(sp.get('variables'), JSON.stringify({ a: 1 }));
});

test('buildRequest POST: body 带 variables+queryId+features(page-hook 同款)', () => {
  const r = buildRequest({ p: '/i/api/graphql/q/O', q: 'q', m: 'POST', f: { f1: true } }, { a: 1 });
  assert.equal(r.isPost, true);
  assert.deepEqual(JSON.parse(r.body), { variables: { a: 1 }, queryId: 'q', features: { f1: true } });
});

test('buildRequest POST: 模板无 features 时不带该键(不带比带 null 安全)', () => {
  const r = buildRequest({ p: '/i/api/graphql/q/O', q: 'q', m: 'POST' }, {});
  assert.deepEqual(JSON.parse(r.body), { variables: {}, queryId: 'q' });
});

test('buildRequest: 模板缺路径直接抛错(调用方捕获后上报)', () => {
  assert.throws(() => buildRequest(null, {}));
  assert.throws(() => buildRequest({}, {}));
});

test('pickDirectHeaders: 留 x-*/content-type, 剔动态/凭证/浏览器自理头, 键统一小写', () => {
  const h = pickDirectHeaders({
    'X-Client-Transaction-Id': 't'.repeat(94),
    'X-Csrf-Token': 'csrf',
    'X-Client-Request-Id': 'reqid',
    Authorization: 'Bearer AAAA',
    Cookie: 'auth_token=x',
    'X-Twitter-Auth-Type': 'OAuth2Session',
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Client-Language': 'zh-CN',
    accept: '*/*',
    'User-Agent': 'Mozilla/5.0',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(h, {
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'zh-CN',
    'content-type': 'application/json',
  });
});

test('headerSets: full=页面原头+三件套, minimal=仅三件套', () => {
  const { full, minimal } = headerSets({ 'x-twitter-auth-type': 'OAuth2Session' }, 'Bearer B', 'CSRF', 'TID', false);
  assert.deepEqual(full, {
    'x-twitter-auth-type': 'OAuth2Session',
    authorization: 'Bearer B',
    'x-csrf-token': 'CSRF',
    'x-client-transaction-id': 'TID',
  });
  assert.deepEqual(minimal, {
    authorization: 'Bearer B',
    'x-csrf-token': 'CSRF',
    'x-client-transaction-id': 'TID',
  });
});

test('headerSets: POST 两种头集都补 content-type', () => {
  const { full, minimal } = headerSets({}, 'B', 'C', 'T', true);
  assert.equal(full['content-type'], 'application/json');
  assert.equal(minimal['content-type'], 'application/json');
});

test('headerSets: GET 不混入 content-type(避免 GET 带 body 头)', () => {
  const { full } = headerSets({ 'content-type': 'application/json' }, 'B', 'C', 'T', false);
  assert.equal(full['content-type'], undefined);
});
