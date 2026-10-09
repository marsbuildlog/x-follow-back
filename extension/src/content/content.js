// 隔离世界 content script: 页面桥接、拉取器(生产者)、任务执行器(消费者)、x.com 页面状态条。
// 架构: 拉取器与回关循环解耦, 队列(rf_task:{handle})是唯一交界面:
//   拉取器: 翻页拉 BlueVerifiedFollowers → 纯追加合并进队列(不碰已有条目), 429 自行退避重试
//   回关循环: 只消费 pending; 队列空转 done(等待新粉), 拉取器写入新 pending 后自动续跑
// 任务循环跑在 x.com 标签页内(不依赖 MV3 service worker 常驻),
// 数据按账号分键持久化到 chrome.storage.local, 页面刷新/重开后可恢复。
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
  const RESERVED_HANDLES = new Set(['i', 'home', 'explore', 'notifications', 'messages', 'settings', 'search']);

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

  // ---------- 账号 / 按账号分键的数据 ----------
  function curHandle() {
    const m = /^\/([^/]+)(\/|$)/.exec(location.pathname);
    const h = m ? m[1] : '';
    return h && !RESERVED_HANDLES.has(h) ? h : '';
  }
  const taskKey = (h) => `${K.task}:${h}`;
  const dailyKey = (h) => `${K.daily}:${h}`;

  function newTask(handle) {
    return {
      state: 'idle', pauseReason: null, nextAutoResumeAt: null,
      screenName: handle, queue: [], consecutiveFailures: [],
      lastError: null, lastFetchAt: null, updatedAt: 0,
    };
  }
  async function getTask(handle) {
    if (!handle) return newTask('');
    return (await store.get(taskKey(handle), null)) || newTask(handle);
  }
  async function saveTask(handle, t) {
    t.screenName = handle;
    t.updatedAt = Date.now();
    await store.set(taskKey(handle), t);
  }
  async function getDaily(handle) {
    return rolloverDaily(await store.get(dailyKey(handle), null));
  }
  // options/popup 无页面上下文, 通过最近活跃账号定位任务
  async function activeHandle() {
    return runningHandle || curHandle() || (await store.get(K.active, null)) || '';
  }
  async function setActive(handle) {
    if (handle) await store.set(K.active, handle);
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

  // ---------- 领导权锁(防止多标签页同时跑任务/重复拉取) ----------
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
  const { parseFollowers, interpret, mergeUsers, findPendingItem, evaluateStall, rolloverDaily, atName, rateLimitBackoffMs, windowExhaustedWaitMs } = L;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  // 分段休眠(每段≤30s): 后台标签页的定时器会被 Chrome 节流到约1次/分钟,
  // 逐秒 setTimeout 会把十几分钟的等待拖成小时级; 按 deadline 判断则最多慢约 1 分钟
  async function sleepSegments(ms) {
    const deadline = Date.now() + ms;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return true;
      await sleep(Math.min(remaining, 30_000));
    }
  }
  async function sleepInterruptible(ms, handle) {
    // 休眠期间随时检查: 任务被暂停/账号被切换 → 提前退出(返回 false)
    const deadline = Date.now() + ms;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return true;
      await sleep(Math.min(remaining, 30_000));
      const task = await store.get(taskKey(handle), null);
      if (!task || task.state !== 'running') return false;
      if (!(await isLockMine())) return false;
    }
  }
  function nextMidnight() {
    const d = new Date();
    d.setHours(24, 5, 0, 0);
    return d.getTime();
  }

  // 回关: 重放页面自己的 v1.1 REST 请求(friendships/create.json), 仅替换 user_id
  async function followUser(userId) {
    const cap = await callPage('list-captured', {});
    const has = (cap.apiEndpoints || []).some((e) => e.path === FOLLOW_API);
    if (!has) {
      throw new Error('未捕获回关请求——请在本标签页的认证粉丝列表里点一次「回关」按钮(其他页面/标签页捕获不到)');
    }
    return callPage('api', { path: FOLLOW_API, params: { user_id: String(userId) } });
  }

  // ============================================================
  // 拉取器(生产者): 独立于回关循环, 只负责把待回关名单补进队列
  //  - 429 自行按 x-rate-limit-reset 退避重试(最多3次), 不影响回关循环
  //  - 合并是纯追加(mergeUsers 不改已有条目), 与回关循环无写冲突
  // ============================================================
  let fetchingFollowers = false;
  async function runFetch(screenName) {
    if (fetchingFollowers) return { ok: false, message: '已在拉取中, 请等本轮完成' };
    if (!screenName) return { ok: false, message: '缺少 screenName' };
    fetchingFollowers = true;
    try {
      const cap = await callPage('list-captured', {});
      const entry = (cap.operations || []).find((o) => o.operationName === OP_FOLLOWERS);
      if (!entry) {
        const msg = `未捕获到 ${OP_FOLLOWERS} 请求——请先打开 /${screenName}/verified_followers 页面并等它加载完`;
        await log('⚠ ' + msg);
        return { ok: false, message: msg };
      }

      // 计时起点: 手动/自动一视同仁, 成功失败都算(失败也等下一个周期再试, 避免连打)
      const t0 = await getTask(screenName);
      t0.lastFetchAt = Date.now();
      await saveTask(screenName, t0);

      const settings = await getSettings();
      const count = 100;
      const MAX_PAGES = 500; // 100/页 → 5万认证粉丝上限
      const all = [];
      let cursor = null;
      let page = 0;
      let retries = 0;
      let incomplete = false;
      while (page < MAX_PAGES) {
        const variables = { ...(entry.variables || {}), count, cursor };
        delete variables.screen_name;
        const res = await callGraphQL(OP_FOLLOWERS, variables);
        if (res.status === 429) {
          // 拉取被限流: 等 reset 后重试同一页; 连续3次仍限流 → 先合并已拉到的部分
          if (++retries > 3) {
            incomplete = true;
            await log('拉取连续限流, 本轮先合并已拉到的部分, 下个周期再补');
            break;
          }
          const backoff = rateLimitBackoffMs(interpret(res), Date.now(), settings.rateLimitBackoffMin * 60_000);
          await log(`拉取限流, ${Math.round(backoff / 1000)}秒后重试第${page + 1}页`);
          await sleepSegments(backoff);
          continue;
        }
        retries = 0;
        const parsed = parseFollowers(res.body);
        if (parsed.error) throw new Error(parsed.error);
        if (page === 0 && parsed.firstRaw) {
          await log('用户对象结构样本: ' + parsed.firstRaw);
          if (parsed.followFields) await log('含follow的字段: ' + parsed.followFields);
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
        page++;
        await sleep(800 + Math.random() * 700);
      }
      if (page >= MAX_PAGES) incomplete = true;

      // 按 userId 去重后纯追加合并
      const seen = new Set();
      const users = all.filter((u) => (seen.has(u.userId) ? false : (seen.add(u.userId), true)));
      const t = await getTask(screenName);
      const added = mergeUsers(t, users);
      await saveTask(screenName, t);
      const pendingCount = t.queue.filter((q) => q.status === 'pending').length;
      await log(`列表更新${incomplete ? '(可能不全)' : ''}: 本次拉取${users.length}(新增${added}), 总数${t.queue.length}, 待回关${pendingCount}`);

      // 等待新粉(done)状态下拉到新 pending → 自动续跑; idle(用户还没启动过)不自动开跑
      if (t.state === 'done' && pendingCount > 0) {
        t.state = 'running';
        t.pauseReason = null;
        t.nextAutoResumeAt = null;
        await saveTask(screenName, t);
        await log('检测到新待回关, 自动续跑');
        runLoop(screenName);
      }
      return {
        ok: true,
        message: `本次拉取${users.length}(新增${added}), 总数${t.queue.length}, 待回关${pendingCount}`,
        total: t.queue.length,
      };
    } catch (e) {
      await log(`拉取失败: ${e}`);
      return { ok: false, message: String(e) };
    } finally {
      fetchingFollowers = false;
      await store.set(K.fetchProgress, null);
    }
  }

  // 「更新列表」请求: 运行中由主循环消费, 空闲/暂停由观察器消费(统一走拉取器)
  async function requestRefresh() {
    const handle = curHandle();
    if (!handle) return { ok: false, message: '请在目标账号的 verified_followers 页面上操作' };
    await store.set(K.refreshRequest, { screenName: handle, ts: Date.now() });
    await log(`已请求更新认证粉丝列表(@${handle})`);
    return { ok: true, message: '已请求更新列表, 几秒内自动执行, 结果看日志' };
  }
  async function processRefreshRequest() {
    const req = await store.get(K.refreshRequest, null);
    if (!req) return false;
    await store.set(K.refreshRequest, null); // 先清标记防重复执行
    if (!fetchingFollowers) runFetch(req.screenName);
    return true;
  }

  // ============================================================
  // 任务状态机 + 回关循环(消费者)
  // ============================================================
  let runningHandle = null; // 本标签页正在跑回关的账号(同一时间只跑一个)
  async function pauseTask(handle, reason, resumeAt) {
    const t = await getTask(handle);
    t.state = 'paused';
    t.pauseReason = reason;
    t.nextAutoResumeAt = resumeAt || null;
    await saveTask(handle, t);
    await log(`任务暂停(${reason})`);
  }
  async function resumeTask(handle) {
    const t = await getTask(handle);
    if (t.state !== 'paused' && t.state !== 'idle') return t;
    // 失败项重新入队重试
    for (const item of t.queue) {
      if (item.status === 'failed') { item.status = 'pending'; item.error = null; }
    }
    t.state = 'running';
    t.pauseReason = null;
    t.nextAutoResumeAt = null;
    await saveTask(handle, t);
    await log('任务恢复');
    runLoop(handle);
    return t;
  }

  async function startTask(screenName) {
    screenName = (screenName || '').replace(/\/+$/, '') || curHandle();
    if (!screenName) {
      return { ok: false, message: '缺少 screenName——请在目标账号的 verified_followers 页面上操作' };
    }
    if (runningHandle) {
      return { ok: false, message: `任务已在运行(@${runningHandle}), 一个标签页同一时间只跑一个账号` };
    }
    const t = await getTask(screenName);
    const pendingCount = t.queue.filter((q) => q.status === 'pending').length;
    t.state = 'running';
    t.pauseReason = null;
    t.nextAutoResumeAt = null;
    t.lastError = null;
    await saveTask(screenName, t);
    await log(`任务启动: 总数${t.queue.length}, 待回关${pendingCount}`);
    // 生产/消费解耦: 队列空不阻塞启动, 先跑起来, 拉取器后台补货
    if (pendingCount === 0 && !fetchingFollowers) runFetch(screenName);
    runLoop(screenName);
    return {
      ok: true,
      message: `总数${t.queue.length}, 待回关${pendingCount}` + (pendingCount === 0 ? '(已触发拉取, 拉到后自动续跑)' : ''),
      total: t.queue.length,
    };
  }

  // ---------- 主循环(消费者) ----------
  let loopRunning = false;
  async function runLoop(handle) {
    if (loopRunning || !handle) return;
    if (!(await acquireLock())) return;
    loopRunning = true;
    runningHandle = handle;
    try {
      let task = await store.get(taskKey(handle), null);
      if (!task || task.state !== 'running') return;

      while (true) {
        await refreshLock();
        if (!task || task.state !== 'running') break;
        const settings = await getSettings();
        const item = task.queue.find((i) => i.status === 'pending');
        if (!item) {
          task.state = 'done';
          await saveTask(handle, task);
          await log('队列已空, 等待新粉丝(自动/手动拉取到新待回关后会自动续跑)');
          break;
        }

        // 随机间隔(模拟人工)
        const delayMs = randInt(settings.intervalMin, settings.intervalMax) * 1000;
        if (!(await sleepInterruptible(delayMs, handle))) break;

        // 重读 task 后旧 item 引用已失效, 按 userId 重新定位。
        // (否则"已完成"标在旧快照上, 存储里仍是 pending, 会重复关注同一人)
        task = await store.get(taskKey(handle), null);
        if (!task || task.state !== 'running') break;
        if (!(await isLockMine())) break;
        const current = findPendingItem(task.queue, item.userId);
        if (!current) continue; // 已被其他流程处理, 换下一个

        const res = await followUser(current.userId);
        const r = interpret(res);

        if (r.ok) {
          current.status = 'done';
          current.doneAt = Date.now();
          current.error = null;
          task.consecutiveFailures = [];
          await saveTask(handle, task); // 先落库(get→改→存之间无 await, 不会被拉取器插入)
          const d = await getDaily(handle);
          d.followed++;
          await store.set(dailyKey(handle), d);
          await log(`已关注 ${atName(current)}, 今日 ${d.followed}`);
          // 主动限流: 窗口次数耗尽时等到 reset 再发下一个, 避免吃 429
          const pw = windowExhaustedWaitMs(r, Date.now());
          if (pw > 0) {
            await log(`本窗口次数已用完(remaining=0), ${Math.round(pw / 1000)}秒后窗口重置自动继续`);
            if (!(await sleepInterruptible(pw, handle))) break;
          }
        } else {
          current.status = 'failed';
          current.error = r.errorText;
          task.lastError = `${atName(current)}: ${r.errorText}`;
          task.consecutiveFailures.push(Date.now());
          const stall = evaluateStall(task.consecutiveFailures, Date.now(), settings.stallMin * 60_000, settings.stallMin * 60_000);
          task.consecutiveFailures = stall.kept;
          await saveTask(handle, task); // 先落库
          await log(`关注失败 ${atName(current)}: ${r.errorText}`);

          if (r.followLimited) {
            // 161: 达到关注上限 → 视同当日额度用完
            await pauseTask(handle, 'daily-limit', nextMidnight());
          } else if (r.rateLimited) {
            // 429/88: 按响应头 x-rate-limit-reset 精确等到窗口重置; 无头时退回固定退避; 不直接算 stall
            const backoff = rateLimitBackoffMs(r, Date.now(), settings.rateLimitBackoffMin * 60_000);
            if (backoff <= 0) {
              await log('限流但窗口已重置, 立即重试');
            } else if (r.rateReset) {
              await log(`限流, 窗口 ${new Date(r.rateReset * 1000).toLocaleTimeString()} 重置, ${Math.round(backoff / 1000)}秒后自动继续`);
            } else {
              await log(`限流(响应头无 reset), 退避 ${settings.rateLimitBackoffMin} 分钟`);
            }
            if (!(await sleepInterruptible(backoff, handle))) break;
          } else if (stall.shouldPause) {
            await pauseTask(handle, 'stalled', Date.now() + settings.autoResumeMin * 60_000);
          }
        }
        task = await store.get(taskKey(handle), null);
        if (!task || task.state !== 'running') break;
      }
    } finally {
      loopRunning = false;
      runningHandle = null;
    }
  }

  // ---------- 自动恢复 / 自动拉取观察器 ----------
  async function autoTick() {
    const handle = curHandle();
    if (handle) setActive(handle);
    await processRefreshRequest(); // 消费「更新列表」请求(运行中由主循环处理, 这里管空闲/暂停态)
    if (!handle) return;
    if (fetchingFollowers) return;

    // 自动拉取: 页面可见 + 距上次拉取(含手动)超过 autoFetchMin 分钟
    const settings = await getSettings();
    const t0 = await getTask(handle);
    if (document.visibilityState === 'visible' &&
        (!t0.lastFetchAt || Date.now() - t0.lastFetchAt >= settings.autoFetchMin * 60_000)) {
      if (await acquireLock()) runFetch(handle);
      return;
    }

    // 页面刷新后接管中断的任务
    if (t0.state === 'running') {
      if (!loopRunning && !(await isLockMine()) && (await acquireLock())) runLoop(handle);
      return;
    }
    // 暂停到期自动恢复
    if (t0.state === 'paused' && t0.nextAutoResumeAt && Date.now() >= t0.nextAutoResumeAt) {
      if (await acquireLock()) resumeTask(handle);
    }
  }
  intervals.push(setInterval(autoTick, 30_000));
  autoTick();

  // ---------- PoC 单点测试 ----------
  async function testFollowOne(handle) {
    const t = await getTask(handle);
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
      item.doneAt = Date.now();
      item.error = null;
      await saveTask(handle, t);
      const d = await getDaily(handle);
      d.followed++;
      await store.set(dailyKey(handle), d);
      await log(`[PoC] 已关注 ${atName(item)}`);
      return { ok: true, message: `成功关注 ${atName(item)}`, raw: res };
    }
    item.status = 'failed';
    item.error = r.errorText;
    t.lastError = r.errorText;
    await saveTask(handle, t);
    await log(`[PoC] 关注失败 ${atName(item)}: ${r.errorText}`);
    return { ok: false, message: r.errorText, raw: res };
  }

  // ---------- options 页消息入口 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (halted) { sendResponse({ ok: false, message: 'orphaned content script' }); return true; }
    (async () => {
      try {
        const h = await activeHandle();
        switch (msg && msg.cmd) {
          case 'ping': sendResponse({ ok: true }); break;
          case 'get-captured': sendResponse(await callPage('list-captured', {})); break;
          case 'get-task': sendResponse(h ? { ...(await getTask(h)), daily: await getDaily(h) } : null); break;
          case 'start-task': sendResponse(await startTask(msg.screenName)); break;
          case 'pause-task': await pauseTask(h, 'manual'); sendResponse({ ok: true }); break;
          case 'resume-task': sendResponse(await resumeTask(h)); break;
          case 'refresh-list': sendResponse(await requestRefresh()); break;
          case 'reset-task': await store.set(taskKey(h), null); sendResponse({ ok: true }); break;
          case 'test-follow-one': sendResponse(await testFollowOne(h)); break;
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
    const h = curHandle() || (await store.get(K.active, null));
    cachedTask = h ? await getTask(h) : null;
    cachedDaily = h ? await getDaily(h) : { followed: 0 };
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
    const total = q.length;
    const pending = q.filter((i) => i.status === 'pending').length;
    const stateText = {
      idle: '未启动', running: '运行中',
      paused: `已暂停(${t.pauseReason || '?'})`, done: '等待新粉',
    }[t.state] || t.state;
    // 内容没变就跳过重渲染, 避免打断按钮点击
    const sig = [t.state, t.pauseReason, t.nextAutoResumeAt, total, pending, cachedDaily.followed, t.lastError].join('|');
    if (sig === bar.dataset.sig) return;
    bar.dataset.sig = sig;
    bar.innerHTML = `
      <strong>Refollow</strong>
      <span>状态: ${stateText}${t.state === 'paused' && t.nextAutoResumeAt ? ', ' + Math.max(0, Math.round((t.nextAutoResumeAt - Date.now()) / 60000)) + '分钟后自动恢复' : ''}</span>
      <span>总数: ${total} · 待回关: ${pending}</span>
      <span>今日已回关: ${cachedDaily.followed}</span>
      <span style="margin-left:auto;display:flex;gap:8px">
        <button data-act="start">开始回关</button>
        <button data-act="refresh" title="重新拉取认证粉丝, 新粉丝自动加入队列, 并重置自动拉取计时">更新列表</button>
        <button data-act="pause">暂停</button>
        <button data-act="resume">恢复</button>
        <button data-act="hide" title="收起">×</button>
      </span>
      ${t.lastError ? `<div style="flex-basis:100%;font-size:12px;opacity:.9">最近错误: ${String(t.lastError).slice(0, 200)}</div>` : ''}
    `;
  }
  function ensureBarStyles() {
    const style = document.getElementById('refollow-bar-style');
    if (style) return;
    const el = document.createElement('style');
    el.id = 'refollow-bar-style';
    el.textContent = `
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
    document.documentElement.appendChild(el);
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
        const handle = curHandle();
        if (act === 'start') {
          startTask(handle).then((r) => log('状态条启动: ' + (r.message || r.ok)));
        } else if (act === 'refresh') requestRefresh();
        else if (act === 'pause') pauseTask(handle, 'manual');
        else if (act === 'resume') resumeTask(handle);
        else if (act === 'hide') { bar.remove(); bar = null; }
      });
      document.documentElement.appendChild(bar);
    }
    renderBar();
  }
  intervals.push(setInterval(ensureBar, 1000));

  // 清理旧版单账号键(改为按账号分键前的遗留数据)
  chrome.storage.local.remove(['rf_task', 'rf_daily']);
})();
