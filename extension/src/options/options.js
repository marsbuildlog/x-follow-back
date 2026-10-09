// 控制台逻辑: 展示任务状态/队列/日志, 把操作转发给 x.com 标签页的 content script。
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const PAUSE_TEXT = {
    manual: '手动', stalled: '连续失败', 'daily-limit': '今日已达上限',
    'template-expired': '模板过期', error: '连续异常',
  };
  const MAX_ROWS = 200; // 队列表单次最多渲染行数(防大账号卡死页面)

  let targetTabId = null;
  let curTab = 'todo'; // 队列 tab: todo(待处理+失败) | done(已完成)
  let opTimer = null;

  // 插件被 reload 后本页会变成孤儿(chrome.* 全部失效), 需要刷新本页才能恢复
  function isOrphaned() {
    try { chrome.runtime.getURL(''); return false; } catch { return true; }
  }

  async function findXTab() {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
      if (!tabs.length) return null;
      // 多个 x.com 标签页时优先认证粉丝页(任务页), 其余场景取第一个
      return tabs.find((t) => /\/verified_followers/.test(t.url || '')) || tabs[0];
    } catch {
      return null;
    }
  }
  async function send(cmd, extra = {}) {
    if (targetTabId == null) return { ok: false, message: '未找到 x.com 标签页' };
    try {
      return await chrome.tabs.sendMessage(targetTabId, { cmd, ...extra });
    } catch (e) {
      return { ok: false, message: '发送失败(页面可能刚打开, 稍后重试): ' + e.message };
    }
  }

  // 操作结果内联提示(几秒后消失)
  function showOp(text) {
    const el = $('op-result');
    el.textContent = text;
    el.style.color = /失败|错误|未/.test(text) ? '#b02a37' : '#1b5e20';
    clearTimeout(opTimer);
    opTimer = setTimeout(() => { el.textContent = ''; }, 5000);
  }

  // ---------- 内容脚本自动接入 ----------
  // x.com 页面在插件安装/重载之前打开时, 内容脚本不在(或已是孤儿)——控制台拿不到任务状态。
  // 连续两次无响应(避开页面刚打开、脚本还在初始化的竞态)后, 用 scripting API 补注入:
  // 先 MAIN world 恢复请求捕获(page-hook 自带去重守卫), 再隔离世界接管 UI 与任务。
  let deadPings = 0;
  let lastInjectAt = 0;
  async function injectContentScript(tab) {
    if (Date.now() - lastInjectAt < 10_000) return;
    lastInjectAt = Date.now();
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/page-hook.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/content.js'] });
    } catch {}
  }

  // ---------- 渲染 ----------
  const statusPill = (s) => `<span class="pill st-${s}">${s === 'pending' ? '待处理' : s === 'failed' ? '失败' : s === 'done' ? '完成' : s}</span>`;

  async function render() {
    if (isOrphaned()) {
      const warn = $('tab-warn');
      warn.style.display = 'block';
      warn.textContent = '插件已更新——请按 F5 刷新本页, 恢复控制台功能。';
      return;
    }
    const tab = await findXTab();
    targetTabId = tab ? tab.id : null;
    $('tab-warn').style.display = tab ? 'none' : 'block';

    // 任务状态行
    const task = targetTabId != null ? await send('get-task') : null;
    if (task && task.state) {
      deadPings = 0;
      const q = task.queue || [];
      const counts = { pending: 0, failed: 0, done: 0, skipped: 0 };
      for (const i of q) counts[i.status] = (counts[i.status] || 0) + 1;
      const daily = (task.daily && task.daily.followed) || 0;
      const tpl = task.templateCaptured === true
        ? '<span style="color:#1b5e20">已捕获 ✓</span>'
        : task.templateCaptured === false
          ? '<span style="color:#b02a37">未捕获 ⚠ 打开认证粉丝页点一次「回关」</span>'
          : '?';
      const { rf_fetch_progress: fp } = await chrome.storage.local.get('rf_fetch_progress');
      const fetchChip = fp ? ` · <span style="color:#7c3aed;font-weight:700">拉取中(第${fp.page}/${fp.maxPages}页, 累计${fp.users})</span>` : '';
      $('task-state').innerHTML =
        `账号: @${esc(task.screenName || '?')} · 状态: <b>${task.state === 'done' ? '等待新粉' : task.state === 'running' ? '运行中' : task.state}</b>${task.pauseReason ? '(' + (PAUSE_TEXT[task.pauseReason] || task.pauseReason) + ')' : ''}` +
        ` · 总数: ${q.length} · 待回关: ${counts.pending} · 今日已回关: ${daily}` +
        (task.lastFetchAt ? ` · 上次拉取: ${new Date(task.lastFetchAt).toLocaleTimeString()}` : '') +
        ` · 回关模板: ${tpl}${fetchChip}` +
        (task.lastError ? `<br>最近错误: <span style="color:#b02a37">${esc(task.lastError)}</span>` : '');

      // 队列(两个 tab: 待处理/失败 | 已完成)
      $('cnt-todo').textContent = `(${counts.pending + counts.failed})`;
      $('cnt-done').textContent = `(${counts.done})`;
      const rows = q.filter((i) => curTab === 'done' ? i.status === 'done' : (i.status === 'pending' || i.status === 'failed'));
      $('queue-table').querySelector('tbody').innerHTML = rows
        .slice(0, MAX_ROWS)
        .map((i) =>
          `<tr><td>${statusPill(i.status)}</td><td>@${esc(i.screenName || i.userId)}</td><td>${esc(i.name)}</td><td>${esc(i.error)}</td><td>${i.doneAt ? new Date(i.doneAt).toLocaleString() : ''}</td></tr>`
        )
        .join('');
      $('queue-summary').textContent =
        (rows.length > MAX_ROWS ? `仅显示前 ${MAX_ROWS} 条 / 共 ${rows.length} 条 · ` : '') +
        `跳过(已关注) ${counts.skipped} 项不列出`;
    } else if (tab) {
      // 标签页在, 但拿不到任务状态: 区分「脚本在线但无活跃账号」和「脚本未接管」
      const clearQueue = () => {
        $('cnt-todo').textContent = '';
        $('cnt-done').textContent = '';
        $('queue-table').querySelector('tbody').innerHTML = '';
        $('queue-summary').textContent = '';
      };
      if (task === null) {
        // content script 在线, 只是还没有活跃账号(get-task 返回 null)
        deadPings = 0;
        $('task-state').textContent = '状态: 未启动(先在上方输入用户名打开认证粉丝页)';
        clearQueue();
      } else {
        deadPings++;
        if (deadPings >= 2) await injectContentScript(tab);
        $('task-state').innerHTML =
          'x.com 标签页已打开, 但插件尚未接管(页面可能早于插件安装/重载)。正在自动注入…' +
          '若约10秒后仍是本行, 请手动刷新该 x.com 标签页(F5)。' +
          (task && task.message ? `<br><span style="color:#b02a37">${esc(task.message)}</span>` : '');
        clearQueue();
      }
    } else {
      deadPings = 0;
      $('task-state').textContent = '状态: 未知(无 x.com 标签页)';
      $('cnt-todo').textContent = '';
      $('cnt-done').textContent = '';
      $('queue-table').querySelector('tbody').innerHTML = '';
      $('queue-summary').textContent = '';
    }

    // 日志(用户翻看历史时不强制拉底, 在底部附近才自动跟随)
    const logEl = $('log');
    const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    const { rf_log: logs } = await chrome.storage.local.get('rf_log');
    logEl.textContent = (logs || []).map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.text}`).join('\n') || '（暂无日志）';
    if (nearBottom || !logEl.dataset.inited) {
      logEl.scrollTop = logEl.scrollHeight;
      logEl.dataset.inited = '1';
    }
  }

  // ---------- 设置(精简: 仅暴露常用项, 其余用内置默认值) ----------
  async function loadSettings() {
    const { rf_settings: s } = await chrome.storage.local.get('rf_settings');
    const v = { ...RF.DEFAULTS, ...(s || {}) };
    $('s-intervalMin').value = v.intervalMin;
    $('s-intervalMax').value = v.intervalMax;
    $('s-autoFetchMin').value = v.autoFetchMin;
  }
  async function saveSettings() {
    await chrome.storage.local.set({
      rf_settings: {
        intervalMin: +$('s-intervalMin').value || RF.DEFAULTS.intervalMin,
        intervalMax: +$('s-intervalMax').value || RF.DEFAULTS.intervalMax,
        autoFetchMin: +$('s-autoFetchMin').value || RF.DEFAULTS.autoFetchMin,
      },
    });
    const el = $('settings-result');
    el.textContent = '已保存 ✓';
    setTimeout(() => { el.textContent = ''; }, 3000);
  }

  // ---------- 按钮 ----------
  // 任务操作(启动/更新/暂停/恢复)都在认证粉丝页悬浮控件上, 控制台只留重置
  $('btn-reset').onclick = async () => {
    if (!confirm('确定重置任务? 当前账号的队列与进度将被清空。')) return;
    await send('reset-task');
    showOp('已重置');
    render();
  };
  $('btn-save-settings').onclick = saveSettings;

  // ---------- 队列 tab 切换 ----------
  document.querySelectorAll('.tab').forEach((b) => {
    b.onclick = () => {
      curTab = b.dataset.tab;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
      render();
    };
  });

  // ---------- 无 x.com 标签页时: 用户名 → 打开认证粉丝页 ----------
  const openFollowPage = () => {
    const input = $('quick-handle');
    const name = (input.value || '').trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) { input.style.borderColor = '#dc2626'; return; }
    chrome.tabs.create({ url: `https://x.com/${name}/verified_followers` });
  };
  $('btn-quick-open').onclick = openFollowPage;
  $('quick-handle').addEventListener('keydown', (e) => { if (e.key === 'Enter') openFollowPage(); });
  $('quick-handle').addEventListener('input', (e) => { e.target.style.borderColor = '#cbd3d9'; });
  chrome.storage.local.get('rf_active').then(({ rf_active: h }) => { if (h) $('quick-handle').value = h; });

  // ---------- 初始化 ----------
  loadSettings().then(render);
  setInterval(render, 5000);
  chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') render(); });
})();
