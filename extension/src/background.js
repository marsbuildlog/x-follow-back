// MV3 service worker: 长任务不在这里跑, 全部在 x.com 标签页的 content script 内执行。
// 职责:
//   0. tid 收割池(ADR-0004): 旁听 x.com 页面自己的 API 请求头, 收集页面产生的
//      x-client-transaction-id 入 rf_tid_pool(带路径标签), 重放侧按路径取用轮换;
//      顺带收集 graphql 模板(queryId/features/页面原头/bearer)——Route 1(脱离页面直连)的运输材料
//   3. Route 1 直连对照实验(options 页触发): 用收割材料直接 fetch x.com, 验证脱离页面的传输层
//      (扩展重启后所有旧 content script 变孤儿, 页面必须刷新才能重新注入;
//       其余 x.com 页不刷, 避免丢失页面内状态如草稿)
//   2. 代理系统通知(chrome.notifications 仅扩展页面可用, content script 无权调用)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.cmd === 'notify') {
    notify(msg.tag || String(Date.now()), msg.title, msg.message);
    return;
  }
  if (msg.cmd === 'harvest-boost') {
    harvestBoost('手动').then((ran) => sendResponse(Object.assign({ ran }, lastBoostDiag))).catch((e) => sendResponse({ ran: false, error: String(e) }));
    return true;
  }
  if (msg.cmd === 'route1-graphql') {
    // content 平铺传参(rawQuery/count/cursor 在顶层), 在这里收拢成 query 对象
    route1Graphql(msg.op, { rawQuery: msg.rawQuery, count: msg.count, cursor: msg.cursor })
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.cmd === 'route1-probe') {
    // 45s 总兑底: SW 里任何环节挂死也保证 options 页拿到应答(分步进度走 rf_r1_probe 实时可见)
    withTimeout(route1Probe(msg.op, msg.variables), 45_000, '探测总时长')
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) + '(分步进度见实验卡片输出区)' }));
    return true; // 异步 sendResponse
  }
});

// 最后一个 x.com 标签页被关闭且任务在跑 → 通知用户任务已暂停
// (任务跑在标签页内, 页面关了循环就停了; 重开页面会自动接管继续)
chrome.tabs.onRemoved.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
    if (tabs.length) return;
    const { rf_active: h } = await chrome.storage.local.get('rf_active');
    if (!h) return;
    const key = 'rf_task:' + h;
    const { [key]: t } = await chrome.storage.local.get(key);
    if (t && t.state === 'running') {
      notify('tab-closed', 'XFollowBack 已暂停', 'x.com 页面已关闭, 自动回关已停止; 重新打开认证粉丝页会自动继续');
    }
  } catch {}
});

// SW 启动即执行(runtime.reload() 后 Chrome 会拉起新 SW)
function notify(tag, title, message) {
  try {
    const p = chrome.notifications.create('xfollowback-' + tag, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/128.png'),
      title: title || 'XFollowBack',
      message: message || '',
      priority: 2,
    });
    if (p && p.catch) p.catch(() => {});
  } catch {}
}
chrome.storage.local.get('rf_reload_tabs').then(({ rf_reload_tabs }) => {
  if (!rf_reload_tabs) return;
  chrome.storage.local.remove('rf_reload_tabs');
  (async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const xTabs = await chrome.tabs.query({ url: 'https://x.com/*' });
    for (const t of xTabs) {
      const isTaskPage = /\/verified_followers/.test(t.url || '');
      const isActiveX = !!active && t.id === active.id && (t.url || '').startsWith('https://x.com/');
      if (isTaskPage || isActiveX) chrome.tabs.reload(t.id);
    }
    // 本扩展自己的页面(如已打开的控制台)也刷新, 避免留在孤儿状态
    const ownTabs = await chrome.tabs.query({ url: `chrome-extension://${chrome.runtime.id}/*` });
    for (const t of ownTabs) chrome.tabs.reload(t.id);
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[XFollowBack] installed');
});

// ---------- tid 收割池(ADR-0004) ----------
// MV3 webRequest 纯旁听(不能改写); tid/authorization 是普通请求头, 不需要 extraHeaders。
importScripts('shared/constants.js', 'shared/route1.js', 'shared/harvest.js', 'shared/tidpool.js');

const TID_KEY = globalThis.RF.KEY.tidPool;
let tidWriteInFlight = false;

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    try {
      const hs = details.requestHeaders || [];
      const tidH = hs.find((h) => h.name.toLowerCase() === 'x-client-transaction-id');
      if (!tidH || !tidH.value || tidH.value.length < 60) return;
      const path = new URL(details.url).pathname;
      // 写入串行化: 写进行中时丢弃本次(同页面批量请求会重复触发, 页面持续产 tid, 丢一两条无妨)
      if (tidWriteInFlight) return;
      tidWriteInFlight = true;
      chrome.storage.local.get(TID_KEY)
        .then(({ [TID_KEY]: pool }) =>
          chrome.storage.local.set({ [TID_KEY]: globalThis.RFTidPool.add(pool || [], tidH.value, path, Date.now()) }))
        .catch(() => {}).finally(() => { tidWriteInFlight = false; });
      // bearer 是常量, 变化极罕见: 见到就覆盖(供 Route 1 直连传输用)
      const auth = hs.find((h) => h.name.toLowerCase() === 'authorization');
      if (auth && auth.value && auth.value.startsWith('Bearer ')) {
        chrome.storage.local.get(RF.KEY.bearer).then(({ [RF.KEY.bearer]: old }) => {
          if (old !== auth.value) chrome.storage.local.set({ [RF.KEY.bearer]: auth.value });
        }).catch(() => {});
      }
    } catch {}
  },
  { urls: ['https://x.com/i/api/*'] },
  ['requestHeaders']
);

// graphql 模板旁听(Route 1 运输材料): op → {path, queryId, method, features, 首见变量, GET稳定参数, 页面原头筛后}。
// 教训(65a4bcc): onBeforeRequest 的 extraInfoSpec 不收 requestHeaders(只 onSendHeaders 给),
// 写了在 SW 顶层求值时直接抛 TypeError → 整个 SW 注册失败, 后台全死。
// 因此拆两个监听器: 头与 URL 元信息在 onSendHeaders(它才有 requestHeaders);
// POST body 的 features 只 onBeforeRequest 拿得到, 在这里打补丁(比主体晚一发到达, SearchTimeline 连发几秒内补齐)。
// 变量逐请求都变: s 存除 variables 外的稳定参数, 不参与逐请求写入。
const TPL_PREFIX = globalThis.RF.KEY.gqlTpl + ':';

// onSendHeaders: 模板主体(p/q/m/s/f(GET)/v0(GET)/h)
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    try {
      const u = new URL(details.url);
      if (!u.pathname.startsWith('/i/api/graphql/')) return;
      const op = u.pathname.split('/').pop();
      if (!op) return;
      const q = u.pathname.split('/')[4] || ''; // /i/api/graphql/<queryId>/<op>
      let features = null;
      let v0 = null;
      let sStable = '';
      if (details.method === 'GET') {
        // GET 直连重放要保留 features/fieldToggles 等, 只换 variables → 存去掉 variables 后的稳定参数串
        const sp = new URLSearchParams(u.search);
        try { v0 = JSON.parse(sp.get('variables') || 'null'); } catch {}
        try { features = JSON.parse(sp.get('features') || 'null'); } catch {}
        sp.delete('variables');
        sStable = sp.toString();
      }
      // 页面原头(Route 1 对照实验的 full 头集来源); 动态/注入项由 pickDirectHeaders 剔除
      const directHeaders = globalThis.RFRoute1.pickDirectHeaders(
        Object.fromEntries((details.requestHeaders || []).map((h) => [h.name, h.value]))
      );
      const tplKey = TPL_PREFIX + op;
      chrome.storage.local.get(tplKey).then(({ [tplKey]: old }) => {
        // queryId/features/头集/稳定参数都没变就不写(避免每次滚动都写 storage)
        if (old && old.q === q && old.s === sStable
            && JSON.stringify(old.f) === JSON.stringify(features)
            && JSON.stringify(old.h) === JSON.stringify(directHeaders)) return;
        return chrome.storage.local.set({ [tplKey]: { p: u.pathname, q, m: details.method, f: features, v0: (old && old.v0) || v0, s: sStable, h: directHeaders, at: Date.now() } });
      }).catch(() => {});
    } catch {}
  },
  { urls: ['https://x.com/i/api/graphql/*'] },
  ['requestHeaders']
);

// onBeforeRequest: 只为 POST 形态补 features/首见变量(requestBody 只它有)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (details.method !== 'POST') return;
      const u = new URL(details.url);
      if (!u.pathname.startsWith('/i/api/graphql/')) return;
      const op = u.pathname.split('/').pop();
      const raw = details.requestBody && details.requestBody.raw && details.requestBody.raw[0];
      if (!op || !raw || !raw.bytes) return;
      let features = null;
      let v0 = null;
      try {
        const body = JSON.parse(new TextDecoder().decode(raw.bytes));
        features = body.features || null;
        v0 = body.variables || null;
      } catch {}
      const tplKey = TPL_PREFIX + op;
      chrome.storage.local.get(tplKey).then(({ [tplKey]: old }) => {
        if (!old) return; // 主体还没写(onSendHeaders 稍后写), 等下一发自然补上
        if (JSON.stringify(old.f) === JSON.stringify(features) && old.v0) return;
        return chrome.storage.local.set({ [tplKey]: Object.assign({}, old, { f: features, v0: old.v0 || v0, at: Date.now() }) });
      }).catch(() => {});
    } catch {}
  },
  { urls: ['https://x.com/i/api/graphql/*'] },
  ['requestBody']
);

// Route 1 正式发射(扫描/搜索循环用): minimal 三件套(2026-10-11 对照实验双 200, 页面原头非必需)。
// 返回 {status, ok, body, rl} 或 {error}(结构性缺料/网络异常——调用方据此回退页面重放; HTTP 错误不算 error)。
async function route1Graphql(op, query) {
  const tplKey = TPL_PREFIX + op;
  const { [tplKey]: tpl } = await chrome.storage.local.get(tplKey);
  if (!tpl || !tpl.p || !tpl.v0) return { error: `rf_tpl:${op} 模板未旁听到或缺变量形状` };
  const { [RF.KEY.bearer]: bearer } = await chrome.storage.local.get(RF.KEY.bearer);
  if (!bearer) return { error: 'bearer 未收割' };
  const ck = await chrome.cookies.get({ url: 'https://x.com/', name: 'ct0' });
  if (!ck || !ck.value) return { error: '读不到 ct0 cookie' };
  const { [TID_KEY]: pool0 } = await chrome.storage.local.get(TID_KEY);
  let pool = pool0 || [];
  const tidEntry = globalThis.RFTidPool.pick(pool, { path: tpl.p, cooldownMs: RF.AF.TID_COOLDOWN_MS });
  if (!tidEntry) {
    harvestBoost('池见底').catch(() => {}); // 异步供血(本发照常报错走回退, 下几发受益)
    return { error: '池中无同路径可用 tid(全在冷却)' };
  }
  // 变量 = 首见形状 + 本次业务参数(rawQuery/count/cursor), 与页面重放同构
  const variables = Object.assign({}, tpl.v0, { rawQuery: query.rawQuery, count: query.count || 20 });
  if (query.cursor) variables.cursor = query.cursor; else delete variables.cursor;
  const req = globalThis.RFRoute1.buildRequest(tpl, variables);
  const headers = globalThis.RFRoute1.headerSets(tpl.h, bearer, ck.value, tidEntry.t, req.isPost).minimal;
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), R1_FETCH_TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch(req.url, { method: req.method, headers, credentials: 'include', body: req.body, signal: ac.signal });
    body = await res.text();
  } catch (e) {
    clearTimeout(kill);
    return { error: '网络异常: ' + String((e && e.message) || e) + (ac.signal.aborted ? '(>20s 无响应)' : '') };
  }
  clearTimeout(kill);
  const rl = {};
  for (const k of ['limit', 'remaining', 'reset']) {
    const v = res.headers && res.headers.get('x-rate-limit-' + k);
    if (v != null && v !== '') rl[k] = Number(v);
  }
  pool = globalThis.RFTidPool.markResult(pool, tidEntry.t, tpl.p, res.ok || res.status !== 404, Date.now());
  // ↑ 422/429 等"被 X 完整处理过的失败"也会启动 tid 冷却计时(2026-10-11 实测: 422 后 30s 同 tid → 404 空体),
  //   按"已消耗"记 ok 提前进入冷却换下一条; 404 空 body 才按 ADR-0002 记 fail(不延长冷却)。
  await chrome.storage.local.set({ [TID_KEY]: pool });
  return { status: res.status, ok: res.ok, body, rl };
}
// ---------- 池子自动供血(ADR-0004 遗留B) ----------
// 池见底(route1Graphql 无同路径可用 tid)时, 开一个后台搜索页签让页面自己发 SearchTimeline,
// webRequest 旁听入库; 数发加载攒 2~4 条, 70s 冷却后轮换可用。发完即关页签, 全程无感。
const HARVEST_KEY = 'rf_harvest_last'; // lastAt 持久化: SW 被杀重启后仍守 90s 间隔, 防页签风暴
const harvestState = { running: false, tabId: null };

// background 侧写 rf_log(与 content.js log() 同形状, options 日志面板可见)
async function bgLog(text) {
  try {
    const { [RF.KEY.log]: arr } = await chrome.storage.local.get(RF.KEY.log);
    const list = arr || [];
    list.push({ ts: Date.now(), text: String(text).slice(0, 500) });
    while (list.length > 200) list.shift();
    await chrome.storage.local.set({ [RF.KEY.log]: list });
  } catch {}
}

// 返回是否真的发了车(被 running/间隔拦下则 false)。实现用独立小窗而非页签:
// x.com 的路由级取数有可见性门控——active:false 的页签 visibilityState=hidden, 页面启动但不发
// SearchTimeline(实测三连扑空); 非聚焦窗口内选中标签的 visibilityState=visible, 照常发请求且不抢焦点。
async function harvestBoost(reason) {
  const now = Date.now();
  const { [HARVEST_KEY]: lastAt } = await chrome.storage.local.get(HARVEST_KEY);
  if (!globalThis.RFHarvest.shouldRun({ running: harvestState.running, lastAt }, now)) return false;
  harvestState.running = true;
  await chrome.storage.local.set({ [HARVEST_KEY]: now });
  const { [RF.KEY.settings]: settings } = await chrome.storage.local.get(RF.KEY.settings);
  const url = globalThis.RFHarvest.searchUrl(settings && settings.tags);
  const startedAt = Date.now();
  const t0 = Date.now();
  let winId = null, tabId = null;
  let got = 0;
  const diag = { rounds: [], winCreateMs: null, err: null };
  try {
    await bgLog(`池子供血(${reason}): 开后台搜索小窗收 ${globalThis.RFHarvest.ROUNDS} 发, 约半分钟后可用`);
    const wc0 = Date.now();
    const win = await chrome.windows.create({ url, focused: false, width: 1000, height: 760, top: 40, left: 40 });
    diag.winCreateMs = Date.now() - wc0;
    winId = win.id;
    tabId = harvestState.tabId = win.tabs[0].id;
    // 反馈驱动: 每轮加载后轮询池子直到真入库一条新 SearchTimeline tid(或超时); 页面不出活就提前收工
    for (let i = 0; i < globalThis.RFHarvest.ROUNDS; i++) {
      if (i > 0 && harvestState.tabId != null) {
        try { await chrome.tabs.reload(tabId); } catch (e) { break; }
      }
      const m = await yieldForNewSearchTid(startedAt);
      diag.rounds.push({ round: i, matched: m ? m.age + "s-old/total" + m.total : false, waitedMs: m ? m.waitedMs : null });
      if (m) got++;
      else break;
    }
    lastBoostDiag = Object.assign({ ran: got > 0, got, ms: Date.now() - t0, at: Date.now() }, diag);
    return got > 0;
  } catch (e) {
    diag.err = String((e && e.message) || e);
    lastBoostDiag = Object.assign({ ran: false, got, ms: Date.now() - t0, at: Date.now() }, diag);
    return false;
  } finally {
    if (winId != null) { try { await chrome.windows.remove(winId); } catch {} }
    harvestState.running = false;
    harvestState.tabId = null;
  }
}

// 最近一次供血诊断(ran/got/耗时/每轮详情), 供 harvest-boost 应答与排查
let lastBoostDiag = null;

// 轮询池子等新入库的 SearchTimeline tid; 命中时返回 {age, total, waitedMs} 供诊断, 未命中返回 null
function yieldForNewSearchTid(startedAt) {
  return new Promise((resolve) => {
    let waited = 0;
    const tick = async () => {
      try {
        const { [TID_KEY]: pool } = await chrome.storage.local.get(TID_KEY);
        const m = (pool || []).find((e) => e.p.includes('/SearchTimeline') && e.at >= startedAt);
        if (m) return resolve({ age: Math.max(0, Date.now() - m.at), total: (pool || []).length, waitedMs: waited });
      } catch {}
      waited += globalThis.RFHarvest.POLL_INTERVAL_MS;
      if (waited >= globalThis.RFHarvest.POLL_MAX_MS) return resolve(null);
      setTimeout(tick, globalThis.RFHarvest.POLL_INTERVAL_MS);
    };
    setTimeout(tick, globalThis.RFHarvest.POLL_INTERVAL_MS);
  });
}

// 供血小窗被用户手动关掉时别卡在 running 态
chrome.tabs.onRemoved.addListener((tabId) => {
  if (harvestState.tabId === tabId) { harvestState.tabId = null; harvestState.running = false; }
});

// ---------- Route 1 直连对照实验(ADR-0004) ----------
// (探测: 一次发射最多两发 full→minimal, 各耗一个池内同路径 tid; 实验已过, 循环已切 route1-graphql)
// 429/网络异常即停(桶热了换头集也无益); 4xx 照发 minimal——若同样失败, 说明问题不在头集(参数/模板层)。
// 可观测性: 每步进度实时写 rf_r1_probe(options 页监听 storage 现场渲染);
//   每个网络调用带 20s 中断超时——SW 里任何一环挂住都不会让发射永远"发射中"。
const R1_STATE_KEY = 'rf_r1_probe';
const R1_FETCH_TIMEOUT_MS = 20_000;

// 竞速超时: 超过 ms 未决则以 label 报错(纯兑底用, 不取消原任务)
function withTimeout(p, ms, label) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时(' + Math.round(ms / 1000) + 's)')), ms)),
  ]);
}

async function route1Probe(op, variables) {
  const steps = [];
  const t0 = Date.now();
  const step = (name, info) => {
    steps.push({ at: Date.now() - t0, name, info: info || '' });
    return chrome.storage.local.set({ [R1_STATE_KEY]: { done: false, steps } }).catch(() => {});
  };
  const finish = (result) =>
    chrome.storage.local.set({ [R1_STATE_KEY]: Object.assign({ done: true, steps }, result) }).catch(() => {});

  const tplKey = TPL_PREFIX + op;
  await step('读模板', op);
  const { [tplKey]: tpl } = await chrome.storage.local.get(tplKey);
  if (!tpl || !tpl.p) { const r = { ok: false, error: `未旁听到 ${op} 模板——先在 x.com 触发一次该查询, 让 webRequest 旁听到它` }; await finish(r); return r; }
  await step('模板 ✓', `m=${tpl.m} hasSearch=${!!tpl.s} 页面头${Object.keys(tpl.h || {}).length}个`);
  const { [RF.KEY.bearer]: bearer } = await chrome.storage.local.get(RF.KEY.bearer);
  if (!bearer) { const r = { ok: false, error: 'bearer 未收割——打开 x.com 任意页即可' }; await finish(r); return r; }
  await step('bearer ✓', `长度${bearer.length}`);
  await step('读 ct0 cookie');
  let ck;
  try {
    ck = await withTimeout(chrome.cookies.get({ url: 'https://x.com/', name: 'ct0' }), 10_000, 'cookies.get');
  } catch (e) { const r = { ok: false, error: '读 cookie 异常: ' + String((e && e.message) || e) }; await finish(r); return r; }
  if (!ck || !ck.value) { const r = { ok: false, error: '读不到 ct0 cookie——确认已登录 x.com' }; await finish(r); return r; }
  const csrf = ck.value;
  await step('csrf ✓', `长度${csrf.length}`);

  const { [TID_KEY]: pool0 } = await chrome.storage.local.get(TID_KEY);
  let pool = pool0 || [];
  await step('tid 池 ✓', `${pool.length} 条`);
  const attempts = [];
  for (const setName of ['full', 'minimal']) {
    const tidEntry = globalThis.RFTidPool.pick(pool, { path: tpl.p, cooldownMs: RF.AF.TID_COOLDOWN_MS });
    if (!tidEntry) {
      attempts.push({ set: setName, error: '池中无同路径可用 tid(全在冷却)——约70秒后重试, 或先在 x.com 上动一动供血' });
      await step(`${setName}: 无可用 tid`, '停止');
      break;
    }
    let req, sets;
    try {
      req = globalThis.RFRoute1.buildRequest(tpl, variables);
      sets = globalThis.RFRoute1.headerSets(tpl.h, bearer, csrf, tidEntry.t, req.isPost);
    } catch (e) {
      attempts.push({ set: setName, error: '构造失败: ' + String((e && e.message) || e) });
      await step(`${setName} 构造失败`, String((e && e.message) || e));
      break;
    }
    await step(`${setName} 发射`, `tid龄${Math.round((Date.now() - tidEntry.at) / 1000)}s 头${Object.keys(sets[setName]).length}个`);
    const f0 = Date.now();
    const ac = new AbortController();
    const kill = setTimeout(() => ac.abort(), R1_FETCH_TIMEOUT_MS);
    let res, body;
    try {
      res = await fetch(req.url, { method: req.method, headers: sets[setName], credentials: 'include', body: req.body, signal: ac.signal });
      body = await res.text();
    } catch (e) {
      clearTimeout(kill);
      const msg = String((e && e.message) || e) + (ac.signal.aborted ? `(>${Math.round(R1_FETCH_TIMEOUT_MS / 1000)}s 无响应, 已中断)` : '');
      attempts.push({ set: setName, error: '网络异常: ' + msg });
      await step(`${setName} 网络异常`, msg);
      break;
    }
    clearTimeout(kill);
    const rl = {};
    for (const k of ['limit', 'remaining', 'reset']) {
      const v = res.headers && res.headers.get('x-rate-limit-' + k);
      if (v != null && v !== '') rl[k] = Number(v);
    }
    let isJson = false;
    try { JSON.parse(body); isJson = true; } catch {}
    attempts.push({
      set: setName, status: res.status, ok: res.ok, ms: Date.now() - f0,
      bodyLen: body.length, isJson, head: body.slice(0, 160), rl,
      headers: Object.keys(sets[setName]).sort(),
    });
    pool = globalThis.RFTidPool.markResult(pool, tidEntry.t, tpl.p, res.ok, Date.now());
    await step(`${setName} 返回`, `HTTP ${res.status} ${body.length}B ${Date.now() - f0}ms${res.status === 429 ? '(429 即停)' : ''}`);
    if (res.status === 429) break; // 限流桶热了, 换头集再发只会更糟
  }
  await chrome.storage.local.set({ [TID_KEY]: pool });
  const r = {
    ok: attempts.some((a) => a.ok),
    attempts,
    tpl: { path: tpl.p, q: tpl.q, m: tpl.m, hasFeatures: !!tpl.f, hasSearch: !!tpl.s, hKeys: Object.keys(tpl.h || {}) },
    csrfLen: csrf.length, tidPoolSize: pool.length,
  };
  await finish(r);
  return r;
}
