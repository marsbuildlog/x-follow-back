// 控制台: Tab 化(总览/回关/主动关注/设置/日志), hash 记忆停留页。
// 数据编排: 每次渲染读 rf_active → 并行读 回关任务/主动关注任务/每日计数/两个进度 →
//   分发到 总览卡(状态+操作组件)、各任务 Tab(状态行+操作+明细表)、引导卡。
// 任务仍宿主在 x.com 页面内; 控制按钮经消息转发(start-task/pause-task/resume-task/
//   refresh-list/start-af-task/af-search), 抓取互关帖宿主任意 x.com 标签页
//   (Route 1 直连不挑场, 标签经消息指定、按配置校验)。
// 页面只在两处被问到: ①tpl-captured(回关模板捕获状态, 异步增补) ②reset/start 等动作本身。
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const PAUSE_TEXT = {
    manual: '手动', stalled: '连续失败', 'daily-limit': '今日已达上限',
    'template-expired': '模板过期', error: '连续异常',
  };
  const MAX_ROWS = 200; // 表格单次最多渲染行数(防大账号卡死页面)
  const isDev = !chrome.runtime.getManifest().update_url;

  let curView = 'dashboard';
  let curTab = 'todo';      // 回关队列子 tab: todo | done
  let afCurTab = 'todo';    // 主动关注队列子 tab
  let poolFilter = 'all';   // 互关帖池筛选: all | new | old
  let afSearchTag = null;   // 手动抓取的标签(下拉选择, 默认取配置列表第一个; render 时自愈)
  let opTimer = null, renderTimer = null;

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

  // 操作结果提示: Tab 内用各自的 result span(重渲染不触及); 总览卡片会整体重渲,
  // 改用全局 toast(固定右上角, 不在渲染目标内, 不被抹掉)
  function showOp(elId, text) {
    const el = elId === 'toast' ? $('toast') : $(elId);
    if (!el) return;
    el.textContent = text;
    el.style.display = 'block';
    el.style.background = /失败|错误|未|请/.test(text) ? '#b02a37' : '#0f1419';
    el.style.color = '#fff';
    clearTimeout(opTimer);
    opTimer = setTimeout(() => { el.textContent = ''; if (elId === 'toast') el.style.display = 'none'; }, 5000);
  }

  // ---------- 主渲染 ----------
  const statusPill = (s) => `<span class="pill st-${s}">${s === 'pending' ? '待处理' : s === 'failed' ? '失败' : s === 'done' ? '完成' : s}</span>`;
  const todayStr = () => {
    const p = (n) => String(n).padStart(2, '0');
    const t = new Date();
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  };
  const fmtDT = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
  // 智能时刻: 今天只显 HH:mm, 跨天带日期(重扫间隔两天, 纯时刻分不清是哪天)
  const fmtWhen = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    return d.toDateString() === new Date().toDateString() ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  };
  const stepMark = (b) => (b ? '✅' : '⬜');
  // 任务状态 → 文案/圆点色(与页面悬浮控件一致)
  function stateOf(t) {
    if (!t) return { text: '未启动', color: '#536471' };
    if (t.state === 'paused') {
      return { text: '已暂停 · ' + (PAUSE_TEXT[t.pauseReason] || t.pauseReason), color: t.pauseReason === 'template-expired' ? '#dc2626' : '#d97706' };
    }
    if (t.state === 'running') return { text: '运行中', color: '#1d9bf0' };
    if (t.state === 'done') return { text: '等待新粉', color: '#16a34a' };
    return { text: '未启动', color: '#536471' };
  }
  const countsOf = (q) => {
    const c = { pending: 0, failed: 0, done: 0, skipped: 0 };
    for (const i of q || []) c[i.status] = (c[i.status] || 0) + 1;
    return c;
  };

  async function render() {
    if (isOrphaned()) {
      document.body.innerHTML = '<div style="max-width:640px;margin:60px auto" class="hint">插件已更新——请按 F5 刷新本页, 恢复控制台功能。</div>';
      return;
    }
    const { rf_active: h } = await chrome.storage.local.get('rf_active');
    const tab = await findXTab();
    renderHost(h, tab);

    let fb = null, af = null, daily = { followed: 0 }, fp = null, afp = null, lw = null;
    if (h) {
      const tk = `rf_task:${h}`, dk = `rf_daily:${h}`, ak = `rf_af_task:${h}`;
      const r = await chrome.storage.local.get([tk, dk, ak, 'rf_fetch_progress', RF.KEY.afProgress, RF.KEY.loopWait]);
      fb = r[tk];
      af = r[ak];
      daily = r[dk] && r[dk].date === todayStr() ? r[dk] : { followed: 0 };
      fp = r.rf_fetch_progress;
      afp = r[RF.KEY.afProgress];
      lw = r[RF.KEY.loopWait] && r[RF.KEY.loopWait].until > Date.now() ? r[RF.KEY.loopWait] : null;
      loopWaitInfo = lw;
    }
    renderFbCard(h, fb, daily, fp, tab);
    renderAfCard(h, af, tab, afp);
    renderGuideFb(h, fb, tab);
    renderGuideAf(h, af);
    renderFbDetail(h, fb, daily, fp, tab);
    renderAfDetail(h, af, afp);
    renderLog();
    if (h) enrichFromPage(); // 模板捕获状态异步增补(仅页面可达时)
  }

  // 渲染去抖: storage 变化频繁(循环每次关注/日志/tid 入库都写), 合并短窗内的连续触发
  function scheduleRender(delay = 300) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, delay);
  }

  // ---------- 总览: 宿主状态卡 ----------
  function renderHost(h, tab) {
    const el = $('host-card');
    if (tab) {
      el.innerHTML = `<h3>宿主</h3><span class="dot" style="background:#16a34a"></span> 宿主在线 <span class="hint">任意 x.com 标签页即可承载任务循环; 关闭全部页面任务会暂停并通知</span>`;
    } else {
      el.innerHTML = `<h3>宿主</h3><span class="dot" style="background:#d97706"></span> 宿主离线 <span class="hint">任务动作暂停(需页面宿主); 打开任意 x.com 页面自动继续</span>
        <button id="host-open" style="margin:0 0 0 8px;padding:2px 12px;font-size:12px">打开认证粉丝页</button>`;
      const b = $('host-open');
      if (b) b.onclick = () => chrome.tabs.create({ url: h ? `https://x.com/${h}/verified_followers` : 'https://x.com/home' });
    }
  }

  // ---------- 总览: 任务卡(状态 + 操作组件, 回关/主动关注共用一套渲染) ----------
  function taskCardOps(kind, t, extra) {
    const state = t ? t.state : null;
    const off = (b) => (b ? '' : 'disabled');
    const btns = [];
    btns.push(`<button data-taskop="${kind}-start" ${off(state !== 'running')}>${kind === 'af' ? '开始主动关注' : '开始回关'}</button>`);
    btns.push(`<button class="ghost" data-taskop="${kind}-pause" ${off(state !== 'running')}>暂停</button>`);
    btns.push(`<button class="ghost" data-taskop="${kind}-resume" ${off(state !== 'paused')}>恢复</button>`);
    if (kind === 'af') {
      btns.push(`<button class="ghost" data-taskop="af-search" ${off(!extra)} title="${extra ? '翻页搜索帖子入池(任意 x.com 标签页在线即可, Route 1 直连)' : '需任意 x.com 标签页在线(打开 x.com 即可)'}">抓取互关帖</button>`);
    }
    return `<div class="ops">${btns.join('')}</div>`;
  }

  function renderFbCard(h, fb, daily, fp, tab) {
    const el = $('dash-fb');
    const st = stateOf(fb);
    const q = (fb && fb.queue) || [];
    const c = countsOf(q);
    const fetchChip = fp ? ` · 拉取中(第${fp.page}/${fp.maxPages}页)` : '';
    const tpl = tplCaptured === true ? '✓' : tplCaptured === false ? '⚠' : '';
    el.innerHTML = `
      <h3><span class="dot" style="background:${st.color}"></span>回关任务 ${h ? `<span class="hint">@${esc(h)}</span>` : ''}<button class="more" data-goto="followback">详情 →</button></h3>
      <div>状态: <b>${esc(st.text)}</b>${fp ? `<span class="hint">${fetchChip}</span>` : ''} ${tpl ? `<span class="hint" title="回关模板">模板${tpl}</span>` : ''}${loopWaitChip()}</div>
      <div>待回关 <span class="num">${c.pending}</span> / 总数 ${q.length} · 今日已回关 <span class="num">${daily.followed}</span></div>
      ${h ? taskCardOps('fb', fb, tab) : '<div class="hint">打开 x.com 登录后自动识别账号</div>'}
    `;
  }

  function renderAfCard(h, af, tab, afp) {
    const el = $('dash-af');
    const st = stateOf(af);
    const q = (af && af.queue) || [];
    const c = countsOf(q);
    let poolTotal = 0, poolDue = 0;
    for (const obj of Object.values((af && af.tags) || {})) {
      for (const p of obj.posts || []) { poolTotal++; if (p.scanCount < RF.AF.SCAN_MAX && p.nextScanAt <= Date.now()) poolDue++; }
    }
    const searching = !!(afp && afp.running);
    const grabOK = !!tab && !searching;
    const water = (af && af.state === 'running' && c.pending < RF.AF.PENDING_TARGET)
      ? ` <span class="hint">(低于水位 ${RF.AF.PENDING_TARGET}, 循环顺路扫帖补员中)</span>` : '';
    el.innerHTML = `
      <h3><span class="dot" style="background:${st.color}"></span>主动关注任务 ${h ? `<span class="hint">@${esc(h)}</span>` : ''}<button class="more" data-goto="activefollow">详情 →</button></h3>
      <div>状态: <b>${esc(st.text)}</b>${searching ? ` <span style="color:#7c3aed;font-weight:700">· 抓取中 #${esc(afp.tag)}(第${afp.page}/${afp.maxPages}页, 帖子${afp.posts ?? 0})</span>` : ''}${loopWaitChip()}</div>
      <div>待关注 <span class="num">${c.pending}</span> / 队列 ${q.length} · 帖子池 ${poolTotal}${poolDue ? `(待扫 ${poolDue})` : ''}${water}</div>
      ${h ? taskCardOps('af', af, grabOK) : '<div class="hint">打开 x.com 登录后自动识别账号</div>'}
    `;
  }

  // ---------- 总览: 分业务引导(相互独立) ----------
  function renderGuideFb(h, fb, tab) {
    const el = $('guide-fb');
    const running = fb && (fb.state === 'running' || fb.state === 'done');
    if (h && tplCaptured === true && running) {
      el.innerHTML = `<div class="hint">✅ 回关引导已完成(模板已捕获, ${fb.state === 'running' ? '任务运行中' : '等待新粉, 拉到自动续跑'})</div>`;
      return;
    }
    const s1 = h ? `${stepMark(true)} <b>账号识别</b> — @${esc(h)}` : `${stepMark(false)} <b>账号识别</b> — 打开 x.com 登录后自动识别`;
    const openVf = `<button data-goto-open-vf="1" style="margin:0;padding:1px 10px;font-size:12px">打开认证粉丝页</button>`;
    const s2 = !h
      ? `${stepMark(false)} <b>回关模板</b> — 待账号识别`
      : tplCaptured === true
        ? `${stepMark(true)} <b>回关模板</b> — 已捕获`
        : `${stepMark(false)} <b>回关模板</b> — ${openVf} 在列表里点一次任意用户的「回关」(仅需一次)`;
    const s3 = running
      ? `${stepMark(true)} <b>启动</b> — 运行中`
      : `${stepMark(false)} <b>启动</b> — ${tplCaptured === true ? `点「开始回关」` : '完成②后点「开始回关」'}`;
    el.innerHTML = `<h3>回关引导</h3><div class="guide-line">${s1}</div><div class="guide-line">${s2}</div><div class="guide-line">${s3}</div>`;
    const b = el.querySelector('[data-goto-open-vf]');
    if (b) b.onclick = () => chrome.tabs.create({ url: `https://x.com/${h}/verified_followers` });
  }

  function renderGuideAf(h, af) {
    const el = $('guide-af');
    const tags = pendingTags;
    const poolTotal = Object.values((af && af.tags) || {}).reduce((n, o) => n + (o.posts || []).length, 0);
    const running = af && (af.state === 'running' || af.state === 'done');
    if (tags.length && poolTotal && running) {
      el.innerHTML = `<div class="hint">✅ 主动关注引导已完成(标签已配置, 帖子池 ${poolTotal} 帖, ${af.state === 'running' ? '任务运行中' : '等待新候选, 扫到自动续跑'})</div>`;
      return;
    }
    const s1 = tags.length
      ? `${stepMark(true)} <b>配置互关标签</b> — ${tags.map((t) => '#' + esc(t)).join(' ')}(设置 Tab 可改)`
      : `${stepMark(false)} <b>配置互关标签</b> — <button data-goto="settings" style="margin:0;padding:1px 10px;font-size:12px">去设置添加</button>(如 蓝V互关)`;
    const grab = `<button data-taskop="af-search" style="margin:0;padding:1px 10px;font-size:12px">抓取互关帖</button>`;
    const s2 = poolTotal
      ? `${stepMark(true)} <b>填充帖子池</b> — 已有 ${poolTotal} 帖(点 ${grab} 可继续补充)`
      : `${stepMark(false)} <b>填充帖子池</b> — ${tags.length ? grab + ' <span class="hint">直连抓取, 无需打开标签页</span>' : '先完成①'}`;
    const s3 = running
      ? `${stepMark(true)} <b>启动</b> — 运行中`
      : `${stepMark(false)} <b>启动</b> — 点「开始主动关注」(之后扫描与关注自动进行)`;
    el.innerHTML = `<h3>主动关注引导</h3><div class="guide-line">${s1}</div><div class="guide-line">${s2}</div><div class="guide-line">${s3}</div>`;
  }

  // ---------- 回关 Tab ----------
  function renderFbDetail(h, fb, daily, fp, tab) {
    const st = stateOf(fb);
    const q = (fb && fb.queue) || [];
    const c = countsOf(q);
    if (!h) {
      $('task-state').textContent = '状态: 未识别账号——打开 x.com 登录后自动识别';
    } else if (!fb || !fb.queue) {
      $('task-state').textContent = `账号: @${h} · 状态: 未启动(填充队列后点「开始回关」)`;
    } else {
      const fetchChip = fp ? ` · <span style="color:#7c3aed;font-weight:700">拉取中(第${fp.page}/${fp.maxPages}页, 累计${fp.users})</span>` : '';
      $('task-state').innerHTML =
        `账号: @${esc(h)} · 状态: <b>${esc(st.text)}</b>` +
        ` · 总数: ${q.length} · 待回关: ${c.pending} · 今日已回关: ${daily.followed}` +
        (fb.lastFetchAt ? ` · 上次拉取: ${fmtWhen(fb.lastFetchAt)}` : '') +
        ` · 回关模板: ${tplBadge(tplCaptured)}${fetchChip}` +
        loopWaitChip() +
        (fb.lastError ? `<br>最近错误: <span style="color:#b02a37">${esc(fb.lastError)}</span>` : '');
    }
    // 队列
    if (fb && fb.queue) {
      $('cnt-todo').textContent = `(${c.pending + c.failed})`;
      $('cnt-done').textContent = `(${c.done})`;
      const rows = q.filter((i) => curTab === 'done' ? i.status === 'done' : (i.status === 'pending' || i.status === 'failed'));
      $('queue-table').querySelector('tbody').innerHTML = rows
        .slice(0, MAX_ROWS)
        .map((i) =>
          `<tr><td>${statusPill(i.status)}</td><td>@${esc(i.screenName || i.userId)}</td><td>${esc(i.name)}</td><td>${esc(i.error)}</td><td>${i.doneAt ? fmtDT(i.doneAt) : ''}</td></tr>`
        ).join('');
      $('queue-summary').textContent =
        (rows.length > MAX_ROWS ? `仅显示前 ${MAX_ROWS} 条 / 共 ${rows.length} 条 · ` : '') +
        `跳过(已关注) ${c.skipped} 项不列出`;
    } else {
      $('cnt-todo').textContent = '';
      $('cnt-done').textContent = '';
      $('queue-table').querySelector('tbody').innerHTML = '';
      $('queue-summary').textContent = '';
    }
    // 按钮状态
    const state = (fb && fb.state) || null;
    $('btn-start').disabled = state === 'running';
    $('btn-pause').disabled = state !== 'running';
    $('btn-resume').disabled = state !== 'paused';
    $('btn-refresh').disabled = !tab;
  }

  // ---------- 主动关注 Tab ----------
  function poolStatus(p) {
    if (p.scanCount >= RF.AF.SCAN_MAX) return { t: '完成', c: '#536471' };
    if (p.nextScanAt > Date.now()) return { t: '冷却中', c: '#8a6d00' };
    return p.scanCount === 0 ? { t: '新帖·待扫描', c: '#1b5e20' } : { t: '重扫中', c: '#1b5e20' };
  }
  const postLink = (id) => `<a href="https://x.com/i/web/status/${esc(id)}" target="_blank">${esc(id)}</a>`;

  function renderAfDetail(h, af, afp) {
    const st = stateOf(af);
    const q = (af && af.queue) || [];
    const c = countsOf(q);
    let poolTotal = 0, poolDue = 0;
    const poolRows = [];
    for (const [tag, obj] of Object.entries((af && af.tags) || {})) {
      for (const p of obj.posts || []) {
        poolTotal++;
        if (p.scanCount < RF.AF.SCAN_MAX && p.nextScanAt <= Date.now()) poolDue++;
        poolRows.push({ tag, ...p });
      }
    }
    poolRows.sort((a, b) => (b.replyCount || 0) - (a.replyCount || 0) || a.nextScanAt - b.nextScanAt);
    const searching = !!(afp && afp.running);
    const finishedFresh = afp && afp.running === false && afp.finishedAt && Date.now() - afp.finishedAt < 120_000;
    const searchChip = searching
      ? ` · <span style="color:#7c3aed;font-weight:700">抓取中 #${esc(afp.tag)}(第${afp.page}/${afp.maxPages}页, 帖子${afp.posts ?? 0})</span>`
      : finishedFresh
        ? ` · <span style="color:#1b5e20">上轮抓取完成: 帖子${afp.posts ?? '—'}</span>`
        : '';

    if (!h) {
      $('af-state').textContent = '状态: 未识别账号——打开 x.com 登录后自动识别';
    } else if (!af || !af.queue) {
      $('af-state').textContent = `账号: @${h} · 状态: 未启动(先完成引导: 配置标签 → 抓取互关帖)`;
    } else {
      $('af-state').innerHTML =
        `账号: @${esc(h)} · 状态: <b>${esc(st.text)}</b>${searchChip}` +
        ` · 队列: ${q.length}(待关注 ${c.pending}) · 帖子池: ${poolTotal}(待扫 ${poolDue})` +
        loopWaitChip() +
        (af.lastError ? `<br>最近错误: <span style="color:#b02a37">${esc(af.lastError)}</span>` : '');
    }

    // 互关帖池表
    const filtered = poolFilter === 'all' ? poolRows : poolRows.filter((p) => poolFilter === 'new' ? p.scanCount === 0 : p.scanCount > 0);
    $('pool-table').querySelector('tbody').innerHTML = filtered
      .slice(0, MAX_ROWS)
      .map((p) => {
        const ps = poolStatus(p);
        return `<tr><td>#${esc(p.tag)}</td><td>${postLink(p.postId)}</td><td>${p.replyCount ?? '—'}</td><td style="color:${ps.c}">${ps.t}</td><td>${p.scanCount}/${RF.AF.SCAN_MAX}</td><td>${fmtWhen(p.lastScanAt)}</td><td>${fmtWhen(p.nextScanAt)}</td></tr>`;
      }).join('');
    $('pool-summary').textContent = filtered.length
      ? (filtered.length > MAX_ROWS ? `仅显示前 ${MAX_ROWS} 条 / 共 ${filtered.length} 条 · ` : '') + `共 ${poolTotal} 帖 · 待扫 ${poolDue}`
      : (poolTotal ? '当前筛选无帖子' : '帖子池为空——完成引导②「填充帖子池」后这里会出现帖子');

    // 主动关注队列表
    if (af && af.queue) {
      $('af-cnt-todo').textContent = `(${c.pending + c.failed})`;
      $('af-cnt-done').textContent = `(${c.done})`;
      const rows = q.filter((i) => afCurTab === 'done' ? i.status === 'done' : (i.status === 'pending' || i.status === 'failed'));
      $('af-queue-table').querySelector('tbody').innerHTML = rows
        .slice(0, MAX_ROWS)
        .map((i) =>
          `<tr><td>${statusPill(i.status)}</td><td>@${esc(i.screenName || i.userId)}</td><td>${esc(i.name)}</td><td>${i.source ? postLink(i.source) : '—'}</td><td>${fmtDT(i.addedAt)}</td><td>${esc(i.error)}</td></tr>`
        ).join('');
      $('af-queue-summary').textContent = rows.length > MAX_ROWS ? `仅显示前 ${MAX_ROWS} 条 / 共 ${rows.length} 条` : '';
    } else {
      $('af-cnt-todo').textContent = '';
      $('af-cnt-done').textContent = '';
      $('af-queue-table').querySelector('tbody').innerHTML = '';
      $('af-queue-summary').textContent = '';
    }
    // 按钮状态(抓取中时禁用抓取, content 侧 afSearching 也有双击拦截); 标签选择随配置刷新
    const state = (af && af.state) || null;
    $('btn-af-start').disabled = state === 'running';
    $('btn-af-pause').disabled = state !== 'running';
    $('btn-af-resume').disabled = state !== 'paused';
    $('btn-af-search').disabled = searching;
    // 抓取标签下拉: 配置列表里的一个(默认第一个); 手动抓取按它搜
    if (!pendingTags.includes(afSearchTag)) afSearchTag = pendingTags[0] || null;
    const sel = $('af-search-tag');
    if (sel) {
      sel.innerHTML = pendingTags.map((t) => `<option value="${esc(t)}" ${t === afSearchTag ? 'selected' : ''}>#${esc(t)}</option>`).join('');
      sel.style.display = pendingTags.length ? '' : 'none';
    }
    // 逐标签「打开标签页」快捷按钮(与引导卡同源, pendingTags 变化随渲染更新)
    const tagBtns = $('af-tag-buttons');
    tagBtns.innerHTML = pendingTags.length
      ? '<span class="hint">打开标签页:</span>' + pendingTags.map((t) => `<button class="ghost" style="margin:0;padding:2px 10px;font-size:12px" data-open-tag="${esc(t)}" title="新窗口打开 x.com/hashtag/${esc(t)}">#${esc(t)}</button>`).join('')
      : '<span class="hint">打开标签页: 先在「设置」配置互关标签</span>';
  }

  // ---------- 日志 ----------
  async function renderLog() {
    const logEl = $('log');
    const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    const { rf_log: logs } = await chrome.storage.local.get('rf_log');
    logEl.textContent = (logs || []).map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.text}`).join('\n') || '（暂无日志）';
    if (nearBottom || !logEl.dataset.inited) {
      logEl.scrollTop = logEl.scrollHeight;
      logEl.dataset.inited = '1';
    }
  }

  // ---------- 回关模板捕获状态(异步增补, 不阻塞渲染; 页面探活失败顺带自愈) ----------
  let tplCaptured;
  let tplSeq = 0;
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
    if (!tab) return; // 无页面: 模板状态保持未知, 也无从自愈
    let captured = null;
    let alive = true;
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { cmd: 'tpl-captured' });
      captured = r && r.captured;
    } catch { alive = false; }
    if (seq !== tplSeq) return; // 已有更新的渲染, 丢弃过期结果
    if (captured !== tplCaptured) {
      tplCaptured = captured;
      scheduleRender(0);
    }
    if (!alive) injectContentScript(tab);
  }

  // 回关模板徽标
  const tplBadge = (captured) =>
    captured === true ? '<span style="color:#1b5e20">已捕获 ✓</span>'
      : captured === false
        ? '<span style="color:#b02a37" title="在认证粉丝页列表里点一次任意用户的「回关」, 插件即完成初始化">待初始化 ⚠</span>'
        : '?';

  // 循环静默等待(限流重试/窗口用完)的提示文案: 绝对时刻而非倒计时——总览只在有存储变化时
  // 重渲染, 倒计时会冻住误导; "15:30 前自动继续"永远诚实
  let loopWaitInfo = null;
  const loopWaitChip = () => loopWaitInfo
    ? ` <span class="hint">· ${esc(loopWaitInfo.text)}, ${fmtWhen(loopWaitInfo.until)} 前自动继续</span>`
    : '';

  // ---------- 操作按钮: 经消息转发给页面内的任务循环 ----------
  async function taskAction(cmd, picker, resultEl, noTabMsg, extra) {
    const tab = await picker();
    if (!tab) { showOp(resultEl, noTabMsg || '未找到 x.com 标签页'); return; }
    let res;
    try { res = await chrome.tabs.sendMessage(tab.id, Object.assign({ cmd }, extra || {})); }
    catch (e) { showOp(resultEl, '发送失败(页面可能刚打开, 稍后重试): ' + e.message); return; }
    showOp(resultEl, (res && res.message) || (res && res.ok ? '已执行' : '失败'));
    scheduleRender(0);
  }
  // 统一委托: 卡片与 Tab 内所有 data-taskop 按钮。
  // 卡片按钮带业务前缀(fb-*/af-*), 映射到统一的任务消息; af-search 带 tag 转发(任意 x.com 标签页宿主)。
  // 结果提示落点: 卡片内 → 全局 toast; 任务 Tab 内 → 该视图的 [data-opresult] span。
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-taskop]');
    if (!b || b.disabled) return;
    const CMD_MAP = {
      'fb-start': 'start-task', 'fb-pause': 'pause-task', 'fb-resume': 'resume-task',
      'af-start': 'start-af-task', 'af-pause': 'pause-task', 'af-resume': 'resume-task',
    };
    const cmd = CMD_MAP[b.dataset.taskop] || b.dataset.taskop;
    const isSearch = cmd === 'af-search';
    const inCard = !!b.closest('.card');
    const scope = b.closest('.view');
    const rel = scope && scope.querySelector('[data-opresult]');
    taskAction(cmd, findXTab, inCard || !rel ? 'toast' : rel,
      '未找到 x.com 标签页——先打开任意 x.com 页面', isSearch ? { tag: afSearchTag } : undefined);
  });

  // ---------- 主导航(hash 记忆停留页) ----------
  function switchView(v) {
    curView = v;
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
    if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
  }
  function initNav() {
    document.querySelectorAll('#nav button').forEach((b) => { b.onclick = () => switchView(b.dataset.view); });
    const hash = (location.hash || '').slice(1);
    switchView(['dashboard', 'followback', 'activefollow', 'settings', 'log', 'debug'].includes(hash) ? hash : 'dashboard');
  }

  // 队列子 tab / 帖池筛选
  document.querySelectorAll('#view-followback .tabs .tab').forEach((b) => {
    b.onclick = () => {
      curTab = b.dataset.tab;
      document.querySelectorAll('#view-followback .tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
      render();
    };
  });
  document.querySelectorAll('#pool-filter .tab').forEach((b) => {
    b.onclick = () => {
      poolFilter = b.dataset.pf;
      document.querySelectorAll('#pool-filter .tab').forEach((x) => x.classList.toggle('active', x === b));
      render();
    };
  });
  document.querySelectorAll('#af-queue-tabs .tab').forEach((b) => {
    b.onclick = () => {
      afCurTab = b.dataset.afq;
      document.querySelectorAll('#af-queue-tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
      render();
    };
  });
  // 「详情 →」/ 引导卡内跳转
  document.addEventListener('click', (ev) => {
    const g = ev.target.closest('[data-goto]');
    if (g) switchView(g.dataset.goto);
  });
  // 抓取标签下拉: 手动抓取按它搜(选中值随重渲染保留)
  const afSearchTagSel = $('af-search-tag');
  if (afSearchTagSel) afSearchTagSel.onchange = (e) => { afSearchTag = e.target.value; };
  // 「打开 #标签」按钮: 新窗口打开对应互关标签页; 稍后重渲染以刷新抓取按钮的可用态
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-open-tag]');
    if (!b) return;
    chrome.tabs.create({ url: `https://x.com/hashtag/${encodeURIComponent(b.dataset.openTag)}` });
    setTimeout(scheduleRender, 1500);
  });

  // ---------- 设置(自动保存: 修改即落盘, 防抖; 互关标签增删同样触发) ----------
  let pendingTags = [];
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
    renderTagChips();
  }
  $('btn-add-tag').onclick = addTagFromInput;
  $('s-tag-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTagFromInput(); });
  ['s-intervalMin', 's-intervalMax', 's-autoFetchMin'].forEach((id) => {
    $(id).addEventListener('change', scheduleSave);
  });

  // ---------- 重置任务(回关 Tab): 优先经由页面; 页面不可达直接清 storage(此时任务必然未在运行) ----------
  $('btn-reset').onclick = async () => {
    if (!confirm('确定重置任务? 当前账号的回关队列与进度将被清空。')) return;
    const { rf_active: h } = await chrome.storage.local.get('rf_active');
    if (!h) { showOp('op-result', '无活跃账号, 无任务可重置'); return; }
    const tab = await findXTab();
    let done = false;
    if (tab) {
      try { await chrome.tabs.sendMessage(tab.id, { cmd: 'reset-task' }); done = true; } catch {}
    }
    if (!done) await chrome.storage.local.set({ [`rf_task:${h}`]: null });
    showOp('op-result', '已重置');
    render();
  };

  // ---------- 开发调试视图(仅 dev 显示): Route 1 对照实验 + 回关直连实验 ----------
  if (isDev) {
    $('nav-debug').hidden = false;
    initDebugCard();
  }
  function initDebugCard() {
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
      verdict.textContent = '发射中…(分步进度实时出现在下方输出区)';
      const res = await Promise.race([
        (async () => {
          try { return await chrome.runtime.sendMessage({ cmd: 'route1-probe', op: $('r1-op').value.trim(), variables }); }
          catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
        })(),
        new Promise((r) => setTimeout(() => r({ ok: false, timeout: true, error: '75s 无应答——SW 可能在任务中途被杀' }), 75_000)),
      ]);
      r1Running = false;
      $('btn-r1-probe').disabled = false;
      if (!res) { verdict.textContent = '❌ background 无响应——扩展刚重载过? 重试一次'; verdict.style.color = '#b02a37'; return; }
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
  initNav();
  loadSettings().then(render);
  // storage 驱动: 任务写入/日志/tid 入库/供血进度都会触发重渲染, 无需轮询
  chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') scheduleRender(); });
  // 打开控制台顺带触发身份识别(背景静默, 失败走负缓存)
  try { chrome.runtime.sendMessage({ cmd: 'identity-probe' }); } catch {}
})();
