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
//     - take-failed-follows: 取走手动关注撞额度失败(ADR-0007)
// 所有请求都在页面上下文里发出, 自带 cookie + 页面级请求头。
(() => {
  'use strict';
  // 版本化热升级: 扩展 reload 后 options 会 scripting 补注入本文件。
  // 旧逻辑用 `if (__xfollowbackHook) return` 会永远留在无 take-failed-follows 的旧 hook 上,
  // 手动关注兑底表现为"失败了也不入队"。版本不一致时拆回原生 API 再装新版。
  const HOOK_VERSION = 5;
  if (window.__xfollowbackHookVersion === HOOK_VERSION) return;
  if (window.__xfollowbackOrigFetch) window.fetch = window.__xfollowbackOrigFetch;
  if (window.__xfollowbackOrigXHR) {
    const o = window.__xfollowbackOrigXHR;
    XMLHttpRequest.prototype.open = o.open;
    XMLHttpRequest.prototype.setRequestHeader = o.setRequestHeader;
    XMLHttpRequest.prototype.send = o.send;
  }
  if (window.__xfollowbackOnMessage) {
    window.removeEventListener('message', window.__xfollowbackOnMessage);
  }
  window.__xfollowbackHook = true;
  window.__xfollowbackHookVersion = HOOK_VERSION;

  const registry = new Map(); // 'g:<OpName>' | 'p:<path>' -> entry
  const history = [];         // GraphQL 捕获流水(调试用)
  const recent = [];          // 所有 /i/api/ 请求流水(调试用, 含状态码)
  const MAX_HISTORY = 50;
  const MAX_RECENT = 80;
  const LS_KEY = '__xfollowback_api_templates'; // POST 类 REST 请求模板持久化(localStorage, x.com 域内)
  const FOLLOW_PATH = '/i/api/1.1/friendships/create.json'; // 关注动作(页面自己的「关注/回关」按钮也走这里)
  let whoamiCache = null; // {at, name}——settings.json 结果, 10分钟正缓存
  let meName = null;      // {at, name}——从页面自己的 Viewer 响应被动喍探到的登录账号(零额外请求)
  let settingsFailAt = 0; // settings.json 失败负缓存: 5分钟内不再打该端点(实测会 429)

  // ---- 手动关注失败捕获(稍后关注兑底, ADR-0007) ----
  // 用户在页面上手动点「关注」但撞额度(161 单日上限/88/429)时, 记下目标 userId,
  // 供 content script 取走收进主动关注队列, 额度恢复后自动补关注。
  const failedFollows = []; // {userId, screenName, at}, 按 userId 去重, 最多 50 条
  const followDiag = [];    // 关注失败观测(诊断): 每个失败响应一条, 随 take 返回供 content 落日志
  // 页面保留路径(不是 handle): pathname 兑底 screen_name 时排除
  const RESERVED_HANDLES_PAGE = new Set(['i', 'home', 'explore', 'notifications', 'messages', 'settings', 'search', 'hashtag']);

  // 请求 body → 字符串(页面可能传 URLSearchParams, 旧逻辑只收 string 会丢 user_id → no-id)
  function coerceBodySync(body) {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    try {
      if (typeof body.toString === 'function') {
        const s = body.toString();
        if (s && !/^\[object /.test(s)) return s;
      }
    } catch {}
    return null;
  }

  // 额度类失败判定: 优先 logic.js; 缺省时内联兜底(options 补注入曾只带 page-hook 不带 logic)
  function limitFail(status, bodyText) {
    try {
      const fn = globalThis.XFollowBackLogic && globalThis.XFollowBackLogic.isFollowLimitFailure;
      if (fn) return !!fn(status, bodyText);
    } catch {}
    if (status === 429) return true;
    const text = bodyText || '';
    let code = null;
    try {
      const errs = (JSON.parse(text) || {}).errors;
      if (Array.isArray(errs) && errs.length) code = errs[0].code;
    } catch {}
    if (code === 161 || code === 88) return true;
    return status === 403 && /unable to follow more|follow limit|rate limit/i.test(text);
  }

  // 从请求里提取目标用户(兼容 form(user_id=..) / JSON / GraphQL variables 三种形态)
  function extractFollowTarget(item) {
    const raw = typeof item.body === 'string' ? item.body : '';
    if (raw) {
      const fmt = /^\s*[{[]/.test(raw) ? 'json' : 'form';
      let userId = null, screenName = null;
      try {
        const p = new URLSearchParams(raw);
        userId = p.get('user_id');
        screenName = p.get('screen_name');
      } catch {}
      if (!userId && !screenName && fmt === 'json') {
        try {
          const o = JSON.parse(raw);
          userId = o?.user_id ?? o?.userId ?? null;
          screenName = o?.screen_name ?? o?.screenName ?? null;
        } catch {}
      }
      return { fmt, userId: userId != null ? String(userId) : null, screenName, reqHead: raw.slice(0, 120) };
    }
    if (item.variables) {
      const v = item.variables || {};
      const userId = v.user_id ?? v.userId ?? null;
      return {
        fmt: 'graphql',
        userId: userId != null ? String(userId) : null,
        screenName: v.screen_name ?? v.screenName ?? null,
        reqHead: '',
      };
    }
    return { fmt: 'empty', userId: null, screenName: null, reqHead: '' };
  }

  // 从 follow 响应里识别额度类失败并登记目标; 无论是否捕获都留诊断(哪里断的一目了然)
  function noteFollowResult(item, status, bodyText) {
    try {
      const isFollowApi = item.path === FOLLOW_PATH || (item.opName && /friendship/i.test(item.opName));
      if (!isFollowApi) return;
      const t = extractFollowTarget(item);
      // screen_name 兑底: create.json 请求体只有 user_id, 从页面上下文反查——
      // 个人主页场景 pathname 即 screenName(页面关注按钮 testid 前缀=userId, 双重确认防误认);
      // 时间线/推荐场景从按钮所在帖卡的第一个单段链接取。失败 toast 不改 DOM, loadend 时按钮还在。
      if (!t.screenName && t.userId) {
        try {
          const sel = `[data-testid="${t.userId}-follow"], [data-testid="${t.userId}-unfollow"]`;
          if (document.querySelector(sel)) {
            const pm = /^\/([A-Za-z0-9_]{1,15})$/.exec(location.pathname);
            if (pm && !RESERVED_HANDLES_PAGE.has(pm[1].toLowerCase())) t.screenName = pm[1];
            else {
              const cell = document.querySelector(sel) && (document.querySelector(sel).closest('article') || document.querySelector(sel).closest('[data-testid="cellInnerDiv"]'));
              const link = cell && cell.querySelector('a[href^="/"]');
              const lm = link && /^\/([A-Za-z0-9_]{1,15})$/.exec(link.getAttribute('href') || '');
              if (lm) t.screenName = lm[1];
            }
          }
        } catch {}
      }
      const limit = limitFail(status, bodyText);
      const note = !t.userId && !t.screenName ? 'no-id' : !limit ? 'not-limit' : 'captured';
      followDiag.push({
        ts: Date.now(), status, fmt: t.fmt, note, userId: t.userId, screenName: t.screenName,
        reqHead: t.reqHead, bodyHead: String(bodyText || '').slice(0, 160),
      });
      if (followDiag.length > 20) followDiag.shift();
      if (note !== 'captured' || !t.userId) return; // 无 userId 无法入队(screen_name 兑底也不收——队列按 userId 去重)
      if (failedFollows.some((f) => f.userId === t.userId)) return; // 同一人重复点不重复记
      failedFollows.push({ userId: t.userId, screenName: t.screenName, at: Date.now() });
      if (failedFollows.length > 50) failedFollows.shift();
    } catch {}
  }

  // Viewer 响应里就是页面自己认定的登录用户
  function sniffViewer(text) {
    try {
      const r = JSON.parse(text)?.data?.viewer?.results;
      const name = r?.core?.screen_name || r?.legacy?.screen_name || r?.screen_name;
      if (name) meName = { at: Date.now(), name };
    } catch {}
  }

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
        let features = null; // POST 形态的 GraphQL, features 在 body 里(重放时必须带回, 缺了会 404/400)
        if (method === 'POST') {
          try {
            const bodyObj = typeof init.body === 'string' ? JSON.parse(init.body) : null;
            variables = bodyObj?.variables ?? null;
            features = bodyObj?.features ?? null;
          } catch {}
        } else {
          const p = new URLSearchParams(u.search);
          if (p.get('variables')) { try { variables = JSON.parse(p.get('variables')); } catch {} }
        }
        registry.set('g:' + operationName, {
          type: 'graphql', operationName, queryId, method,
          url: u.origin + u.pathname,
          search: u.search,
          variables, features, headers, capturedAt: ts,
        });
        history.push({ operationName, queryId, method, ts });
        if (history.length > MAX_HISTORY) history.shift();
        const gqlRecent = pushRecent({ ts, method, path: u.pathname, opName: operationName, status: null });
        // 关注类 mutation(FriendshipCreate 等)带上 variables: 失败捕获要从请求里提取目标用户
        if (/friendship/i.test(operationName)) gqlRecent.variables = variables;
        return gqlRecent;
      }

      // v1.1 REST 等 /i/api/ 请求: 按路径登记(保留最近一次), 回关等动作从这里重放
      const apiEntry = {
        type: 'api',
        method,
        path: u.pathname,
        url: u.origin + u.pathname,
        search: u.search,
        body: coerceBodySync(init && init.body),
        headers,
        capturedAt: ts,
      };
      registry.set('p:' + u.pathname, apiEntry);
      if (method === 'POST') persistApiTemplate(u.pathname, apiEntry);
      const recentItem = pushRecent({ ts, method, path: u.pathname, status: null });
      // 关注路径额外带上 body(含 user_id): 失败捕获要从请求里提取目标用户
      if (u.pathname === FOLLOW_PATH) recentItem.body = apiEntry.body;
      return recentItem;
    } catch {}
    return null;
  }

  // ---- hook fetch ----
  const origFetch = window.fetch;
  window.__xfollowbackOrigFetch = origFetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      let item = null;
      try {
        const url = typeof input === 'string' ? input : input && input.url;
        if (url) {
          let headers = init && init.headers;
          let method = init && init.method;
          let body = init && init.body;
          if (typeof Request !== 'undefined' && input instanceof Request) {
            headers = headers || input.headers;
            method = method || input.method;
            // Request 上的 body 无法同步读; 仅当 init 未带 body 时保持 null(create.json 实测走 init.body)
            if (body == null) body = undefined;
          }
          item = record(url, { ...(init || {}), headers, method, body });
        }
      } catch {}
      const p = origFetch.apply(this, arguments);
      if (item) {
        p.then((res) => {
          item.status = res && res.status;
          try {
            // 手动关注失败捕获: REST(create.json)与 GraphQL(关注 mutation)都看; 读响应体判断额度类失败(clone 后读, 不消费原响应流)
            // GraphQL 常 HTTP 200 包 errors[{code:161}]——!res.ok 不够, 关注 mutation 成功响应也扫一眼 body
            const isFollowApi = item.path === FOLLOW_PATH || (item.opName && /friendship/i.test(item.opName));
            if (res && isFollowApi) {
              res.clone().text().then((t) => {
                if (!res.ok) {
                  noteFollowResult(item, res.status, t);
                  return;
                }
                if (item.opName && /friendship/i.test(item.opName)) {
                  try {
                    const errs = (JSON.parse(t) || {}).errors;
                    if (Array.isArray(errs) && errs.length) noteFollowResult(item, res.status, t);
                  } catch {}
                }
              }).catch(() => {});
            }
            if (res && res.ok && item.opName === 'Viewer') {
              res.clone().text().then(sniffViewer).catch(() => {});
            }
          } catch {}
        }).catch(() => { item.status = 'ERR'; });
      }
      return p;
    };
  }

  // ---- hook XHR ----
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSetHeader = XHR.setRequestHeader;
  const origSend = XHR.send;
  window.__xfollowbackOrigXHR = { open: origOpen, setRequestHeader: origSetHeader, send: origSend };
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
          body: coerceBodySync(body) || undefined,
        });
      }
    } catch {}
    if (item) this.addEventListener('loadend', () => {
      item.status = this.status;
      try {
        const isFollowApi = item.path === FOLLOW_PATH || (item.opName && /friendship/i.test(item.opName));
        if (isFollowApi && item.status !== 200) {
          // responseText 在 responseType=json 等模式下会抛——退化读 this.response 再序列化
          let text = '';
          try { text = this.responseText; } catch {}
          if (!text && this.response && typeof this.response === 'object') {
            try { text = JSON.stringify(this.response); } catch {}
          }
          noteFollowResult(item, item.status, text);
        }
      } catch {}
      try { if (item.opName === 'Viewer') sniffViewer(this.responseText); } catch {}
    });
    return origSend.apply(this, arguments);
  };

  // 提取限流响应头(15 分钟窗口): remaining=窗口内剩余次数, reset=窗口重置时刻(UTC epoch 秒)
  function rateLimitHeaders(res) {
    const rl = {};
    try {
      for (const k of ['limit', 'remaining', 'reset']) {
        const v = res.headers && res.headers.get('x-rate-limit-' + k);
        if (v != null && v !== '') rl[k] = Number(v);
      }
    } catch {}
    return rl;
  }

  // ---- 消息响应(单例: 热升级时先 remove 旧 listener, 避免 list-captured 双回包) ----
  const onMessage = async (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== 'xfollowback-ui') return;
    const reply = (data) =>
      window.postMessage({ source: 'xfollowback-page', type: 'result', id: msg.id, data }, '*');

    if (msg.type === 'take-failed-follows') {
      // 取走即清: content 侧每 5 秒轮询, 入队成功与否由 content 日志负责; diag 供未捕获失败的排查
      reply({ follows: failedFollows.splice(0), diag: followDiag.splice(0) });
      return;
    }

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
      reply({ hookVersion: HOOK_VERSION, operations: gOps, apiEndpoints, history, recent });
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
        // 条件请求头/长度头来自原始请求, 重放时变量已变:
        //   if-none-match 命中原缓存会返回 304(空 body), content-length 与新 body 不符可能 400 → 必须剥掉
        //   注意 x-client-transaction-id 必须保留(实测缺失→404); 它不绑定 URL, 复用最近捕获的即可
        // tid 池覆盖(ADR-0004): content.js 若从池里取到同路径且冷却已过的 tid, 优先用它(免等待); 否则用本页捕获的
        if (msg.payload && msg.payload.tid) init.headers['x-client-transaction-id'] = msg.payload.tid;
        for (const k of ['if-none-match', 'if-modified-since', 'content-length']) delete init.headers[k];
        // csrf 以当前会话 cookie 为准(持久化模板里的可能是旧会话的)
        const csrf = currentCsrf();
        if (csrf) init.headers['x-csrf-token'] = csrf;
        if (entry.method === 'GET') {
          const p = new URLSearchParams(entry.search);
          p.set('variables', JSON.stringify(variables || {}));
          url += '?' + p.toString();
        } else {
          init.headers['content-type'] = 'application/json';
          const bodyObj = { variables: variables || {}, queryId: entry.queryId };
          if (entry.features) bodyObj.features = entry.features; // POST 形态必须带回 features
          init.body = JSON.stringify(bodyObj);
        }
        // 取证: 如实记录本次重放实际要发送的头(tid 龄 = 捕获到现在的时长), 随结果回传
        // (list-captured 对外剥头, 隔离世界看到的 headers 是空的——取证必须在这里做才真实)
        const sent = {
          headerKeys: Object.keys(init.headers).sort(),
          tidLen: (init.headers['x-client-transaction-id'] || '').length,
          tidAgeMs: Math.max(0, Date.now() - entry.capturedAt),
          csrfLen: (init.headers['x-csrf-token'] || '').length,
        };
        const res = await origFetch.call(window, url, init);
        const body = await res.text();
        reply({ status: res.status, ok: res.ok, body, rl: rateLimitHeaders(res), url, sent });
      } catch (e) {
        reply({ status: -1, ok: false, body: String(e) });
      }
      return;
    }

    if (msg.type === 'whoami') {
      // 当前登录账号: 首选被动喍探的 Viewer 结果(零请求); settings.json 仅作兑底且带5分钟失败负缓存
      // (实测 settings.json 会整体 429; 多账号登录时侧栏 DOM 里第一个链接可能是别的账号, ADR-0003)
      (async () => {
        try {
          if (meName && Date.now() - meName.at < 24 * 60 * 60_000) {
            reply({ status: 200, ok: true, screenName: meName.name });
            return;
          }
          if (whoamiCache && Date.now() - whoamiCache.at < 10 * 60_000) {
            reply({ status: 200, ok: true, screenName: whoamiCache.name });
            return;
          }
          if (settingsFailAt && Date.now() - settingsFailAt < 5 * 60_000) {
            reply({ status: 429, ok: false, body: 'settings.json cooling down' });
            return;
          }
          let headers = null;
          for (const e of registry.values()) {
            if (e.headers && Object.keys(e.headers).length) { headers = e.headers; break; }
          }
          if (!headers) { reply({ status: -2, ok: false, body: 'no captured headers' }); return; }
          const init = { method: 'GET', credentials: 'include', headers: { ...headers } };
          for (const k of ['if-none-match', 'if-modified-since', 'content-length']) delete init.headers[k];
          const csrf = currentCsrf();
          if (csrf) init.headers['x-csrf-token'] = csrf;
          const res = await origFetch.call(window, location.origin + '/i/api/1.1/account/settings.json', init);
          const body = await res.text();
          let name = null;
          try { name = JSON.parse(body).screen_name || null; } catch {}
          if (res.ok && name) {
            whoamiCache = { at: Date.now(), name };
          } else {
            settingsFailAt = Date.now();
          }
          reply({ status: res.status, ok: res.ok, screenName: name, body: res.ok ? undefined : body.slice(0, 200) });
        } catch (e) {
          reply({ status: -1, ok: false, body: String(e) });
        }
      })();
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
        const { url, init } = globalThis.XFollowBackLogic.buildApiRequest(entry, params, currentCsrf());
        const res = await origFetch.call(window, url, init);
        const body = await res.text();
        reply({ status: res.status, ok: res.ok, body, rl: rateLimitHeaders(res) });
      } catch (e) {
        reply({ status: -1, ok: false, body: String(e) });
      }
    }
  };
  window.__xfollowbackOnMessage = onMessage;
  window.addEventListener('message', onMessage);
})();
