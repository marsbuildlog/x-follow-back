// 控制台: 任务状态/队列/日志/设置全部直读 chrome.storage(与 popup 同法), 不再依赖 x.com 标签页在线。
// 页面只在两处被问到:
//   ① tpl-captured: 回关模板是否已捕获(只有页面 MAIN world 知道), 异步增补展示, 页面不可达显示 ?
//   ② reset-task:   经由页面清任务, 保证运行中循环下一拍即见空; 页面不可达时控制台直接清 storage
//                   (此时任务必然不在运行, 直接清安全)。
// x.com 页面早于插件安装/重载打开时, 页内 content script 是孤儿——探活失败时用 scripting API
// 补注入(限频), 自动恢复"插件接管页面", 免去手动 F5。
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const PAUSE_TEXT = {
    manual: '手动', stalled: '连续失败', 'daily-limit': '今日已达上限',
    'template-expired': '模板过期', error: '连续异常',
  };
  const MAX_ROWS = 200; // 队列表单次最多渲染行数(防大账号卡死页面)
  const isDev = !chrome.runtime.getManifest().update_url;

  let curTab = 'todo'; // 队列 tab: todo(待处理+失败) | done(已完成)
  let opTimer = null;
  let renderTimer = null;

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

  // 操作结果内联提示(几秒后消失)
  function showOp(text) {
    const el = $('op-result');
    el.textContent = text;
    el.style.color = /失败|错误|未/.test(text) ? '#b02a37' : '#1b5e20';
    clearTimeout(opTimer);
    opTimer = setTimeout(() => { el.textContent = ''; }, 5000);
  }

  // ---------- 渲染 ----------
  const statusPill = (s) => `<span class="pill st-${s}">${s === 'pending' ? '待处理' : s === 'failed' ? '失败' : s === 'done' ? '完成' : s}</span>`;

  // 回关模板徽标: 引导文案只在页面悬浮控件(动作发生地), 这里给短状态 + 悬停提示
  const tplBadge = (captured) =>
    captured === true ? '<span style="color:#1b5e20">已捕获 ✓</span>'
      : captured === false
        ? '<span style="color:#b02a37" title="打开认证粉丝页, 在列表里手动点一次任意用户的「回关」, 插件即完成初始化(页面悬浮控件内有引导)">待初始化 ⚠</span>'
        : '?';

  const todayStr = () => {
    const p = (n) => String(n).padStart(2, '0');
    const t = new Date();
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  };

  function clearQueue() {
    $('cnt-todo').textContent = '';
    $('cnt-done').textContent = '';
    $('queue-table').querySelector('tbody').innerHTML = '';
    $('queue-summary').textContent = '';
  }

  // 模板捕获状态(异步增补, 不阻塞渲染); tplSeq 防过期结果回写
  let tplCaptured;
  let tplSeq = 0;

  // ---------- 初始化三步引导(账号 → 模板 → 启动) + 控制按钮状态 ----------
  const stepMark = (b) => (b ? '✅' : '⬜');
  function renderSetup(h, t, pageOpen) {
    const s1 = h
      ? `${stepMark(true)} <b>账号识别</b> — @${esc(h)}`
      : `${stepMark(false)} <b>账号识别</b> — 打开 x.com 登录后自动识别`;
    let s2;
    if (!h) s2 = `${stepMark(false)} <b>回关模板</b> — 待账号识别`;
    else if (tplCaptured === true) s2 = `${stepMark(true)} <b>回关模板</b> — 已捕获`;
    else if (tplCaptured === false) s2 = `${stepMark(false)} <b>回关模板</b> — ${pageOpen ? '在列表里点一次任意用户的「回关」(仅需一次)' : '打开认证粉丝页, 在列表里点一次任意用户的「回关」'}`;
    else s2 = `${stepMark(false)} <b>回关模板</b> — ${pageOpen ? '检测中…' : '打开认证粉丝页后自动检测'}`;
    const state = t ? t.state : null;
    let s3;
    if (state === 'running') s3 = `${stepMark(true)} <b>启动</b> — 运行中`;
    else if (state === 'done') s3 = `${stepMark(true)} <b>启动</b> — 等待新粉(拉到自动续跑)`;
    else if (state === 'paused') s3 = `${stepMark(false)} <b>启动</b> — 已暂停${t.pauseReason ? '(' + (PAUSE_TEXT[t.pauseReason] || esc(t.pauseReason)) + ')' : ''}, 点「恢复」`;
    else s3 = `${stepMark(false)} <b>启动</b> — ${tplCaptured === true ? '就绪, 点「开始回关」' : '完成②后点「开始回关」'}`;
    $('setup-steps').innerHTML = [s1, s2, s3].join('<br>');
  }

  function updateTaskButtons(t, pageOpen) {
    const state = t ? t.state : null;
    $('btn-start').disabled = state === 'running';
    $('btn-pause').disabled = state !== 'running';
    $('btn-resume').disabled = state !== 'paused';
    $('btn-refresh').disabled = !pageOpen;
    $('btn-reset').disabled = false;
  }

  // 控制按钮: 经消息转发给页面内的任务循环(任务仍宿主在 x.com 页面)
  async function taskAction(cmd) {
    const tab = await findXTab();
    if (!tab) { showOp('未找到 x.com 标签页——先打开认证粉丝页'); return; }
    let res;
    try { res = await chrome.tabs.sendMessage(tab.id, { cmd }); }
    catch (e) { showOp('发送失败(页面可能刚打开, 稍后重试): ' + e.message); return; }
    showOp((res && res.message) || (res && res.ok ? '已执行' : '失败'));
    render();
  }
  $('btn-start').onclick = () => taskAction('start-task');
  $('btn-pause').onclick = () => taskAction('pause-task');
  $('btn-resume').onclick = () => taskAction('resume-task');
  $('btn-refresh').onclick = () => taskAction('refresh-list');

  async function render() {
    if (isOrphaned()) {
      const warn = $('tab-warn');
      warn.style.display = 'block';
      warn.textContent = '插件已更新——请按 F5 刷新本页, 恢复控制台功能。';
      return;
    }
    const { rf_active: h } = await chrome.storage.local.get('rf_active');
    const tab = await findXTab();
    // 横幅只在无 x.com 标签页时出现: 拉取/搜索已 Route 1 直连, 缺页面只影响回关动作
    $('tab-warn').style.display = tab ? 'none' : 'block';

    if (!h) {
      $('task-state').textContent = '状态: 未识别账号——打开 x.com 登录后自动识别';
      clearQueue();
      renderSetup(null, null, !!tab);
      updateTaskButtons(null, !!tab);
    } else {
      const tk = `rf_task:${h}`, dk = `rf_daily:${h}`;
      const [{ [tk]: t, [dk]: d }, { rf_fetch_progress: fp }] = await Promise.all([
        chrome.storage.local.get([tk, dk]),
        chrome.storage.local.get('rf_fetch_progress'),
      ]);
      const daily = d && d.date === todayStr() ? d : { followed: 0 };
      if (t && t.queue) {
        const q = t.queue;
        const counts = { pending: 0, failed: 0, done: 0, skipped: 0 };
        for (const i of q) counts[i.status] = (counts[i.status] || 0) + 1;
        const fetchChip = fp ? ` · <span style="color:#7c3aed;font-weight:700">拉取中(第${fp.page}/${fp.maxPages}页, 累计${fp.users})</span>` : '';
        $('task-state').innerHTML =
          `账号: @${esc(h)} · 状态: <b>${t.state === 'done' ? '等待新粉' : t.state === 'running' ? '运行中' : esc(t.state)}</b>${t.pauseReason ? '(' + (PAUSE_TEXT[t.pauseReason] || esc(t.pauseReason)) + ')' : ''}` +
          ` · 总数: ${q.length} · 待回关: ${counts.pending} · 今日已回关: ${daily.followed}` +
          (t.lastFetchAt ? ` · 上次拉取: ${new Date(t.lastFetchAt).toLocaleTimeString()}` : '') +
          ` · 回关模板: ${tplBadge(tplCaptured)}${fetchChip}` +
          (t.lastError ? `<br>最近错误: <span style="color:#b02a37">${esc(t.lastError)}</span>` : '');

        $('cnt-todo').textContent = `(${counts.pending + counts.failed})`;
        $('cnt-done').textContent = `(${counts.done})`;
        const rows = q.filter((i) => curTab === 'done' ? i.status === 'done' : (i.status === 'pending' || i.status === 'failed'));
        $('queue-table').querySelector('tbody').innerHTML = rows
          .slice(0, MAX_ROWS)
          .map((i) =>
            `<tr><td>${statusPill(i.status)}</td><td>@${esc(i.screenName || i.userId)}</td><td>${esc(i.name)}</td><td>${esc(i.error)}</td><td>${i.doneAt ? new Date(i.doneAt).toLocaleString() : ''}</td></tr>`
          ).join('');
        $('queue-summary').textContent =
          (rows.length > MAX_ROWS ? `仅显示前 ${MAX_ROWS} 条 / 共 ${rows.length} 条 · ` : '') +
          `跳过(已关注) ${counts.skipped} 项不列出`;
        renderSetup(h, t, !!tab);
        updateTaskButtons(t, !!tab);
      } else {
        $('task-state').textContent = `账号: @${h} · 状态: 未启动(打开认证粉丝页后, 在控制台或页面点「开始回关」)`;
        clearQueue();
        renderSetup(h, null, !!tab);
        updateTaskButtons(null, !!tab);
      }
      enrichFromPage();
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

  // 渲染去抖: storage 变化频繁(循环每次关注/日志/tid 入库都写), 合并短窗内的连续触发
  function scheduleRender(delay = 300) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, delay);
  }

  // ---------- 页面增补: 模板捕获状态 + 孤儿自愈 ----------
  // 探活失败(sendMessage 异常)即认为页面内脚本是孤儿(早于插件安装/重载打开), 补注入接管。
  let lastInjectAt = 0;
  async function injectContentScript(tab) {
    if (Date.now() - lastInjectAt < 10_000) return;
    lastInjectAt = Date.now();
    try {
      // 先 MAIN world 恢复请求捕获(page-hook 自带去重守卫), 再隔离世界接管 UI 与任务
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/page-hook.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/content.js'] });
      setTimeout(() => enrichFromPage(), 3000); // 注入完成后复查模板状态
    } catch {}
  }

  async function enrichFromPage() {
    const seq = ++tplSeq;
    const tab = await findXTab();
    if (!tab) return; // 无页面: 模板状态保持 ?, 也无从自愈
    let captured = null;
    let alive = true;
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { cmd: 'tpl-captured' });
      captured = r && r.captured;
    } catch { alive = false; }
    if (seq !== tplSeq) return; // 已有更新的渲染, 丢弃过期结果
    if (captured !== tplCaptured) {
      tplCaptured = captured;
      scheduleRender(0); // 立即重渲染, 带上模板状态
    }
    if (!alive) injectContentScript(tab);
  }

  // ---------- 设置(自动保存: 修改即落盘, 防抖; 互关标签增删同样触发) ----------
  // 互关标签列表: 内存副本, 增删直接改它, 随防抖保存落盘
  let pendingTags = [];

  // 规范化: 只去 # 和首尾空格, 保留原始大小写——搜索词必须与真实 hashtag 一致(#蓝V互关 的大写 V 不能丢);
  // 大小写去重在添加时单独处理
  function normalizeTag(t) {
    return String(t || '').trim().replace(/^#/, '').trim();
  }

  function renderTagChips() {
    const wrap = $('tag-chips');
    if (!pendingTags.length) {
      wrap.innerHTML = '<span class="hint">尚未配置——添加后打开对应 tag 页即可启用主动关注</span>';
      return;
    }
    wrap.innerHTML = pendingTags.map((t, i) =>
      `<span style="display:inline-flex;align-items:center;gap:4px;background:#e8f5fd;color:#0b5ed7;border-radius:10px;padding:2px 10px;font-size:13px">#${esc(t)}` +
      `<button data-rm-tag="${i}" style="margin:0;padding:0 6px;border:none;background:none;color:#0b5ed7;cursor:pointer;font-weight:700">×</button></span>`
    ).join('');
    wrap.querySelectorAll('[data-rm-tag]').forEach((b) => {
      b.onclick = () => { pendingTags.splice(+b.dataset.rmTag, 1); renderTagChips(); scheduleSave(); };
    });
  }

  function addTagFromInput() {
    const input = $('s-tag-input');
    const t = normalizeTag(input.value);
    if (!t) return;
    // 大小写不敏感去重: 已有同名(不同写法)的 tag 时不重复添加
    if (!pendingTags.some((x) => x.toLowerCase() === t.toLowerCase())) pendingTags.push(t);
    input.value = '';
    renderTagChips();
    scheduleSave();
  }

  let saveTimer = null;
  function scheduleSave() {
    $('settings-result').textContent = '保存中…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSettings, 600);
  }

  async function saveSettings() {
    await chrome.storage.local.set({
      rf_settings: {
        intervalMin: +$('s-intervalMin').value || RF.DEFAULTS.intervalMin,
        intervalMax: +$('s-intervalMax').value || RF.DEFAULTS.intervalMax,
        autoFetchMin: +$('s-autoFetchMin').value || RF.DEFAULTS.autoFetchMin,
        tags: pendingTags,
      },
    });
    const el = $('settings-result');
    el.textContent = '已保存 ✓';
    setTimeout(() => { if (el.textContent === '已保存 ✓') el.textContent = ''; }, 2000);
  }

  async function loadSettings() {
    const { rf_settings: s } = await chrome.storage.local.get('rf_settings');
    const v = { ...RF.DEFAULTS, ...(s || {}) };
    $('s-intervalMin').value = v.intervalMin;
    $('s-intervalMax').value = v.intervalMax;
    $('s-autoFetchMin').value = v.autoFetchMin;
    pendingTags = (v.tags || []).map(normalizeTag).filter(Boolean);
    // 存量数据兼容: 旧版本存的是全小写, 保留原样(用户重新添加即可恢复大小写)
    renderTagChips();
  }

  // ---------- 按钮 ----------
  // 重置: 优先经由页面(运行中循环下一拍即见空); 页面脚本不可达时直接清 storage(此时任务必然未在运行)
  $('btn-reset').onclick = async () => {
    if (!confirm('确定重置任务? 当前账号的队列与进度将被清空。')) return;
    const { rf_active: h } = await chrome.storage.local.get('rf_active');
    if (!h) { showOp('无活跃账号, 无任务可重置'); return; }
    const tab = await findXTab();
    let done = false;
    if (tab) {
      try { await chrome.tabs.sendMessage(tab.id, { cmd: 'reset-task' }); done = true; } catch {}
    }
    if (!done) await chrome.storage.local.set({ [`rf_task:${h}`]: null });
    showOp('已重置');
    render();
  };

  $('btn-add-tag').onclick = addTagFromInput;
  $('s-tag-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTagFromInput(); });
  ['s-intervalMin', 's-intervalMax', 's-autoFetchMin'].forEach((id) => {
    $(id).addEventListener('change', scheduleSave); // change(失焦/回车)而非 input: 免得半截数字落盘
  });

  // ---------- 队列 tab 切换 ----------
  document.querySelectorAll('.tab').forEach((b) => {
    b.onclick = () => {
      curTab = b.dataset.tab;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
      render();
    };
  });

  // ---------- 无 x.com 标签页时: 一键回到认证粉丝页(账号自动识别, 无需输入, ADR-0005) ----------
  $('btn-quick-open').onclick = async () => {
    const hint = $('quick-open-hint');
    let { rf_active: h } = await chrome.storage.local.get('rf_active');
    if (!h) {
      hint.textContent = '识别中…(需已登录 x.com)';
      try { await chrome.runtime.sendMessage({ cmd: 'identity-probe' }); } catch {}
      ({ rf_active: h } = await chrome.storage.local.get('rf_active'));
    }
    if (h) {
      hint.textContent = '';
      chrome.tabs.create({ url: `https://x.com/${h}/verified_followers` });
    } else {
      hint.textContent = '未能自动识别——请打开 x.com 并登录, 插件会自动识别账号';
    }
  };

  // ---------- 高级/调试: Route 1 直连对照实验(仅开发模式显示) ----------
  // 实验已过(ADR-0004 amendment: full/minimal 双 200), 循环已切 route1-graphql;
  // 卡片保留是 ADR 指定的复测方法(同刻对照法)——开源生成器生态复活时一键复验。
  if (isDev) initDebugCard();

  function initDebugCard() {
    $('dev-r1').hidden = false;
    // 预填上次旁听到的首见变量形状(rf_tpl:<op>.v0); 发射走 background 的 route1-probe。
    // 过程可见: background 每步写 rf_r1_probe, 这里监听 storage 变化现场渲染; sendResponse 只负责终态兑底。
    (async () => {
      const key = (globalThis.RF.KEY.gqlTpl || 'rf_tpl') + ':SearchTimeline';
      const { [key]: tpl } = await chrome.storage.local.get(key);
      if (tpl && tpl.v0) $('r1-vars').value = JSON.stringify(tpl.v0, null, 1);
    })();
    let r1Running = false;
    const r1RenderState = (st) => {
      if (!st || !st.steps) return;
      const lines = st.steps.map((s) => `[+${(s.at / 1000).toFixed(1)}s] ${s.name}${s.info ? ' — ' + s.info : ''}`);
      if (st.done) {
        const { steps, ...rest } = st;
        lines.push('', 'JSON 结果:', JSON.stringify(rest, null, 2));
      }
      const out = $('r1-out');
      out.textContent = lines.join('\n');
      out.style.display = 'block';
      if (st.done) {
        r1Running = false;
        $('btn-r1-probe').disabled = false;
        const v = $('r1-verdict');
        v.textContent = st.ok ? '✅ 直连通了(详情见下)' : '❌ 未通过(详情见下)';
        v.style.color = st.ok ? '#1b5e20' : '#b02a37';
      }
    };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.rf_r1_probe) return;
      r1RenderState(changes.rf_r1_probe.newValue);
    });
    $('btn-r1-probe').onclick = async () => {
      if (r1Running) return;
      r1Running = true;
      const verdict = $('r1-verdict');
      let variables = {};
      const raw = ($('r1-vars').value || '').trim();
      if (raw) {
        try { variables = JSON.parse(raw); } catch (e) { verdict.textContent = 'variables 不是合法 JSON: ' + e.message; r1Running = false; return; }
      }
      $('btn-r1-probe').disabled = true;
      verdict.textContent = '发射中…(分步进度会实时出现在下方输出区; 每个网络调用 20s 超时, 总兑底 45s)';
      // 75s 收摊兑底: sendResponse 丢失(如 SW 中途被杀)时不再永久"发射中";
      // 真实结果可能稍后仍从 rf_r1_probe 补显(上方 watcher 会自己收摊)
      const res = await Promise.race([
        (async () => {
          try { return await chrome.runtime.sendMessage({ cmd: 'route1-probe', op: $('r1-op').value.trim(), variables }); }
          catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
        })(),
        new Promise((r) => setTimeout(() => r({ ok: false, timeout: true, error: '75s 无应答——SW 可能在任务中途被杀; 分步进度见下方输出, 真实结果可能稍后自动补上' }), 75_000)),
      ]);
      r1Running = false;
      $('btn-r1-probe').disabled = false;
      if (!res) {
        verdict.textContent = '❌ background 无响应——扩展刚重载过? 重试一次';
        verdict.style.color = '#b02a37';
        return;
      }
      if (!res.timeout) {
        verdict.textContent = res.ok ? '✅ 直连通了(详情见下)' : '❌ 未通过(详情见下)';
        verdict.style.color = res.ok ? '#1b5e20' : '#b02a37';
      }
    };

    $('btn-r1-harvest').onclick = async () => {
      const v = $('r1-verdict');
      v.textContent = '供血中…(开后台搜索页签收 3 发, 约 15 秒后自动关)';
      let res;
      try { res = await chrome.runtime.sendMessage({ cmd: 'harvest-boost' }); } catch (e) { res = { ran: false, error: String(e) }; }
      if (res && res.ran) {
        v.textContent = '供血已发车, 等 16s 收尾…';
        setTimeout(async () => {
          const { rf_tid_pool: pool } = await chrome.storage.local.get('rf_tid_pool');
          const n = (pool || []).filter((e) => e.p.includes('SearchTimeline')).length;
          v.textContent = `✅ 供血完成, SearchTimeline tid 现 ${n} 条(70s 冷却后可用)`;
          v.style.color = '#1b5e20';
        }, 16000);
      } else {
        v.textContent = '❌ 未发车(90s 内已供过/已在跑): ' + ((res && res.error) || '');
        v.style.color = '#b02a37';
      }
    };
    $('btn-fp-run').onclick = async () => {
      const v = $('fp-verdict');
      const target = $('fp-target').value.trim().replace(/^@/, '');
      if (!/^[A-Za-z0-9_]{1,15}$/.test(target)) { v.textContent = '先填目标 handle(不带 @)'; v.style.color = '#b02a37'; return; }
      $('btn-fp-run').disabled = true;
      v.textContent = '实验中…(UserByScreenName → 关注 → 取关, 约几秒)';
      v.style.color = '';
      let res;
      try { res = await chrome.runtime.sendMessage({ cmd: 'follow-probe', handle: target }); }
      catch (e) { res = { ok: false, error: String(e) }; }
      $('btn-fp-run').disabled = false;
      v.textContent = res.verdict || res.error || (res.ok ? '✅ 通过' : '❌ 未通过');
      v.style.color = res.ok ? '#1b5e20' : '#b02a37';
      const out = $('fp-out');
      out.textContent = JSON.stringify(res, null, 2);
      out.style.display = 'block';
    };
  }

  // ---------- 初始化 ----------
  loadSettings().then(render);
  // 打开控制台顺带触发身份识别(背景静默, 失败走负缓存)
  try { chrome.runtime.sendMessage({ cmd: 'identity-probe' }); } catch {}
  // storage 驱动: 任务写入/日志/tid 入库/供血进度都会触发重渲染, 无需轮询
  chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') scheduleRender(); });
})();
