(() => {
  'use strict';
  const render = async () => {
    // 按账号分键: 通过 rf_active 定位最近活跃账号
    const { rf_active: h } = await chrome.storage.local.get('rf_active');
    if (!h) {
      document.getElementById('today').textContent = '0';
      document.getElementById('state').textContent = '任务: 未启动';
      return;
    }
    const tk = `rf_task:${h}`, dk = `rf_daily:${h}`;
    const data = await chrome.storage.local.get([tk, dk]);
    const t = data[tk];
    const d = data[dk];
    const today = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ds = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const daily = d && d.date === ds ? d : { followed: 0 };
    document.getElementById('today').textContent = `${daily.followed}`;
    const stateText = t ? (t.state === 'done' ? '等待新粉' : t.state) : '未启动';
    document.getElementById('state').textContent =
      `@${h} · 任务: ${stateText}${t && t.pauseReason ? '(' + t.pauseReason + ')' : ''}`;
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
