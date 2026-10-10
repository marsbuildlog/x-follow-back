// MV3 service worker: 长任务不在这里跑, 全部在 x.com 标签页的 content script 内执行。
// 职责:
//   0. tid 收割池(ADR-0004): 旁听 x.com 页面自己的 API 请求头, 收集页面产生的
//      x-client-transaction-id 入 rf_tid_pool(带路径标签), 重放侧按路径取用轮换;
//      顺带收集 graphql 模板(queryId/features/bearer)——Route 1(脱离页面直连)的运输材料
//      (扩展重启后所有旧 content script 变孤儿, 页面必须刷新才能重新注入;
//       其余 x.com 页不刷, 避免丢失页面内状态如草稿)
//   2. 代理系统通知(chrome.notifications 仅扩展页面可用, content script 无权调用)

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.cmd !== 'notify') return;
  notify(msg.tag || String(Date.now()), msg.title, msg.message);
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
importScripts('shared/constants.js', 'shared/tidpool.js');

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
        chrome.storage.local.get('rf_bearer').then(({ rf_bearer }) => {
          if (rf_bearer !== auth.value) chrome.storage.local.set({ rf_bearer: auth.value });
        }).catch(() => {});
      }
    } catch {}
  },
  { urls: ['https://x.com/i/api/*'] },
  ['requestHeaders']
);

// graphql 模板旁听(Route 1 运输材料): op → {path, queryId, method, features, 首见变量形状}。
// X 轮换 queryId 时自动续鲜; 变量逐请求都变, 只存首见形状供参考, 不作为写入条件。
const TPL_PREFIX = 'rf_tpl:';
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const u = new URL(details.url);
      const op = u.pathname.split('/').pop();
      if (!op) return;
      const tplKey = TPL_PREFIX + op;
      const q = u.pathname.split('/')[4] || ''; // /i/api/graphql/<queryId>/<op>
      let features = null;
      let v0 = null;
      if (details.method === 'GET') {
        try { v0 = JSON.parse(u.searchParams.get('variables') || 'null'); } catch {}
      } else {
        const raw = details.requestBody && details.requestBody.raw && details.requestBody.raw[0];
        if (raw && raw.bytes) {
          try {
            const body = JSON.parse(new TextDecoder().decode(raw.bytes));
            features = body.features || null;
            v0 = body.variables || null;
          } catch {}
        }
      }
      chrome.storage.local.get(tplKey).then(({ [tplKey]: old }) => {
        // queryId 与 features 都没变就不写(避免每次滚动都写 storage)
        if (old && old.q === q && JSON.stringify(old.f) === JSON.stringify(features)) return;
        return chrome.storage.local.set({ [tplKey]: { p: u.pathname, q, m: details.method, f: features, v0, at: Date.now() } });
      }).catch(() => {});
    } catch {}
  },
  { urls: ['https://x.com/i/api/graphql/*'] },
  ['requestBody']
);
