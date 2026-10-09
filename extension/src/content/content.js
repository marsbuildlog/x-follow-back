// 隔离世界 content script: 页面桥接、任务执行器、x.com 页面状态条。
// 任务循环跑在 x.com 标签页内(不依赖 MV3 service worker 常驻),
// 状态全部持久化到 chrome.storage.local, 页面刷新/重开后可恢复。
(async () => {
  'use strict';

  // 依赖模块显式加载(不依赖 manifest 里的多文件注入顺序):
  // constants.js 挂 globalThis.RF, logic.js 挂 globalThis.RefollowLogic
  try {
    await import(chrome.runtime.getURL('src/shared/constants.js'));
    await import(chrome.runtime.getURL('src/shared/logic.js'));
  } catch (e) {
    throw new Error('[Refollow] 依赖模块动态加载失败: ' + ((e && e.message) || e));
  }
  const RFg = globalThis.RF;
  const L = globalThis.RefollowLogic;
  if (!RFg || !L) {
    throw new Error('[Refollow] 依赖模块执行后未挂载全局(RF/RefollowLogic)');
  }

  const K = RFg.KEY;
  const OP_FOLLOWERS = 'BlueVerifiedFollowers'; // 认证粉丝列表(GraphQL)
  const FOLLOW_API = '/i/api/1.1/friendships/create.json'; // 回关动作: v1.1 REST, 非 GraphQL(实测确认)
  const FOLLOWING_LIST_API = '/i/api/1.1/friends/following/list.json'; // 我的关注列表(页面自身用它判断回关状态)

  // ---------- 生命周期守卫 ----------
  // 插件被 reload 后, 旧 content script 会变成孤儿(chrome.* 不可用),
  // 此时停止一切定时器并清掉自己注入的 DOM, 避免 Extension context invalidated 报错。
  let halted = false;
  const intervals = [];
  function halt() {
    if (halted) return;
    halted = true;
    for (const id of intervals) clearInterval(id);
    try {
      document.getElementById('refollow-bar')?.remove();
      document.getElementById('refollow-bar-style')?.remove();
    } catch {}
  }
  function ctxValid() {
    try { chrome.runtime.getURL(''); return true; } catch { halt(); return false; }
  }

  // ---------- storage ----------
  const store = {
    async get(k, d) {
      if (halted) return d;
      try {
        const r = await chrome.storage.local.get(k);
        return k in r ? r[k] : d;
      } catch (e) {
        if (/context invalidated/i.test(String(e))) halt();
        return d;
      }
    },
    async set(k, v) {
      if (halted) return false;
      try {
        await chrome.storage.local.set({ [k]: v });
        return true;
      } catch (e) {
        if (/context invalidated/i.test(String(e))) halt();
        return false;
      }
    },
  };

  async function log(text) {
    const arr = (await store.get(K.log, [])) || [];
    arr.push({ ts: Date.now(), text: String(text).slice(0, 500) });
    while (arr.length > 200) arr.shift();
    await store.set(K.log, arr);
  }

  async function getSettings() {
    return { ...RF.DEFAULTS, ...((await store.get(K.settings, {})) || {}) };
  }

  async function getDaily() {
    return rolloverDaily(await store.get(K.daily, null));
  }
  function nextMidnight() {
    const d = new Date();
    d.setHours(24, 5, 0, 0);
    return d.getTime();
  }

  // ---------- 与 MAIN world 的桥 ----------
  let msgSeq = 0;
  const pendingCalls = new Map();
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.source !== 'refollow-page' || m.type !== 'result') return;
    if (pendingCalls.has(m.id)) {
      pendingCalls.get(m.id)(m.data);
      pendingCalls.delete(m.id);
    }
  });
  function callPage(type, payload) {
    return new Promise((resolve) => {
      const id = ++msgSeq;
      pendingCalls.set(id, resolve);
      window.postMessage({ source: 'refollow-ui', type, id, payload }, '*');
      setTimeout(() => {
        if (pendingCalls.has(id)) {
          pendingCalls.delete(id);
          resolve({ status: -1, ok: false, body: 'bridge timeout' });
        }
      }, 60_000);
    });
  }
  const callGraphQL = (operationName, variables) => callPage('graphql', { operationName, variables });

  // ---------- 领导权锁(防止多标签页同时跑任务) ----------
  let myLockToken = null;
  async function acquireLock() {
    const lock = await store.get(K.lock, null);
    const now = Date.now();
    const fresh = lock && now - lock.ts < 15_000;
    if (fresh && lock.token !== myLockToken) return false;
    myLockToken = myLockToken || 't' + Math.random().toString(36).slice(2);
    await store.set(K.lock, { token: myLockToken, ts: now });
    return true;
  }
  async function refreshLock() {
    if (myLockToken) await store.set(K.lock, { token: myLockToken, ts: Date.now() });
  }
  async function isLockMine() {
    const lock = await store.get(K.lock, null);
    return !!lock && lock.token === myLockToken;
  }

  // ---------- 通用工具 ----------
  // 纯逻辑(parseFollowers/interpret/mergeUsers/...)在 shared/logic.js(顶部已显式 import), 有单元测试覆盖
  const { parseFollowers, interpret, mergeUsers, findPendingItem, evaluateStall, rolloverDaily, atName } = L;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  async function sleepInterruptible(ms) {
    const step = 1000;
    for (let t = 0; t < ms; t += step) {
      await sleep(step);
      const task = await store.get(K.task, null);
      if (!task || task.state !== 'running') return false;
      if (!(await isLockMine())) return false;
    }
    return true;
  }

  // (interpret/parseFollowers 等纯逻辑在 shared/logic.js, 有单元测试覆盖)

  // 回关: 重放页面自己的 v1.1 REST 请求(friendships/create.json), 仅替换 user_id
  async function followUser(userId) {
    const cap = await callPage('list-captured', {});
    const has = (cap.apiEndpoints || []).some((e) => e.path === FOLLOW_API);
    if (!has) {
      throw new Error('未捕获回关请求——请在本标签页的认证粉丝列表里点一次「回关」按钮(其他页面/标签页捕获不到)');
    }
    return callPage('api', { path: FOLLOW_API, params: { user_id: String(userId) } });
  }

  // ---------- 拉取认证粉丝 ----------
  // (parseFollowers 在 shared/logic.js, 有单元测试覆盖)

  let fetchingFollowers = false;
  async function fetchVerifiedFollowers(screenName) {
    if (fetchingFollowers) throw new Error('已在拉取中, 请等当前任务完成(可重载插件中止)');
    fetchingFollowers = true;
    try {
      const cap = await callPage('list-captured', {});
      const entry = (cap.operations || []).find((o) => o.operationName === OP_FOLLOWERS);
      if (!entry) throw new Error(`未捕获到 ${OP_FOLLOWERS} 请求——请先打开 /${screenName}/verified_followers 页面并等它加载完`);
      const all = [];
      let cursor = null;
      // 页面自己每页只拉 20 条, 这里改为 100 条/页; 服务端会自动策展
      const count = 100;
      const MAX_PAGES = 200;
      for (let page = 0; page < MAX_PAGES; page++) {
        // 接口用 variables.userId 定位(捕获时已在自己的页面, 保持不变), 只翻 cursor
        const variables = { ...(entry.variables || {}), count, cursor };
        delete variables.screen_name;
        const res = await callGraphQL(OP_FOLLOWERS, variables);
        if (res.status === 429) throw new Error('429 限流, 稍后再试');
        const parsed = parseFollowers(res.body);
        if (parsed.error) throw new Error(parsed.error);
        if (page === 0 && parsed.firstRaw) {
          await log('用户对象结构样本: ' + parsed.firstRaw);
          if (parsed.followFields) await log('含follow的字段: ' + parsed.followFields);
          const preview = parsed.users.slice(0, 10).map((u) => `${u.screenName || u.userId}(我关注他:${u.following ? '是' : '否'})`).join(', ');
          await log('前10个用户: ' + preview);
        }
        all.push(...parsed.users);
        await store.set(K.fetchProgress, {
          screenName, page: page + 1, maxPages: MAX_PAGES, users: all.length,
          hasMore: !!parsed.cursor, ts: Date.now(),
        });
        await log(`拉取第${page + 1}页: +${parsed.users.length}, 累计${all.length}, cursor=${parsed.cursor ? '有' : '无'}`);
        // 实测: 列表拉完后接口仍会返回 cursor(非空但无数据), 所以 0 人即视为拉完
        if (!parsed.cursor || parsed.cursor === cursor || parsed.users.length === 0) break;
        cursor = parsed.cursor;
        await sleep(800 + Math.random() * 700);
      }
      // 按 userId 去重
      const seen = new Set();
      return all.filter((u) => (seen.has(u.userId) ? false : (seen.add(u.userId), true)));
    } finally {
      fetchingFollowers = false;
      await store.set(K.fetchProgress, null);
    }
  }

  // ---------- 任务状态机 ----------
  async function getTask() {
    const t = await store.get(K.task, null);
    return t || {
      state: 'idle', pauseReason: null, nextAutoResumeAt: null,
      screenName: null, queue: [], consecutiveFailures: [], lastError: null, updatedAt: 0,
    };
  }
  async function saveTask(t) {
    t.updatedAt = Date.now();
    await store.set(K.task, t);
  }
  async function pauseTask(reason, resumeAt) {
    const t = await getTask();
    t.state = 'paused';
    t.pauseReason = reason;
    t.nextAutoResumeAt = resumeAt || null;
    await saveTask(t);
    await log(`任务暂停(${reason})`);
  }
  async function resumeTask() {
    const t = await getTask();
    if (t.state !== 'paused' && t.state !== 'idle') return t;
    // 失败项重新入队重试
    for (const item of t.queue) {
      if (item.status === 'failed') { item.status = 'pending'; item.error = null; }
    }
    t.state = 'running';
    t.pauseReason = null;
    t.nextAutoResumeAt = null;
    await saveTask(t);
    await log('任务恢复');
    runLoop();
    return t;
  }

  // 拉取"我的关注列表", 用于判断哪些认证粉丝已关注过。
  // BlueVerifiedFollowers 响应里没有 following 字段(实测), 而页面自身
  // 就是靠这个接口来决定显示「回关」还是「正在关注」的, 与页面逻辑保持一致。
  async function fetchFollowingIds() {
    const cap = await callPage('list-captured', {});
    const entry = (cap.apiEndpoints || []).find((e) => e.path === FOLLOWING_LIST_API);
    if (!entry) {
      await log('⚠ 未捕获 following/list 接口, 无法校验已关注状态(刷新页面等列表加载后自动捕获)');
      return null;
    }
    const ids = new Set();
    let cursor = -1;
    for (let page = 0; page < 50; page++) {
      const res = await callPage('api', { path: FOLLOWING_LIST_API, params: { cursor: String(cursor), count: '200' } });
      if (res.status !== 200) {
        await log(`following/list 第${page + 1}页失败: HTTP ${res.status}`);
        break;
      }
      let data;
      try {
        data = JSON.parse(res.body);
      } catch {
        await log(`following/list 第${page + 1}页响应非 JSON: ${String(res.body).slice(0, 200)}`);
        break;
      }
      for (const u of data.users || []) if (u.id_str) ids.add(u.id_str);
      const next = data.next_cursor;
      await log(`关注列表第${page + 1}页: +${(data.users || []).length}, 累计${ids.size}, next_cursor=${next}`);
      if (!next || next === 0 || next === cursor) break;
      cursor = next;
      await sleep(500 + Math.random() * 500);
    }
    return ids;
  }

  // (mergeUsers 在 shared/logic.js, 有单元测试覆盖)

  async function startTask(screenName) {
    screenName = (screenName || '').replace(/\/+$/, '');
    if (!screenName) {
      // 从当前页面 URL 推断 handle(x.com/<handle>/verified_followers)
      const m = /^\/([^/]+)(\/|$)/.exec(location.pathname);
      screenName = m ? m[1] : '';
    }
    if (!screenName || screenName === 'i' || screenName === 'home' || screenName === 'explore') {
      return { ok: false, message: '缺少 screenName——请在目标账号的 verified_followers 页面上操作' };
    }
    const t = await getTask();
    if (t.state === 'running') return { ok: false, message: '任务已在运行中, 更新列表请用「更新列表」按钮' };
    const users = await fetchVerifiedFollowers(screenName);
    if (!users.length) return { ok: false, message: '没有拉到认证粉丝(检查捕获状态)' };

    const followedIds = await fetchFollowingIds();

    // 换了账号则重置任务
    if (t.screenName && t.screenName !== screenName) t.queue = [];
    t.screenName = screenName;
    mergeUsers(t, users, followedIds);

    // 从队列真实统计(避免计数口径不一致)
    const pendingCount = t.queue.filter((q) => q.status === 'pending').length;
    const skippedCount = t.queue.filter((q) => q.status === 'skipped').length;
    t.state = 'running';
    t.pauseReason = null;
    t.nextAutoResumeAt = null;
    t.lastError = null;
    await saveTask(t);
    await log(`任务启动: 本次拉取${users.length}个认证粉丝(其中已关注${skippedCount}个), 队列实际待回关${pendingCount}个`);
    runLoop();
    return {
      ok: true,
      message: `本次拉取${users.length}个认证粉丝(已关注${skippedCount}个), 队列实际待回关${pendingCount}个`,
      total: t.queue.length,
    };
  }

  // ---------- 更新认证粉丝列表(运行中也能用) ----------
  // 用存储标记做请求, 由任务循环/观察器在自己的事务内应用, 避免并发写坏队列
  async function requestRefresh() {
    const m = /^\/([^/]+)(\/|$)/.exec(location.pathname);
    const screenName = m ? m[1] : '';
    if (!screenName) return { ok: false, message: '请在目标账号的 verified_followers 页面上操作' };
    await store.set(K.refreshRequest, { screenName, ts: Date.now() });
    await log(`已请求更新认证粉丝列表(@${screenName})`);
    return { ok: true, message: '已请求更新列表, 几秒内自动执行, 结果看日志' };
  }
  async function processRefreshRequest(fromLoop = false) {
    const req = await store.get(K.refreshRequest, null);
    if (!req) return false;
    const t0 = await getTask();
    // 任务运行中且调用方不是循环本身时, 把请求留给循环处理(避免并发写坏队列)
    if (!fromLoop && t0.state === 'running') return true;
    await store.set(K.refreshRequest, null); // 先清标记防重复执行
    if (fetchingFollowers) return true;
    try {
      const users = await fetchVerifiedFollowers(req.screenName);
      const followedIds = await fetchFollowingIds();
      const t = await getTask();
      if (t.screenName && t.screenName !== req.screenName) {
        await log(`忽略更新请求(当前任务账号 @${t.screenName} 与请求账号 @${req.screenName} 不一致)`);
        return true;
      }
      t.screenName = req.screenName;
      const added = mergeUsers(t, users, followedIds);
      const pendingCount = t.queue.filter((q) => q.status === 'pending').length;
      // 空闲/已完成状态下有新待回关 → 自动继续跑
      if ((t.state === 'idle' || t.state === 'done') && pendingCount > 0) {
        t.state = 'running';
        t.pauseReason = null;
        t.nextAutoResumeAt = null;
      }
      await saveTask(t);
      await log(`列表已更新: 本次拉取${users.length}个, 新增${added}个, 当前待回关${pendingCount}个`);
      if (t.state === 'running') runLoop();
    } catch (e) {
      await log(`更新列表失败: ${e}`);
    }
    return true;
  }

  // ---------- 主循环 ----------
  let loopRunning = false;
  async function runLoop() {
    if (loopRunning) return;
    if (!(await acquireLock())) return;
    loopRunning = true;
    try {
      let task = await store.get(K.task, null);
      if (!task || task.state !== 'running') return;

      while (true) {
        await refreshLock();
        // 处理「更新列表」请求(在自己的事务内合并, 避免并发写)
        if (await processRefreshRequest(true)) task = await store.get(K.task, null);
        if (!task || task.state !== 'running') break;
        const settings = await getSettings();
        const item = task.queue.find((i) => i.status === 'pending');
        if (!item) {
          task.state = 'done';
          await saveTask(task);
          await log('任务完成: 队列已空');
          break;
        }

        // 随机间隔(模拟人工)
        const delayMs = randInt(settings.intervalMin, settings.intervalMax) * 1000;
        if (!(await sleepInterruptible(delayMs))) break;

        task = await store.get(K.task, null);
        if (!task || task.state !== 'running') break;
        if (!(await isLockMine())) break;
        // 重读 task 后旧 item 引用已失效, 按 userId 重新定位。
        // (否则“已完成”标在旧快照上, 存储里仍是 pending, 会重复关注同一人)
        const current = findPendingItem(task.queue, item.userId);
        if (!current) continue; // 已被其他流程处理, 换下一个

        const res = await followUser(current.userId);
        const r = interpret(res);

        if (r.ok) {
          current.status = 'done';
          current.error = null;
          task.consecutiveFailures = [];
          const d = await getDaily();
          d.followed++;
          await store.set(K.daily, d);
          await log(`已关注 ${atName(current)}, 今日 ${d.followed}`);
        } else {
          current.status = 'failed';
          current.error = r.errorText;
          task.lastError = `${atName(current)}: ${r.errorText}`;
          task.consecutiveFailures.push(Date.now());
          const stall = evaluateStall(task.consecutiveFailures, Date.now(), settings.stallMin * 60_000, settings.stallMin * 60_000);
          task.consecutiveFailures = stall.kept;
          await log(`关注失败 ${atName(current)}: ${r.errorText}`);

          if (r.followLimited) {
            // 161: 达到关注上限 → 视同当日额度用完
            await pauseTask('daily-limit', nextMidnight());
          } else if (r.rateLimited) {
            // 429/88: 长退避后重试, 不直接算 stall
            await saveTask(task);
            const backoff = settings.rateLimitBackoffMin * 60_000;
            await log(`限流, 退避 ${settings.rateLimitBackoffMin} 分钟`);
            if (!(await sleepInterruptible(backoff))) break;
          } else if (stall.shouldPause) {
            await pauseTask('stalled', Date.now() + settings.autoResumeMin * 60_000);
          }
        }
        await saveTask(task);
        if (task.state !== 'running') break;
      }
    } finally {
      loopRunning = false;
    }
  }

  // ---------- 自动恢复观察器 ----------
  async function autoTick() {
    await processRefreshRequest(); // 处理「更新列表」请求(空闲/暂停态时也生效)
    const t = await getTask();
    if (t.state === 'running') {
      // 页面刷新后接管中断的任务
      if (!(await isLockMine()) && (await acquireLock())) runLoop();
      return;
    }
    if (t.state === 'paused' && t.nextAutoResumeAt && Date.now() >= t.nextAutoResumeAt) {
      if (await acquireLock()) resumeTask();
    }
  }
  intervals.push(setInterval(autoTick, 30_000));
  autoTick();

  // ---------- PoC 单点测试 ----------
  async function testFollowOne() {
    const t = await getTask();
    const item = t.queue.find((i) => i.status === 'pending');
    if (!item) return { ok: false, message: '队列里没有待回关用户(先拉取粉丝或启动任务)' };
    let res;
    try {
      res = await followUser(item.userId);
    } catch (e) {
      return { ok: false, message: String(e) };
    }
    const r = interpret(res);
    if (r.ok) {
      item.status = 'done';
      const d = await getDaily();
      d.followed++;
      await store.set(K.daily, d);
      await saveTask(t);
      await log(`[PoC] 已关注 ${atName(item)}`);
      return { ok: true, message: `成功关注 ${atName(item)}`, raw: res };
    }
    item.status = 'failed';
    item.error = r.errorText;
    t.lastError = r.errorText;
    await saveTask(t);
    await log(`[PoC] 关注失败 ${atName(item)}: ${r.errorText}`);
    return { ok: false, message: r.errorText, raw: res };
  }

  // ---------- options 页消息入口 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (halted) { sendResponse({ ok: false, message: 'orphaned content script' }); return true; }
    (async () => {
      try {
        switch (msg && msg.cmd) {
          case 'ping': sendResponse({ ok: true }); break;
          case 'get-captured': sendResponse(await callPage('list-captured', {})); break;
          case 'get-task': sendResponse(await getTask()); break;
          case 'start-task': sendResponse(await startTask(msg.screenName)); break;
          case 'pause-task': await pauseTask('manual'); sendResponse({ ok: true }); break;
          case 'resume-task': sendResponse(await resumeTask()); break;
          case 'refresh-list': sendResponse(await requestRefresh()); break;
          case 'reset-task': await store.set(K.task, null); sendResponse({ ok: true }); break;
          case 'test-follow-one': sendResponse(await testFollowOne()); break;
          default: sendResponse({ ok: false, message: 'unknown cmd' });
        }
      } catch (e) {
        sendResponse({ ok: false, message: String(e) });
      }
    })();
    return true; // async response
  });

  // ---------- x.com 页面状态条 ----------
  let bar = null;
  let cachedTask = null;
  let cachedDaily = { followed: 0 };

  async function refreshCache() {
    cachedTask = await store.get(K.task, null);
    cachedDaily = await getDaily();
  }
  chrome.storage.onChanged.addListener(refreshCache);
  refreshCache();

  function barStyles() {
    return [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
      'display:flex', 'align-items:center', 'gap:12px', 'flex-wrap:wrap',
      'padding:6px 16px', 'background:#1d9bf0', 'color:#fff',
      'font:13px/1.4 -apple-system,system-ui,sans-serif',
      'box-shadow:0 1px 4px rgba(0,0,0,.3)',
    ].join(';');
  }
  function renderBar() {
    if (!bar) return;
    const t = cachedTask || { state: 'idle' };
    const q = t.queue || [];
    const done = q.filter((i) => i.status === 'done').length;
    const failed = q.filter((i) => i.status === 'failed').length;
    const pending = q.filter((i) => i.status === 'pending').length;
    const stateText = {
      idle: '未启动', running: '运行中',
      paused: `已暂停(${t.pauseReason || '?'})`, done: '已完成',
    }[t.state] || t.state;
    // 内容没变就跳过重渲染, 避免打断按钮点击
    const sig = [t.state, t.pauseReason, t.nextAutoResumeAt, pending, done, failed, cachedDaily.followed, t.lastError].join('|');
    if (sig === bar.dataset.sig) return;
    bar.dataset.sig = sig;
    bar.innerHTML = `
      <strong>Refollow</strong>
      <span>状态: ${stateText}${t.state === 'paused' && t.nextAutoResumeAt ? ', ' + Math.max(0, Math.round((t.nextAutoResumeAt - Date.now()) / 60000)) + '分钟后自动恢复' : ''}</span>
      <span>进度: 待回关 ${pending} / 已回关 ${done} / 失败 ${failed}</span>
      <span>今日: ${cachedDaily.followed}</span>
      <span style="margin-left:auto;display:flex;gap:8px">
        <button data-act="start">开始回关</button>
        <button data-act="refresh" title="重新拉取认证粉丝, 新粉丝自动加入队列">更新列表</button>
        <button data-act="pause">暂停</button>
        <button data-act="resume">恢复</button>
        <button data-act="hide" title="收起">×</button>
      </span>
      ${t.lastError ? `<div style="flex-basis:100%;font-size:12px;opacity:.9">最近错误: ${String(t.lastError).slice(0, 200)}</div>` : ''}
    `;
  }
  function ensureBarStyles() {
    if (document.getElementById('refollow-bar-style')) return;
    const style = document.createElement('style');
    style.id = 'refollow-bar-style';
    style.textContent = `
      #refollow-bar button {
        padding: 4px 16px;
        border: none;
        border-radius: 9999px;
        background: #ffffff;
        color: #1d9bf0;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
      }
      #refollow-bar button:hover { background: #e8f5fd; }
      #refollow-bar button[data-act="hide"] {
        background: rgba(255,255,255,.25);
        color: #ffffff;
        padding: 4px 10px;
        font-weight: 400;
      }
      #refollow-bar button[data-act="hide"]:hover { background: rgba(255,255,255,.4); }
      #refollow-bar button:disabled { opacity: .5; cursor: not-allowed; }
    `;
    document.documentElement.appendChild(style);
  }
  function ensureBar() {
    const onVerifiedFollowers = /^\/[^/]+\/verified_followers/.test(location.pathname);
    if (!onVerifiedFollowers) {
      if (bar) { bar.remove(); bar = null; }
      return;
    }
    ensureBarStyles();
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'refollow-bar';
      bar.setAttribute('style', barStyles());
      bar.addEventListener('click', (ev) => {
        const act = ev.target && ev.target.dataset && ev.target.dataset.act;
        if (!act) return;
        ev.preventDefault(); ev.stopPropagation();
        if (act === 'start') {
          const handle = location.pathname.split('/')[1];
          startTask(handle).then((r) => log('状态条启动: ' + (r.message || r.ok)));
        } else if (act === 'refresh') requestRefresh();
        else if (act === 'pause') pauseTask('manual');
        else if (act === 'resume') resumeTask();
        else if (act === 'hide') { bar.remove(); bar = null; }
      });
      document.documentElement.appendChild(bar);
    }
    renderBar();
  }
  intervals.push(setInterval(ensureBar, 1000));
})();
