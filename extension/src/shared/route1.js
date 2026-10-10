// Route 1 直连传输(ADR-0004): background SW 用收割材料(rf_tpl 模板 + rf_tid_pool + rf_bearer + ct0 cookie)
// 直接请求 x.com API, 不经过页面内 page-hook —— 循环不再依赖"页面开着且模板在内存里"。
// 本文件只放纯逻辑(头筛选/请求构造/对照头集), IO(chrome.storage/cookies/fetch)在 background 装配, 便于单测。
(function () {
  const ORIGIN = 'https://x.com';

  // 直连不透传的头(动态值, 由运行期注入): tid 来自收割池, csrf 来自 cookie, bearer 单独存, cookie 自动带。
  // x-client-request-id 逐请求变化且 page-hook 实测可原样重放(服务端不校验), 剔除以免模板头集永不稳定。
  const SKIP_HEADERS = new Set([
    'x-client-transaction-id', 'x-csrf-token', 'x-client-request-id',
    'authorization', 'cookie',
  ]);

  // 从 webRequest 捕获的请求头里挑出直连要透传的: x-* + content-type。
  // 其余(accept/user-agent/sec-* 等)由浏览器自理; 键统一小写。
  function pickDirectHeaders(headers) {
    const out = {};
    for (const k of Object.keys(headers || {})) {
      const name = k.toLowerCase();
      if (SKIP_HEADERS.has(name)) continue;
      if (name.startsWith('x-') || name === 'content-type') out[name] = headers[k];
    }
    return out;
  }

  // 从 rf_tpl 条目构造一次直连请求。
  //   GET: 保留捕获 search 里的 features/fieldToggles 等, 只换 variables(page-hook 同款做法)
  //   POST: body = {variables, queryId, features?}(POST 形态缺 features 会 404/400, 见 82fc54a)
  // 返回 {url, method, body, isPost}; headers 由调用方拼(含运行期 bearer/csrf/tid)。
  function buildRequest(tpl, variables) {
    if (!tpl || !tpl.p) throw new Error('模板缺失(无路径)——先在 x.com 触发一次该查询');
    const method = (tpl.m || 'GET').toUpperCase();
    const url = ORIGIN + tpl.p;
    if (method === 'GET') {
      const sp = new URLSearchParams(tpl.s || '');
      sp.set('variables', JSON.stringify(variables || {}));
      return { url: url + '?' + sp.toString(), method, body: null, isPost: false };
    }
    const bodyObj = { variables: variables || {}, queryId: tpl.q };
    if (tpl.f) bodyObj.features = tpl.f;
    return { url, method, body: JSON.stringify(bodyObj), isPost: true };
  }

  // 对照实验头集: full = 页面原头(筛后) + 三件套; minimal = 仅三件套。
  // 三件套 = authorization + x-csrf-token + x-client-transaction-id(实测缺失 tid → 404)。
  // POST 两种头集都补 content-type: application/json。
  function headerSets(h, bearer, csrf, tid, isPost) {
    const triple = { authorization: bearer, 'x-csrf-token': csrf, 'x-client-transaction-id': tid };
    if (isPost) triple['content-type'] = 'application/json';
    const full = Object.assign({}, h || {}, triple);
    if (!isPost) delete full['content-type']; // GET 不带 body 头(捕获残留则剥掉)
    return { full, minimal: triple };
  }

  globalThis.RFRoute1 = { ORIGIN, SKIP_HEADERS, pickDirectHeaders, buildRequest, headerSets };
})();
