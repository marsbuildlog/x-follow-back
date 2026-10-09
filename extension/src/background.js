// MV3 service worker: 长任务不在这里跑, 全部在 x.com 标签页的 content script 内执行。
// 职责:
//   1. 开发模式下 popup 点「重载插件」后, 刷新跑任务的认证粉丝页 + 当前活跃的 x.com 页
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
      notify('tab-closed', 'Refollow 已暂停', 'x.com 页面已关闭, 自动回关已停止; 重新打开认证粉丝页会自动继续');
    }
  } catch {}
});

// SW 启动即执行(runtime.reload() 后 Chrome 会拉起新 SW)
function notify(tag, title, message) {
  try {
    const p = chrome.notifications.create('refollow-' + tag, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/128.png'),
      title: title || 'Refollow',
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
  console.log('[Refollow] installed');
});
