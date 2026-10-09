// MV3 service worker: 长任务不在这里跑, 全部在 x.com 标签页的 content script 内执行。
// 职责: 开发模式下 popup 点「重载插件」后, 自动刷新所有 x.com 标签页,
// 使新的 content script 注入生效(等效手动刷新 chrome://extensions + 刷新 x.com)。

// SW 启动即执行(runtime.reload() 后 Chrome 会拉起新 SW)
chrome.storage.local.get('rf_reload_tabs').then(({ rf_reload_tabs }) => {
  if (!rf_reload_tabs) return;
  chrome.storage.local.remove('rf_reload_tabs');
  chrome.tabs.query({ url: 'https://x.com/*' }).then((tabs) => {
    for (const t of tabs) chrome.tabs.reload(t.id);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Refollow] installed');
});
