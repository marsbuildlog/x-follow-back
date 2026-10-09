// 控制台逻辑: 展示任务状态/队列/日志, 把操作转发给 x.com 标签页的 content script。
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const raw = (title, data) => { $('raw').textContent = `===== ${title} =====\n` + JSON.stringify(data, null, 2).slice(0, 50_000); };

  let targetTabId = null;

  async function findXTab() {
    const tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
    return tabs.length ? tabs[0] : null;
  }
  async function send(cmd, extra = {}) {
    if (targetTabId == null) return { ok: false, message: '未找到 x.com 标签页' };
    try {
      return await chrome.tabs.sendMessage(targetTabId, { cmd, ...extra });
    } catch (e) {
      return { ok: false, message: '发送失败(页面可能刚打开, 稍后重试): ' + e.message };
    }
  }

  // ---------- 渲染 ----------
  const statusPill = (s) => `<span class="pill st-${s}">${s}</span>`;
  async function render() {
    const tab = await findXTab();
    targetTabId = tab ? tab.id : null;
    $('tab-warn').style.display = tab ? 'none' : 'block';

    // 任务状态
    const task = targetTabId != null ? await send('get-task') : null;
    if (task && task.state) {
      const q = task.queue || [];
      const counts = {};
      for (const i of q) counts[i.status] = (counts[i.status] || 0) + 1;
      $('task-state').textContent =
        `状态: ${task.state}${task.pauseReason ? '(' + task.pauseReason + ')' : ''}` +
        ` · 队列: 待回关 ${counts.pending || 0} / 已回关 ${counts.done || 0} / 失败 ${counts.failed || 0} / 跳过 ${counts.skipped || 0}` +
        (task.screenName ? ` · 账号: @${task.screenName}` : '');
      const tbody = $('queue-table').querySelector('tbody');
      tbody.innerHTML = q
        .filter((i) => i.status !== 'skipped')
        .map(
          (i) =>
            `<tr><td>${statusPill(i.status)}</td><td>@${i.screenName || i.userId}</td><td>${(i.name || '').replace(/</g, '&lt;')}</td><td>${(i.error || '').replace(/</g, '&lt;')}</td></tr>`
        )
        .join('');
      $('queue-summary').textContent = `跳过(已关注) ${counts.skipped || 0} 项未列出`;
    } else {
      $('task-state').textContent = '状态: 未知(无 x.com 标签页)';
    }

    // 拉取进度
    const { rf_fetch_progress: fp } = await chrome.storage.local.get('rf_fetch_progress');
    $('fetch-progress').textContent = fp
      ? `正在拉取认证粉丝 @${fp.screenName}: 第 ${fp.page}/${fp.maxPages} 页, 累计 ${fp.users} 人…`
      : '';

    // 日志
    const { rf_log: logs } = await chrome.storage.local.get('rf_log');
    $('log').textContent = (logs || []).map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.text}`).join('\n') || '（暂无日志）';
  }

  // ---------- 设置 ----------
  async function loadSettings() {
    const { rf_settings: s } = await chrome.storage.local.get('rf_settings');
    const v = { ...RF.DEFAULTS, ...(s || {}) };
    $('s-dailyLimit').value = v.dailyLimit;
    $('s-intervalMin').value = v.intervalMin;
    $('s-intervalMax').value = v.intervalMax;
    $('s-stallMin').value = v.stallMin;
    $('s-autoResumeMin').value = v.autoResumeMin;
    $('s-rateLimitBackoffMin').value = v.rateLimitBackoffMin;
  }
  async function saveSettings() {
    await chrome.storage.local.set({
      rf_settings: {
        dailyLimit: +$('s-dailyLimit').value || RF.DEFAULTS.dailyLimit,
        intervalMin: +$('s-intervalMin').value || RF.DEFAULTS.intervalMin,
        intervalMax: +$('s-intervalMax').value || RF.DEFAULTS.intervalMax,
        stallMin: +$('s-stallMin').value || RF.DEFAULTS.stallMin,
        autoResumeMin: +$('s-autoResumeMin').value || RF.DEFAULTS.autoResumeMin,
        rateLimitBackoffMin: +$('s-rateLimitBackoffMin').value || RF.DEFAULTS.rateLimitBackoffMin,
      },
    });
    raw('设置已保存', null);
  }

  // ---------- 按钮 ----------
  $('btn-check').onclick = async () => {
    const r = await send('get-captured');
    const ops = (r && r.operations) || [];
    const names = ops.map((o) => o.operationName).join(', ');
    if (r && r.ok === false) {
      $('captured-info').textContent = `与页面通信失败: ${r.message}——请刷新 x.com 标签页后重试`;
    } else if (r && !r.hookVersion) {
      $('captured-info').textContent = '⚠ 页面里跑的还是旧版 hook(无 recent 字段)——请点 popup 里的「↻ 重载插件」, 等页面自动刷新后再试';
    } else {
      $('captured-info').textContent = `已捕获 ${ops.length} 个操作: ${names || '无——请刷新 x.com 页并打开 verified_followers 页面等它加载完'}`;
    }
    const hasFollowApi = (r.apiEndpoints || []).some((e) => e.path === '/i/api/1.1/friendships/create.json');
    const missing = [];
    if (!ops.some((o) => o.operationName === 'BlueVerifiedFollowers')) missing.push('BlueVerifiedFollowers(认证粉丝列表)');
    if (!hasFollowApi) missing.push('friendships/create(回关接口, 在列表里点一次「回关」即可捕获)');
    raw('已捕获接口' + (missing.length ? `(缺少: ${missing.join(', ')})` : '(PoC 关键接口齐全 ✓)'), r);
  };
  $('btn-fetch').onclick = async () => {
    raw('拉取认证粉丝…', '进行中');
    const r = await send('start-task', { screenName: locationSearchHandle() || undefined });
    raw('拉取认证粉丝/启动任务', r);
    render();
  };
  $('btn-follow-one').onclick = async () => {
    raw('关注第 1 个待回关…', '进行中');
    const r = await send('test-follow-one');
    raw('关注结果', r);
    render();
  };
  $('btn-start').onclick = async () => {
    const r = await send('start-task', { screenName: locationSearchHandle() || undefined });
    raw('启动任务', r);
    render();
  };
  $('btn-pause').onclick = async () => { await send('pause-task'); render(); };
  $('btn-refresh').onclick = async () => {
    const r = await send('refresh-list');
    raw('更新列表', r);
  };
  $('btn-resume').onclick = async () => { await send('resume-task'); render(); };
  $('btn-reset').onclick = async () => {
    if (!confirm('确定重置任务? 队列与进度将被清空。')) return;
    await send('reset-task');
    render();
  };
  $('btn-save-settings').onclick = saveSettings;

  function locationSearchHandle() {
    // 尽力从最近浏览的 verified_followers URL 推断 handle——由 content script 自行处理当前页
    return null;
  }

  // ---------- 初始化 ----------
  loadSettings().then(render);
  setInterval(render, 5000);
  chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') render(); });
})();
