(() => {
  'use strict';
  const render = async () => {
    const { rf_daily: d, rf_task: t, rf_settings: s } = await chrome.storage.local.get(['rf_daily', 'rf_task', 'rf_settings']);
    const limit = (s && s.dailyLimit) || 400;
    const today = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ds = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const daily = d && d.date === ds ? d : { followed: 0 };
    document.getElementById('today').textContent = `${daily.followed}/${limit}`;
    document.getElementById('state').textContent = t ? `任务: ${t.state}${t.pauseReason ? '(' + t.pauseReason + ')' : ''}` : '任务: 未启动';
  };
  document.getElementById('open').onclick = () => chrome.runtime.openOptionsPage();

  // 开发模式(本地目录导入, manifest 无 update_url)才显示重载按钮
  const isDev = !chrome.runtime.getManifest().update_url;
  const reloadBtn = document.getElementById('reload');
  if (isDev) {
    reloadBtn.style.display = 'block';
    document.getElementById('dev-hint').style.display = 'inline';
    reloadBtn.onclick = async () => {
      // 留标记给重启后的 service worker: 把所有 x.com 标签页一起刷新,
      // 免去每次手动 chrome://extensions 刷新 + 手动刷新 x.com
      await chrome.storage.local.set({ rf_reload_tabs: true });
      chrome.runtime.reload();
    };
  }
  render();
})();
