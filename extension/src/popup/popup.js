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
  // 智能时刻: 今天只显 HH:mm, 跨天带日期(与控制台 fmtWhen 同款)
  const fmtWhen = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    return d.toDateString() === new Date().toDateString() ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  };

  async function render() {
    const r = await chrome.storage.local.get(['rf_active', 'rf_loop_wait']);
    const h = r.rf_active;
    const lwRaw = r.rf_loop_wait;
    const lw = lwRaw && lwRaw.until > Date.now() ? lwRaw : null;
    const lwText = lw ? ` · ${lw.text}, ${fmtWhen(lw.until)} 前自动继续` : '';
    const dot = $('dot');
    if (!h) {
      $('handle').textContent = '—';
      $('state').textContent = '未识别账号——打开 x.com 登录后自动识别';
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
    $('state').textContent = text + fetching + resumeAt + lwText;
    $('pending').textContent = String(pending);
    $('total').textContent = `总数 ${q.length}`;
    $('today').textContent = `今日已回关 ${daily.followed}`;
  }

  $('open').onclick = () => chrome.runtime.openOptionsPage();

  // 使用说明(仓库 how2use 文档)
  $('guide').onclick = () => chrome.tabs.create({ url: 'https://github.com/marsbuildlog/x-follow-back/blob/main/docs/how2use.md' });

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
  // 打开弹窗顺带触发一次身份识别(失败走负缓存, 不会扛请求)
  try { chrome.runtime.sendMessage({ cmd: 'identity-probe' }); } catch {}
  chrome.storage.onChanged.addListener(render);
})();
