// MV3 service worker: 长任务不在这里跑(ADR-0010: 循环宿主=常开控制台 options; 不搬进 SW)。
// 职责:
//   0. tid 收割池(ADR-0004): 旁听 x.com 页面自己的 API 请求头, 收集页面产生的
//      x-client-transaction-id 入 rf_tid_pool(带路径标签), 重放侧按路径取用轮换;
//      顺带收集 graphql 模板(queryId/features/页面原头/bearer)——Route 1(脱离页面直连)的运输材料
//   3. Route 1 直连对照实验(options 页触发): 用收割材料直接 fetch x.com, 验证脱离页面的传输层
//      (扩展重启后所有旧 content script 变孤儿, 页面必须刷新才能重新注入;
//       其余 x.com 页不刷, 避免丢失页面内状态如草稿)
//   2. 代理系统通知(chrome.notifications 仅扩展页面可用, content script 无权调用)
//   4. 身份探针(ADR-0005): 免输入识别登录账号, ct0+公共 bearer → settings.json → rf_active
//   5. 控制台宿主端口(ADR-0010): options connect 保活; 断开时可通知(心跳以 storage 为准)

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
  if (msg.cmd === 'open-options') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (msg.cmd === 'identity-probe') {
    identityProbe().then((ok) => sendResponse({ ok }));
    return true;
  }
  if (msg.cmd === 'follow-probe') {
    withTimeout(followProbe(msg.handle), 60_000, '回关直连实验')
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.cmd === 'route1-follow') {
    // Phase 2 生产路径: create.json 直连; 传输失败返回 {error, transport:true} 供 content 兑底页面重放
    withTimeout(route1Follow(msg.userId), 30_000, 'route1-follow')
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String((e && e.message) || e), transport: true }));
    return true;
  }
  if (msg.cmd === 'route1-unfollow') {
    // destroy.json 直连(与 create 同形态); 未回关名单批量取关用
    withTimeout(route1Unfollow(msg.userId), 30_000, 'route1-unfollow')
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String((e && e.message) || e), transport: true }));
    return true;
  }
  if (msg.cmd === 'route1-graphql') {
    // vars = 变量补丁(含 null 值删键语义, 见 RFRoute1.mergeVariables)
    route1Graphql(msg.op, msg.vars || {})
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
  if (msg.cmd === 'crosspath-tid-probe') {
    // GraphQL 跨路径 tid 对照(ADR-0004 待放行项): 不改生产 pick, 只出实验结论
    withTimeout(crosspathTidProbe(msg.op, msg.variables), 45_000, '跨路径 tid 实验')
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
});

// ---------- 身份探针(ADR-0005): 免输入识别登录账号 ----------
// 读 ct0 cookie + bearer(收割优先/公共兑底) → settings.json 取 screen_name → rf_active。
// settings.json 实测会 429(极小限额桶)甚至 404(拒绝无 tid 的调用), 任何叠加尝试都会打成风暴:
// 全局闸门 rf_whoami_gate(storage, 与页面 whoami 链共享)——
//   MV3 SW 被 x.com 的 webRequest 事件高频唤醒, 内存态冷却跨不过重启(实测: 认证粉丝页开着时
//   每次 SW 唤醒都裸发一发 settings.json → 疯狂 429)。闸门跨重启/跨标签页生效:
//   60s 内任何一方刚试过就不叠; 失败按 retryAt 冷却(429 用服务端窗口, 其余 5 分); 成功 10 分内直接采纳。
const IDENTITY_OK_MS = 10 * 60_000;
const IDENTITY_FAIL_MS = 5 * 60_000;
const GATE_KEY = 'rf_whoami_gate';
const identityState = { ok: false, at: 0 };

async function hasActive() {
  const { rf_active: cur } = await chrome.storage.local.get('rf_active').catch(() => ({}));
  return !!cur;
}
async function gateWrite(v) {
  await chrome.storage.local.set({ [GATE_KEY]: v }).catch(() => {});
}
// 落盘识别结果(探针自发或采纳页面侧成功, 同一次成功不重复发请求)
async function adoptHandle(name, via) {
  if (!name) return;
  const { rf_active: prev } = await chrome.storage.local.get('rf_active');
  if (prev !== name) {
    await chrome.storage.local.set({ rf_active: name });
    bgLog(prev ? `身份探针: 当前登录账号 @${name}(之前按 @${prev})` : `身份探针: ${via}识别登录账号 @${name}`);
  }
}

// ---------- HTML 身份源(settings.json 的替代水源) ----------
// X 前端自身已不从 API 拿登录身份(Viewer op 绝迹、viewer_context.json 空体、settings.json 404/429),
// 身份只能在页面 SSR HTML 里。锚点: twid cookie(数字 uid) ↔ HTML 中同 uid 用户对象的 screen_name——
// 双重匹配, 不会误认成时间线上别的用户。页面能登上, 这条链就能识别。
async function identityFromHtml() {
  const tw = await chrome.cookies.get({ url: 'https://x.com/', name: 'twid' }).catch(() => null);
  const uid = tw && tw.value ? decodeURIComponent(tw.value).replace(/^u=/, '') : null;
  if (!uid || !/^\d+$/.test(uid)) return { ok: false, reason: '无 twid cookie(或形状变了)' };
  const res = await fetch('https://x.com/home', { method: 'GET', credentials: 'include' });
  if (!res.ok) return { ok: false, reason: 'home HTML HTTP ' + res.status };
  const html = await res.text();
  // 用户对象内 id 与 screen_name 距离很近, 两种 id 序列化(GraphQL rest_id / v1.1 实体 id_str)、两种键序都试
  const m = html.match(new RegExp('"rest_id":"' + uid + '"[\\s\\S]{0,600}?"screen_name":"([A-Za-z0-9_]{1,15})"'))
          || html.match(new RegExp('"screen_name":"([A-Za-z0-9_]{1,15})"[\\s\\S]{0,600}?"rest_id":"' + uid + '"'))
          || html.match(new RegExp('"screen_name":"([A-Za-z0-9_]{1,15})","id_str":"' + uid + '"'))
          || html.match(new RegExp('"id_str":"' + uid + '"[\\s\\S]{0,300}?"screen_name":"([A-Za-z0-9_]{1,15})"'));
  if (!m) {
    // 诊断: 锚点没中, 把候选分布摸清供下一轮迭代(上下文截段 + 各种 id/名字的序列化形式)
    const ctx = [];
    for (const mm of html.matchAll(/"screen_name":"([A-Za-z0-9_]{1,15})"/g)) {
      ctx.push(html.slice(Math.max(0, mm.index - 120), mm.index + 80).replace(/\s+/g, ' '));
    }
    return {
      ok: false,
      reason: 'HTML 中未找到 twid 匹配的用户对象',
      diag: {
        hasMyRestId: html.includes('"rest_id":"' + uid + '"'),
        idStr: html.includes('"id_str":"' + uid + '"'),
        bareId: html.includes(':' + uid + '[,}]') || html.includes('"userId":"' + uid + '"'),
        screenNameCount: (html.match(/"screen_name":"/g) || []).length,
        screenNameCtx: ctx.slice(0, 3),
        camelCase: [...html.matchAll(/"screenName":"([A-Za-z0-9_]{1,15})"/g)].map((x) => x[1]).slice(0, 5),
      },
    };
  }
  return { ok: true, name: m[1], uid };
}

async function identityProbe() {
  const now = Date.now();
  const g = await chrome.storage.local.get(GATE_KEY).then((o) => o[GATE_KEY] || {}).catch(() => ({}));
  if (identityState.ok && now - identityState.at < IDENTITY_OK_MS) return true; // 内存快路径
  if (g.ok && now - (g.at || 0) < IDENTITY_OK_MS) {
    // 页面 whoami 链刚识别成功: 直接采纳
    identityState.ok = true;
    identityState.at = g.at;
    await adoptHandle(g.name, '采纳页面识别, ');
    return true;
  }
  if ((g.retryAt && now < g.retryAt) || now - (g.at || 0) < 60_000) return false; // 冷却中/刚试过
  identityState.at = now;
  try {
    const ck = await chrome.cookies.get({ url: 'https://x.com/', name: 'ct0' });
    if (!ck || !ck.value) {
      await gateWrite({ at: now, ok: false, retryAt: now + IDENTITY_FAIL_MS });
      return false; // 未登录: 等 whoami 链接管
    }
    // 水源① settings.json(便宜, 但实测常 404/429)
    const { [RF.KEY.bearer]: harvested } = await chrome.storage.local.get(RF.KEY.bearer);
    const auth = harvested || globalThis.RF.publicBearer;
    const res = await fetch('https://x.com/i/api/1.1/account/settings.json', {
      method: 'GET',
      credentials: 'include',
      headers: { authorization: auth, 'x-csrf-token': ck.value },
    });
    let name = null;
    if (res.ok) {
      name = ((await res.json().catch(() => null)) || {}).screen_name;
      if (name && /^[A-Za-z0-9_]{1,15}$/.test(name)) {
        await gateWrite({ at: now, ok: true, name });
        identityState.ok = true;
        await adoptHandle(name, '');
        return true;
      }
    }
    // 水源② HTML 内嵌身份(重但稳: 页面能登上就识别得出)
    const html = await identityFromHtml();
    if (html.ok) {
      await gateWrite({ at: now, ok: true, name: html.name });
      identityState.ok = true;
      await adoptHandle(html.name, 'HTML水源, ');
      return true;
    }
    // 双水源都失败: 按 settings.json 的状态定冷却(429 用服务端窗口, 其余 5 分)
    const resetSec = Number(res.headers && res.headers.get('x-rate-limit-reset'));
    const retryAt = Number.isFinite(resetSec) && resetSec > now / 1000 ? resetSec * 1000 : now + IDENTITY_FAIL_MS;
    await gateWrite({ at: now, ok: false, retryAt });
    bgLog(`身份探针失败: settings.json HTTP ${res.status} + HTML水源(${html.reason}${html.diag ? ' ' + JSON.stringify(html.diag) : ''}), ${new Date(retryAt).toLocaleTimeString()} 后重试`);
    return false;
  } catch {
    await gateWrite({ at: Date.now(), ok: false, retryAt: Date.now() + IDENTITY_FAIL_MS });
    return false;
  }
}

// 换号/重登会换 auth_token: 限额桶跟着账号走, 闸门与探针缓存一并作废
chrome.cookies.onChanged.addListener((info) => {
  if (info.cookie.name === 'auth_token' && (info.cookie.domain || '').includes('x.com')) {
    identityState.ok = false;
    identityState.at = 0;
    chrome.storage.local.remove(GATE_KEY).catch(() => {});
  }
});

// 最后一个 x.com 关掉: ADR-0010 后循环在控制台, 一般不停。仅当控制台心跳也已冷(兼容兜底宿主)才提醒。
chrome.tabs.onRemoved.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
    if (tabs.length) return;
    const { rf_active: h, rf_console_host: ch, rf_task: _ignore } = await chrome.storage.local.get(['rf_active', 'rf_console_host']);
    if (!h) return;
    const fresh = (globalThis.RF && RF.CONSOLE_HOST_FRESH_MS) || 15_000;
    if (ch && Date.now() - (ch.at || 0) < fresh) return; // 控制台仍在线, 循环继续
    const key = 'rf_task:' + h;
    const { [key]: t } = await chrome.storage.local.get(key);
    if (t && t.state === 'running') {
      notify('tab-closed', 'XFollowBack 提示', 'x.com 已全部关闭且控制台离线——打开控制台可继续回关');
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

// ---------- 回关动作 Route 1(Phase 2): friendships/create.json 直连 ----------
// 生产路径 route1Follow; 调试闸门 followProbe 复用同一 v11Call。
// 变体: ①最小头(bearer+csrf, 无 tid) ②加池内最新 tid(跨路径——池里天然没有 create.json 的 tid)。
// 业务响应(含 403/429)原样返回供 interpret; 仅传输失败(无 ct0/网络)标 transport 兑底页面重放。
function parseRlHeaders(res) {
  const rl = {};
  for (const k of ['limit', 'remaining', 'reset']) {
    const v = res.headers && res.headers.get('x-rate-limit-' + k);
    if (v != null && v !== '') rl[k] = Number(v);
  }
  return rl;
}

async function v11Call(action, userId, tid) {
  const { [RF.KEY.bearer]: harvested } = await chrome.storage.local.get(RF.KEY.bearer);
  const auth = harvested || globalThis.RF.publicBearer;
  const ck = await chrome.cookies.get({ url: 'https://x.com/', name: 'ct0' });
  if (!ck || !ck.value) return { error: '读不到 ct0 cookie', transport: true };
  const headers = {
    authorization: auth,
    'x-csrf-token': ck.value,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (tid) headers['x-client-transaction-id'] = tid;
  let res, body;
  try {
    res = await fetch('https://x.com/i/api/1.1/friendships/' + action + '.json', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: 'user_id=' + encodeURIComponent(userId),
    });
    body = await res.text();
  } catch (e) {
    return { error: '网络异常: ' + String((e && e.message) || e), transport: true };
  }
  return { status: res.status, ok: res.ok, body, rl: parseRlHeaders(res) };
}

// 生产: 关注/取关一人。先无 tid, tid 拒收再试池内最新 tid; 传输失败返回 {error, transport:true}。
async function route1Friendship(action, userId) {
  const id = String(userId || '').trim();
  if (!id) return { error: '缺少 userId', transport: true };
  if (action !== 'create' && action !== 'destroy') return { error: '非法 action', transport: true };

  const first = await v11Call(action, id, null);
  if (first.transport || first.error) return { error: first.error || '直连失败', transport: true };

  const rejectTid = globalThis.RFRoute1.isTidRejectedFollow(first.status, first.body);
  if (!rejectTid) {
    return { status: first.status, ok: first.ok, body: first.body, rl: first.rl, via: 'no-tid' };
  }

  const { [TID_KEY]: pool } = await chrome.storage.local.get(TID_KEY);
  const tidEntry = (pool || []).slice().sort((a, b) => b.at - a.at)[0];
  if (!tidEntry || !tidEntry.t) {
    return { error: 'Route 1 tid 拒收且池空', transport: true, status: first.status };
  }

  const second = await v11Call(action, id, tidEntry.t);
  if (second.transport || second.error) return { error: second.error || '直连失败', transport: true };
  try {
    const { [TID_KEY]: p2 } = await chrome.storage.local.get(TID_KEY);
    await chrome.storage.local.set({
      [TID_KEY]: globalThis.RFTidPool.markResult(p2 || [], tidEntry.t, tidEntry.p || '/i/api/1.1/friendships/create.json', true, Date.now()),
    });
  } catch {}
  return { status: second.status, ok: second.ok, body: second.body, rl: second.rl, via: 'pool-tid' };
}
async function route1Follow(userId) { return route1Friendship('create', userId); }
async function route1Unfollow(userId) { return route1Friendship('destroy', userId); }

async function followProbe(handle) {
  const h = String(handle || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return { ok: false, error: 'handle 不合法' };
  const u = await route1Graphql('UserByScreenName', { screen_name: h });
  let userId = null;
  if (u && u.ok) {
    try { userId = JSON.parse(u.body).data.user.result.rest_id; } catch {}
  }
  if (!userId) {
    return { ok: false, error: `拿不到 @${h} 的 user_id(${u && u.error ? u.error : 'HTTP ' + (u && u.status)})——先在 x.com 打开一次该用户的主页(让页面旁听到模板)再重试` };
  }
  const { [TID_KEY]: pool } = await chrome.storage.local.get(TID_KEY);
  const tidEntry = (pool || []).slice().sort((a, b) => b.at - a.at)[0];
  const attempts = [];
  for (const [label, tid] of [['无tid', null], ['带池内tid(跨路径)', tidEntry && tidEntry.t]]) {
    const a = { set: label, tid: tid ? `龄${Math.round((Date.now() - tidEntry.at) / 1000)}s` : null };
    const c = await v11Call('create', userId, tid);
    a.create = c.status != null ? `HTTP ${c.status}` : c.error;
    if (c.ok) {
      const d = await v11Call('destroy', userId, tid);
      a.destroy = d.status != null ? `HTTP ${d.status}` : d.error;
      a.netZero = d.ok;
    } else {
      a.body = (c.body || '').slice(0, 200);
    }
    attempts.push(a);
    if (a.netZero || c.status === 429) break;
  }
  const win = attempts.find((a) => a.netZero);
  return {
    ok: !!win,
    userId,
    attempts,
    verdict: win
      ? `✅ 直连可用(${win.set})——生产路径已切 Route 1, 传输失败才页面重放`
      : '❌ 无可用形态——生产仍会试 Route 1, 失败兑底页面重放',
  };
}

// SW 冷启动仅在无活跃账号时探一次(识别是最贵状态; 已识别的靠 popup/控制台打开时保鲜)。
// 闸门在 storage, 跨重启生效——即使触发也只是读一次闸门, 不会叠发请求
if (!hasActive()) identityProbe().catch(() => {});

const TID_KEY = globalThis.RF.KEY.tidPool;
let tidWriteInFlight = false;

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    try {
      const hs = details.requestHeaders || [];
      const tidH = hs.find((h) => h.name.toLowerCase() === 'x-client-transaction-id');
      if (!tidH || !tidH.value || tidH.value.length < 60) return;
      const path = new URL(details.url).pathname;
      // bearer 仍见啥收啥(常量, 与 tid 白名单无关)
      const auth = hs.find((h) => h.name.toLowerCase() === 'authorization');
      if (auth && auth.value && auth.value.startsWith('Bearer ')) {
        chrome.storage.local.get(RF.KEY.bearer).then(({ [RF.KEY.bearer]: old }) => {
          if (old !== auth.value) chrome.storage.local.set({ [RF.KEY.bearer]: auth.value });
        }).catch(() => {});
      }
      // 旁听到回关 REST → 记兑底材料就绪(控制台就绪清单用; 不依赖 page-hook)
      if (path === '/i/api/1.1/friendships/create.json') {
        chrome.storage.local.set({ [RF.KEY.followTplSeen]: Date.now() }).catch(() => {});
      }
      // tid 只收 Route 1 会用的路径(挡 timeline / avatar_content / viewer_context 等噪声)
      if (!globalThis.RFTidPool.shouldHarvest(path)) return;
      // 写入串行化: 写进行中时丢弃本次(同页面批量请求会重复触发, 页面持续产 tid, 丢一两条无妨)
      if (tidWriteInFlight) return;
      tidWriteInFlight = true;
      chrome.storage.local.get(TID_KEY)
        .then(({ [TID_KEY]: pool }) =>
          chrome.storage.local.set({ [TID_KEY]: globalThis.RFTidPool.add(pool || [], tidH.value, path, Date.now()) }))
        .catch(() => {}).finally(() => { tidWriteInFlight = false; });
    } catch {}
  },
  { urls: ['https://x.com/i/api/*'] },
  ['requestHeaders']
);

// 控制台宿主端口: 断开时若无其它控制台连接, 发一次「请保持控制台打开」通知(循环靠心跳自行停)
let consolePorts = 0;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'console-host') return;
  consolePorts++;
  port.onDisconnect.addListener(() => {
    consolePorts = Math.max(0, consolePorts - 1);
    if (consolePorts === 0) {
      notify('console-host-gone', 'XFollowBack 控制台已关闭', '关注循环已离开宿主——重新打开控制台即可继续');
    }
  });
});

// 热升级后清一次池内噪声(timeline 等旧条目), 避免占满白名单名额
chrome.storage.local.get(TID_KEY).then(({ [TID_KEY]: pool }) => {
  const cleaned = globalThis.RFTidPool.prune(pool || []);
  if (cleaned.length !== (pool || []).length) {
    chrome.storage.local.set({ [TID_KEY]: cleaned }).catch(() => {});
  }
}).catch(() => {});

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
async function route1Graphql(op, vars) {
  const tplKey = TPL_PREFIX + op;
  const { [tplKey]: tpl } = await chrome.storage.local.get(tplKey);
  if (!tpl || !tpl.p || !tpl.v0) return { error: `rf_tpl:${op} 模板未旁听到或缺变量形状` };
  const { [RF.KEY.bearer]: bearer } = await chrome.storage.local.get(RF.KEY.bearer);
  if (!bearer) return { error: 'bearer 未收割' };
  const ck = await chrome.cookies.get({ url: 'https://x.com/', name: 'ct0' });
  if (!ck || !ck.value) return { error: '读不到 ct0 cookie' };
  const { [TID_KEY]: pool0 } = await chrome.storage.local.get(TID_KEY);
  let pool = pool0 || [];
  // GraphQL 只取同路径(跨路径不对称: Search→Detail 可行、Detail→Search 404, 见 ADR-0004)
  const tidEntry = globalThis.RFTidPool.pick(pool, { path: tpl.p, cooldownMs: RF.AF.TID_COOLDOWN_MS });
  if (!tidEntry) {
    // harvestBoost 只开搜索小窗收 SearchTimeline tid; Following 等同路径帮不上, 改提示用户开页旁听
    if (op === 'Following') {
      bgLog('池见底(Following): 自动搜索供血帮不上——请打开自己的 /following 页面并等加载完, 旁听补同路径 tid(约70秒冷却后可用)').catch(() => {});
    } else {
      harvestBoost('池见底').catch(() => {}); // 异步供血(本发照常报错走回退, 下几发受益)
    }
    return { error: '池中无同路径可用 tid(全在冷却)' };
  }
  // 变量 = 首见形状 + 补丁(null 值删键: cursor 缺省/screen_name 等由调用方表达)
  const variables = globalThis.RFRoute1.mergeVariables(tpl.v0, vars);
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
  // 任何拿到 HTTP 响应的发射都记 ok 进入冷却换下一条:
  //   422/429 已被 X 处理过(实测后再用同 tid → 404);
  //   404 空体本身就表示该 tid 此刻不可用——若不记 ok, pick 会因 at 已过期立刻重选同一条连打 404。
  pool = globalThis.RFTidPool.markResult(pool, tidEntry.t, tidEntry.p, true, Date.now());
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
const XP_STATE_KEY = 'rf_xp_tid_probe'; // 跨路径 tid 对照进度
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
    pool = globalThis.RFTidPool.markResult(pool, tidEntry.t, tidEntry.p, res.ok, Date.now());
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

// ---------- GraphQL 跨路径 tid 对照实验(ADR-0004 待放行) ----------
// 目标 op 的模板 + minimal 三件套, 连发:
//   ①同路径 tid(基线, 若有) ②异路径 tid(实验组, 必需)
// 结论写 verdict: cross-ok / cross-reject / inconclusive; 不改生产 pick。
async function crosspathTidProbe(op, variables) {
  const steps = [];
  const t0 = Date.now();
  const step = (name, info) => {
    steps.push({ at: Date.now() - t0, name, info: info || '' });
    return chrome.storage.local.set({ [XP_STATE_KEY]: { done: false, steps } }).catch(() => {});
  };
  const finish = (result) =>
    chrome.storage.local.set({ [XP_STATE_KEY]: Object.assign({ done: true, steps }, result) }).catch(() => {});

  const name = String(op || '').trim() || 'TweetDetail';
  await step('读模板', name);
  const tplKey = TPL_PREFIX + name;
  const { [tplKey]: tpl } = await chrome.storage.local.get(tplKey);
  if (!tpl || !tpl.p || !tpl.v0) {
    const r = { ok: false, error: `未旁听到 ${name} 模板——先在 x.com 触发一次该查询` };
    await finish(r);
    return r;
  }
  const { [RF.KEY.bearer]: bearer } = await chrome.storage.local.get(RF.KEY.bearer);
  if (!bearer) {
    const r = { ok: false, error: 'bearer 未收割——打开任意 x.com' };
    await finish(r);
    return r;
  }
  const ck = await chrome.cookies.get({ url: 'https://x.com/', name: 'ct0' }).catch(() => null);
  if (!ck || !ck.value) {
    const r = { ok: false, error: '读不到 ct0 cookie——确认已登录 x.com' };
    await finish(r);
    return r;
  }

  const { [TID_KEY]: pool0 } = await chrome.storage.local.get(TID_KEY);
  let pool = pool0 || [];
  const cd = RF.AF.TID_COOLDOWN_MS;
  const same = globalThis.RFTidPool.pick(pool, { path: tpl.p, cooldownMs: cd });
  const cross = globalThis.RFTidPool.pickCrossPath(pool, { notPath: tpl.p, cooldownMs: cd });
  await step('挑 tid', `同路径${same ? '有' : '无'} · 异路径${cross ? pathTail(cross.p) : '无'}`);
  if (!cross) {
    const r = {
      ok: false,
      error: '池中无异路径可用 tid——先旁听别的 GraphQL(如 SearchTimeline / Following), 等冷却后再试',
      targetPath: tpl.p,
      tidPoolSize: pool.length,
    };
    await finish(r);
    return r;
  }

  const vars = globalThis.RFRoute1.mergeVariables(tpl.v0, variables || {});
  let req;
  try { req = globalThis.RFRoute1.buildRequest(tpl, vars); }
  catch (e) {
    const r = { ok: false, error: '构造请求失败: ' + String((e && e.message) || e) };
    await finish(r);
    return r;
  }

  async function fire(label, tidEntry) {
    const headers = globalThis.RFRoute1.headerSets(tpl.h, bearer, ck.value, tidEntry.t, req.isPost).minimal;
    await step(label + ' 发射', `tid←${pathTail(tidEntry.p)} 龄${Math.round((Date.now() - tidEntry.at) / 1000)}s`);
    const f0 = Date.now();
    const ac = new AbortController();
    const kill = setTimeout(() => ac.abort(), R1_FETCH_TIMEOUT_MS);
    let res, body;
    try {
      res = await fetch(req.url, { method: req.method, headers, credentials: 'include', body: req.body, signal: ac.signal });
      body = await res.text();
    } catch (e) {
      clearTimeout(kill);
      const msg = String((e && e.message) || e) + (ac.signal.aborted ? '(>20s)' : '');
      await step(label + ' 网络异常', msg);
      return { set: label, error: '网络异常: ' + msg, donorPath: tidEntry.p };
    }
    clearTimeout(kill);
    // 冷却记在 tid 原捕获路径上(异路径发射成功也要让该条进入冷却)
    pool = globalThis.RFTidPool.markResult(pool, tidEntry.t, tidEntry.p, true, Date.now());
    const a = {
      set: label, status: res.status, ok: res.ok, ms: Date.now() - f0,
      bodyLen: body.length, head: body.slice(0, 120),
      donorPath: tidEntry.p, tidReject: res.status === 404 && String(body || '').trim().length === 0,
    };
    await step(label + ' 返回', `HTTP ${res.status} ${body.length}B ${a.ms}ms${a.tidReject ? '(疑似 tid 拒收)' : ''}`);
    return a;
  }

  const attempts = [];
  if (same) {
    attempts.push(await fire('同路径基线', same));
    if (attempts[0].status === 429) {
      await chrome.storage.local.set({ [TID_KEY]: pool });
      const r = {
        ok: false, verdict: 'inconclusive', error: '同路径基线已 429, 桶热不宜再发跨路径',
        attempts, targetPath: tpl.p, targetOp: name,
      };
      await finish(r);
      return r;
    }
  } else {
    await step('跳过同路径基线', '池中无同路径可用 tid(不影响跨路径结论)');
  }

  // 基线后重新挑异路径(避免刚好被基线同 tid 撞上; 通常路径不同)
  const cross2 = globalThis.RFTidPool.pickCrossPath(pool, { notPath: tpl.p, cooldownMs: cd }) || cross;
  attempts.push(await fire('跨路径实验', cross2));
  await chrome.storage.local.set({ [TID_KEY]: pool });

  const crossA = attempts.find((a) => a.set === '跨路径实验');
  const sameA = attempts.find((a) => a.set === '同路径基线');
  let verdict = 'inconclusive';
  let ok = false;
  if (crossA && crossA.ok) {
    verdict = 'cross-ok';
    ok = true;
  } else if (crossA && crossA.tidReject) {
    verdict = 'cross-reject';
  } else if (crossA && crossA.status != null) {
    verdict = 'cross-other'; // 有 HTTP 但非 200 且非空 404——可能是业务/模板问题, 不宜直接否决跨路径
  }

  const r = {
    ok,
    verdict,
    verdictText: ({
      'cross-ok': '✅ 这一对方向可用(donor→目标)——跨路径有向, 勿推广为无向兑底',
      'cross-reject': '❌ 这一对方向拒收(404 空 body)——生产 GraphQL 维持同路径 pick',
      'cross-other': '⚠ 非 tid 拒收形态——看 attempts 再判(可能模板/变量/限流)',
      'inconclusive': '⚠ 结论不足',
    })[verdict] || verdict,
    attempts,
    baselineOk: !!(sameA && sameA.ok),
    targetOp: name,
    targetPath: tpl.p,
    tidPoolSize: pool.length,
  };
  await finish(r);
  return r;
}

function pathTail(p) {
  return String(p || '').split('/').pop() || '(空)';
}
