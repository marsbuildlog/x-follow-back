// MAIN world 注入, document_start 时先于页面脚本执行。
// 职责:
//  1. hook window.fetch / XMLHttpRequest, 捕获 x.com 页面自己发出的请求:
//     - GraphQL (/i/api/graphql/...) → 按 operationName 登记, 用于重放查询
//     - v1.1 REST (/i/api/1.1/..., 如回关的 friendships/create.json) → 按路径登记, 用于重放动作
//     都保留完整请求头(含 x-client-transaction-id / csrf / bearer)与 body
//  2. 响应隔离世界(content script)的消息:
//     - list-captured: 返回捕获摘要(不含请求头)
//     - graphql: 用捕获头模板重放 GraphQL 查询(替换 variables)
//     - api: 用捕获头模板重放 REST 请求(替换指定参数)
// 所有请求都在页面上下文里发出, 自带 cookie + 页面级请求头。
(() => {
  'use strict';
  if (window.__refollowHook) return;
  window.__refollowHook = true;

  const registry = new Map(); // 'g:<OpName>' | 'p:<path>' -> entry
  const history = [];         // GraphQL 捕获流水(调试用)
  const recent = [];          // 所有 /i/api/ 请求流水(调试用, 含状态码)
  const MAX_HISTORY = 50;
  const MAX_RECENT = 80;
  const LS_KEY = '__refollow_api_templates'; // POST 类 REST 请求模板持久化(localStorage, x.com 域内)

  // 启动时恢复上次会话捕获的模板(重放时自动刷新 csrf, 过期则靠 403 提示重新捕获)
  try {
    const raw = localStorage.getItem(LS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    for (const [path, entry] of Object.entries(obj)) {
      if (!registry.has('p:' + path)) registry.set('p:' + path, { ...entry, persisted: true });
    }
  } catch {}

  function persistApiTemplate(path, entry) {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      obj[path] = {
        type: 'api', method: entry.method, path,
        url: entry.url, search: entry.search, body: entry.body,
        headers: entry.headers, capturedAt: entry.capturedAt,
      };
      const keys = Object.keys(obj);
      while (keys.length > 10) delete obj[keys.shift()]; // 最多留 10 个模板
      localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch {}
  }

  function currentCsrf() {
    const m = /(?:^|;\s*)ct0=([^;]+)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function parseHeaders(h) {
    const headers = {};
    if (!h) return headers;
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    } else if (Array.isArray(h)) {
      h.forEach(([k, v]) => (headers[String(k).toLowerCase()] = v));
    } else {
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    }
    return headers;
  }

  function pushRecent(item) {
    recent.push(item);
    if (recent.length > MAX_RECENT) recent.shift();
    return item;
  }

  function record(url, init) {
    try {
      const u = new URL(url, location.origin);
      if (!u.pathname.startsWith('/i/api/')) return null;
      const method = ((init && init.method) || 'GET').toUpperCase();
      const headers = parseHeaders(init && init.headers);
      const ts = Date.now();

      if (u.pathname.startsWith('/i/api/graphql/')) {
        const parts = u.pathname.split('/').filter(Boolean); // ['i','api','graphql',queryId,opName]
        if (parts.length < 5) return null;
        const queryId = parts[3];
        const operationName = parts[4];
        let variables = null;
        if (method === 'POST') {
          try { variables = typeof init.body === 'string' ? JSON.parse(init.body).variables ?? null : null; } catch {}
        } else {
          const p = new URLSearchParams(u.search);
          if (p.get('variables')) { try { variables = JSON.parse(p.get('variables')); } catch {} }
        }
        registry.set('g:' + operationName, {
          type: 'graphql', operationName, queryId, method,
          url: u.origin + u.pathname,
          search: u.search,
          variables, headers, capturedAt: ts,
        });
        history.push({ operationName, queryId, method, ts });
        if (history.length > MAX_HISTORY) history.shift();
        return pushRecent({ ts, method, path: u.pathname, opName: operationName, status: null });
      }

      // v1.1 REST 等 /i/api/ 请求: 按路径登记(保留最近一次), 回关等动作从这里重放
      const apiEntry = {
        type: 'api',
        method,
        path: u.pathname,
        url: u.origin + u.pathname,
        search: u.search,
        body: typeof (init && init.body) === 'string' ? init.body : null,
        headers,
        capturedAt: ts,
      };
      registry.set('p:' + u.pathname, apiEntry);
      if (method === 'POST') persistApiTemplate(u.pathname, apiEntry);
      return pushRecent({ ts, method, path: u.pathname, status: null });
    } catch {}
    return null;
  }

  // ---- hook fetch ----
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      let item = null;
      try {
        const url = typeof input === 'string' ? input : input && input.url;
        if (url) {
          let headers = init && init.headers;
          let method = init && init.method;
          if ((!headers || !method) && typeof Request !== 'undefined' && input instanceof Request) {
            headers = headers || input.headers;
            method = method || input.method;
          }
          item = record(url, { ...init, headers, method });
        }
      } catch {}
      const p = origFetch.apply(this, arguments);
      if (item) {
        p.then((res) => { item.status = res && res.status; }).catch(() => { item.status = 'ERR'; });
      }
      return p;
    };
  }

  // ---- hook XHR ----
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSetHeader = XHR.setRequestHeader;
  const origSend = XHR.send;
  XHR.open = function (method, url) {
    this.__rf = { method, url, headers: {} };
    return origOpen.apply(this, arguments);
  };
  XHR.setRequestHeader = function (k, v) {
    try { if (this.__rf) this.__rf.headers[String(k).toLowerCase()] = v; } catch {}
    return origSetHeader.apply(this, arguments);
  };
  XHR.send = function (body) {
    let item = null;
    try {
      if (this.__rf) {
        item = record(this.__rf.url, {
          method: this.__rf.method,
          headers: this.__rf.headers,
          body: typeof body === 'string' ? body : undefined,
        });
      }
    } catch {}
    if (item) this.addEventListener('loadend', () => { item.status = this.status; });
    return origSend.apply(this, arguments);
  };

  // ---- 消息响应 ----
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== 'refollow-ui') return;
    const reply = (data) =>
      window.postMessage({ source: 'refollow-page', type: 'result', id: msg.id, data }, '*');

    if (msg.type === 'list-captured') {
      // 对外暴露时剥掉 headers(含 bearer/csrf), 隔离世界不需要它们
      const gOps = [], apiEndpoints = [];
      for (const e of registry.values()) {
        if (e.type === 'graphql') {
          gOps.push({
            operationName: e.operationName, queryId: e.queryId, method: e.method,
            url: e.url, variables: e.variables, capturedAt: e.capturedAt,
          });
        } else {
          apiEndpoints.push({
            path: e.path, method: e.method, hasBody: !!e.body,
            capturedAt: e.capturedAt, persisted: !!e.persisted,
          });
        }
      }
      reply({ hookVersion: 3, operations: gOps, apiEndpoints, history, recent });
      return;
    }

    if (msg.type === 'graphql') {
      const { operationName, variables } = msg.payload || {};
      const entry = registry.get('g:' + operationName);
      if (!entry) {
        reply({ status: -2, ok: false, body: 'no captured request for ' + operationName });
        return;
      }
      try {
        let url = entry.url;
        const init = { method: entry.method, credentials: 'include', headers: { ...entry.headers } };
        // csrf 以当前会话 cookie 为准(持久化模板里的可能是旧会话的)
        const csrf = currentCsrf();
        if (csrf) init.headers['x-csrf-token'] = csrf;
        if (entry.method === 'GET') {
          const p = new URLSearchParams(entry.search);
          p.set('variables', JSON.stringify(variables || {}));
          url += '?' + p.toString();
        } else {
          init.headers['content-type'] = 'application/json';
          init.body = JSON.stringify({ variables: variables || {}, queryId: entry.queryId });
        }
        const res = await origFetch.call(window, url, init);
        const body = await res.text();
        reply({ status: res.status, ok: res.ok, body });
      } catch (e) {
        reply({ status: -1, ok: false, body: String(e) });
      }
      return;
    }

    if (msg.type === 'api') {
      const { path, params } = msg.payload || {};
      const entry = registry.get('p:' + path);
      if (!entry) {
        reply({ status: -2, ok: false, body: 'no captured request for ' + path });
        return;
      }
      try {
        // 请求构造逻辑在 shared/logic.js(有单元测试覆盖)
        const { url, init } = globalThis.RefollowLogic.buildApiRequest(entry, params, currentCsrf());
        const res = await origFetch.call(window, url, init);
        const body = await res.text();
        reply({ status: res.status, ok: res.ok, body });
      } catch (e) {
        reply({ status: -1, ok: false, body: String(e) });
      }
    }
  });
})();
