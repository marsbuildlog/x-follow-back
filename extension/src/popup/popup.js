// Popup: 一眼看清核心数字(待回关), 附状态与今日进度; 操作入口在控制台。
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const PAUSE_TEXT = {
    manual: '手动', stalled: '连续失败', 'daily-limit': '今日已达上限',
    'template-expired': '模板过期', error: '连续异常',
  };
  // 状态 → 文案/圆点色(与页面悬浮控件一致)
  const STATE_TEXT = { idle: '未启动', running: '运行中', done: '等待新粉' };

  async function render() {
    const { rf_active: h } = await chrome.storage.local.get('rf_active');
    const dot = $('dot');
    if (!h) {
      $('handle').textContent = '—';
      $('state').textContent = '未启动(先打开 x.com 认证粉丝页)';
      $('pending').textContent = '–';
      $('total').textContent = '';
      $('today').textContent = '';
      return;
    }
    const tk = `rf_task:${h}`, dk = `rf_daily:${h}`;
    const [{ [tk]: t, [dk]: d }, { rf_fetch_progress: fp }] = await Promise.all([
      chrome.storage.local.get([tk, dk]),
      chrome.storage.local.get('rf_fetch_progress'),
    ]);
    const today = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ds = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const daily = d && d.date === ds ? d : { followed: 0 };
    const q = (t && t.queue) || [];
    const pending = q.filter((i) => i.status === 'pending').length;

    $('handle').textContent = '@' + h;
    let key = t ? t.state : 'idle';
    let color = '#536471';
    let text = STATE_TEXT[key] || key;
    if (t && t.state === 'paused') {
      text = '已暂停 · ' + (PAUSE_TEXT[t.pauseReason] || t.pauseReason);
      color = t.pauseReason === 'template-expired' ? '#dc2626' : '#d97706';
      key = 'paused';
    } else if (t && t.state === 'running') { color = '#1d9bf0'; }
    else if (t && t.state === 'done') { color = '#16a34a'; }
    dot.style.background = color;
    const fetching = fp ? ` · 拉取中(第${fp.page}页)` : '';
    const resumeAt = t && t.state === 'paused' && t.nextAutoResumeAt
      ? ` · ${Math.max(0, Math.round((t.nextAutoResumeAt - Date.now()) / 60000))}分钟后自动恢复` : '';
    $('state').textContent = text + fetching + resumeAt;
    $('pending').textContent = String(pending);
    $('total').textContent = `总数 ${q.length}`;
    $('today').textContent = `今日已回关 ${daily.followed}`;
  }

  $('open').onclick = () => chrome.runtime.openOptionsPage();

  // 使用说明(博客项目页)
  $('guide').onclick = () => chrome.tabs.create({ url: 'https://marsbuildlog.github.io/refollow/' });

  // 用户名 → 拼接并打开认证粉丝页(新用户只需填自己的用户名)
  const openFollowPage = () => {
    const name = ($('quick-handle').value || '').trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) {
      $('quick-handle').style.borderColor = '#dc2626';
      return;
    }
    chrome.tabs.create({ url: `https://x.com/${name}/verified_followers` });
  };
  $('btn-open-vf').onclick = openFollowPage;
  $('quick-handle').addEventListener('keydown', (e) => { if (e.key === 'Enter') openFollowPage(); });
  $('quick-handle').addEventListener('input', () => { $('quick-handle').style.borderColor = '#cbd3d9'; });
  // 预填最近活跃账号
  chrome.storage.local.get('rf_active').then(({ rf_active: h }) => { if (h) $('quick-handle').value = h; });

  // 开发模式(本地目录导入, manifest 无 update_url)才显示重载按钮
  const isDev = !chrome.runtime.getManifest().update_url;
  const reloadBtn = $('reload');
  if (isDev) {
    reloadBtn.style.display = ''; // 标题栏右上角 ↻ 图标
    reloadBtn.onclick = async () => {
      // 留标记给重启后的 service worker: 把所有 x.com 标签页一起刷新,
      // 免去每次手动 chrome://extensions 刷新 + 手动刷新 x.com
      await chrome.storage.local.set({ rf_reload_tabs: true });
      chrome.runtime.reload();
    };
  }
  render();
  chrome.storage.onChanged.addListener(render);
})();
