// 隔离世界 content script: 页面桥接、拉取器(生产者)、任务执行器(消费者)、x.com 页面状态条。
// 架构: 拉取器与回关循环解耦, 队列(rf_task:{handle})是唯一交界面:
//   拉取器: 翻页拉 BlueVerifiedFollowers → 纯追加合并进队列(不碰已有条目), 429 自行退避重试
//   回关循环: 只消费 pending; 队列空转 done(等待新粉), 拉取器写入新 pending 后自动续跑
// 任务循环跑在 x.com 标签页内(不依赖 MV3 service worker 常驻),
// 数据按账号分键持久化到 chrome.storage.local, 页面刷新/重开后可恢复。
(async () => {
  'use strict';

  // 重复注入守卫: 控制台会在页面早于插件打开时用 scripting API 补注入,
  // 活体实例直接退出; 孤儿实例在 halt() 时清除本标记并让出消息通道, 让新实例接管。
  if (window.__rfUiAlive) return;
  window.__rfUiAlive = true;

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
  let msgHandler = null;
  function halt() {
    if (halted) return;
    halted = true;
    delete window.__rfUiAlive;                 // 让出重复注入守卫, 新实例可接管
    for (const id of intervals) clearInterval(id);
    try { if (msgHandler) chrome.runtime.onMessage.removeListener(msgHandler); } catch {}
    try {
      document.getElementById('refollow-widget')?.remove(); // 新版悬浮控件
      document.getElementById('refollow-bar')?.remove();     // 旧版顶部横条(升级兼容清理)
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

  // 「更新列表」: 立即触发拉取器(拉取与回关解耦, 运行中也可直接拉, 纯追加合并不冲突)
  async function requestRefresh() {
    const handle = curHandle();
    if (!handle) return { ok: false, message: '请在目标账号的 verified_followers 页面上操作' };
    if (fetchingFollowers) return { ok: false, message: '已在拉取中, 请等本轮完成' };
    await log(`手动更新认证粉丝列表(@${handle})`);
    runFetch(handle); // fire and forget, 进度见状态行"拉取中"
    return { ok: true, message: '已开始更新列表' };
  }

  // ============================================================
  // 任务状态机 + 回关循环(消费者)
  // ============================================================
  let runningHandle = null; // 本标签页正在跑回关的账号(同一时间只跑一个)

  // 自动暂停时发系统通知(带系统声音), 避免用户以为还在正常跑
  const PAUSE_ALERTS = {
    'template-expired': '回关模板已过期: 请在认证粉丝列表点一次「回关」, 然后点「恢复」',
    'daily-limit': '今日关注已超过上限, 明天 00:05 自动恢复',
    'stalled': '连续失败超过阈值, 稍后自动恢复',
    'error': '连续请求异常, 稍后自动恢复',
  };
  function notifyPause(reason) {
    // chrome.notifications 仅扩展页面可用, 经 background SW 代理; 同 tag 覆盖旧通知防堆积
    try {
      const p = chrome.runtime.sendMessage({
        cmd: 'notify',
        tag: 'pause-' + reason,
        title: 'Refollow 已暂停',
        message: PAUSE_ALERTS[reason] || reason,
      });
      if (p && p.catch) p.catch(() => {});
    } catch {} // 孤儿/通知失败不影响主流程
  }
  async function pauseTask(handle, reason, resumeAt) {
    const t = await getTask(handle);
    t.state = 'paused';
    t.pauseReason = reason;
    t.nextAutoResumeAt = resumeAt || null;
    await saveTask(handle, t);
    await log(`任务暂停(${reason})`);
    if (reason !== 'manual') notifyPause(reason);
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
    // 首次使用守卫: 回关模板未捕获时关注必然失败 → 引导先完成一次手动回关
    // (拉取不受影响, 打开页面后观察器会自动补拉)
    try {
      const cap = await callPage('list-captured', {});
      if (!(cap.apiEndpoints || []).some((e) => e.path === FOLLOW_API)) {
        return { ok: false, message: '首次使用: 请先在认证粉丝列表里点一次任意用户的「回关」按钮, 再点开始回关' };
      }
    } catch {}
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
      let rateRetryUserId = null; // B: 429 重试同一人计数
      let rateRetryCount = 0;
      let errorStreak = 0;        // C: 请求层连续异常计数

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

        let res;
        try {
          res = await followUser(current.userId);
        } catch (e) {
          // C: 请求层异常(模板未捕获/桥超时等) → 记日志, 连续 2 次才暂停, 避免静默死亡循环
          errorStreak++;
          await log(`关注请求异常(${errorStreak}/2) ${atName(current)}: ${e}`);
          if (errorStreak >= 2) {
            await pauseTask(handle, 'error', Date.now() + settings.autoResumeMin * 60_000);
            break;
          }
          await sleep(5_000);
          continue; // 未标记失败, 重试同一人
        }
        const r = interpret(res);
        errorStreak = 0;

        if (r.ok) {
          rateRetryUserId = null;
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
        } else if (r.rateLimited) {
          // B: 429/88 是环境问题不是这个人的问题 → 不标失败不进 stall,
          // 等窗口重置后重试同一人; 连续超过 3 次才标 failed 跳过
          if (rateRetryUserId !== item.userId) { rateRetryUserId = item.userId; rateRetryCount = 1; }
          else rateRetryCount++;
          const backoff = rateLimitBackoffMs(r, Date.now(), settings.rateLimitBackoffMin * 60_000);
          if (rateRetryCount > 3) {
            current.status = 'failed';
            current.error = `连续限流 ${rateRetryCount} 次: ${r.errorText}`;
            task.lastError = `${atName(current)}: ${current.error}`;
            await saveTask(handle, task);
            await log(`关注失败 ${atName(current)}: 连续限流, 暂时跳过(恢复时重新入队)`);
            rateRetryUserId = null;
          } else {
            const resetTxt = r.rateReset ? ', 窗口 ' + new Date(r.rateReset * 1000).toLocaleTimeString() + ' 重置' : '';
            await log(`限流(${rateRetryCount}/3)${resetTxt}, ${Math.round(backoff / 1000)}秒后重试同一人 ${atName(current)}`);
            if (!(await sleepInterruptible(backoff, handle))) break;
          }
        } else {
          // 其他失败: 标 failed, 记原始错误
          rateRetryUserId = null;
          current.status = 'failed';
          current.error = r.errorText;
          task.lastError = `${atName(current)}: ${r.errorText}`;
          if (r.followLimited) {
            // 161: 今日关注已超过上限(实测包在 HTTP 403 里返回) → 当日额度用完, 暂停至次日
            await saveTask(handle, task);
            await log('今日关注已超过上限: 暂停至明日 00:05 自动恢复');
            await pauseTask(handle, 'daily-limit', nextMidnight());
          } else if (res.status === 403) {
            // 403 且非 161: 大概率回关模板过期 → 立即暂停 + 系统通知, 不空转烧请求
            await saveTask(handle, task);
            await log(`模板过期(403) ${atName(current)}: 请在认证粉丝列表点一次「回关」刷新模板, 然后手动恢复`);
            await pauseTask(handle, 'template-expired');
          } else {
            task.consecutiveFailures.push(Date.now());
            const stall = evaluateStall(task.consecutiveFailures, Date.now(), settings.stallMin * 60_000, settings.stallMin * 60_000);
            task.consecutiveFailures = stall.kept;
            await saveTask(handle, task); // 先落库
            await log(`关注失败 ${atName(current)}: ${r.errorText}`);
            if (stall.shouldPause) {
              await pauseTask(handle, 'stalled', Date.now() + settings.autoResumeMin * 60_000);
            }
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
  msgHandler = (msg, sender, sendResponse) => {
    if (halted) return false; // 孤儿不响应也不占通道, 让新注入的实例接管
    (async () => {
      try {
        const h = await activeHandle();
        switch (msg && msg.cmd) {
          case 'ping': sendResponse({ ok: true }); break;
          case 'get-captured': sendResponse(await callPage('list-captured', {})); break;
          case 'get-task': {
            const t = h ? { ...(await getTask(h)), daily: await getDaily(h) } : null;
            if (t) {
              try {
                const cap = await callPage('list-captured', {});
                t.templateCaptured = (cap.apiEndpoints || []).some((e) => e.path === FOLLOW_API);
              } catch { t.templateCaptured = null; }
            }
            sendResponse(t);
            break;
          }
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
  };
  chrome.runtime.onMessage.addListener(msgHandler);

  // ---------- x.com 页面悬浮控件(右上角 pill, 点击展开面板) ----------
  // 不占页面流、不遮挡内容; pill 常显核心数字, 需要用户操作时变红脉动
  let widget = null;
  let panelOpen = false;
  let panelMsg = null; // 操作反馈行(几秒后自动消失)
  let panelMsgTimer = null;
  let cachedTemplateCaptured = null; // 回关模板是否已捕获(null=未知)
  let tplTick = 0;
  function setPanelMsg(text) {
    panelMsg = text;
    clearTimeout(panelMsgTimer);
    panelMsgTimer = setTimeout(() => { panelMsg = null; renderWidget(); }, 5000);
    renderWidget();
  }
  let cachedTask = null;
  let cachedFetchProgress = null;

  const WIDGET_CSS = `
    #refollow-widget { position: fixed; top: 20px; z-index: 99999; display: flex; flex-direction: column; align-items: flex-end;
      pointer-events: none; font: 13px/1.5 -apple-system, system-ui, sans-serif; }
    #refollow-widget > * { pointer-events: auto; }
    #refollow-pill { display: flex; align-items: center; gap: 8px; padding: 8px 18px; border-radius: 9999px;
      background: #1d9bf0; color: #fff; border: 1px solid #1a8cd8; box-shadow: 0 2px 12px rgba(0,0,0,.25);
      cursor: pointer; user-select: none; white-space: nowrap; font-weight: 700; }
    #refollow-pill:hover { background: #1a8cd8; }
    #refollow-pill .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px rgba(255,255,255,.85); }
    #refollow-pill.alert { background: #dc2626; border-color: #dc2626; animation: refollowPulse 1.2s ease-in-out infinite; }
    @keyframes refollowPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.07); } }
    #refollow-panel { position: absolute; top: calc(100% + 8px); right: 0; width: 340px;
      background: #fff; color: #0f1419; border: 1px solid #e1e8ed;
      border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.22); padding: 14px 16px; }
    #refollow-panel .rf-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
    #refollow-panel .rf-head span { color: #536471; font-size: 12px; }
    #refollow-panel .rf-status { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    #refollow-panel .rf-status .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
    #refollow-panel .rf-nums { margin-bottom: 8px; }
    #refollow-panel .rf-nums b { font-size: 16px; }
    #refollow-panel .rf-alert { background: #fdecec; color: #b02a37; border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-bottom: 8px; font-weight: 700; }
    #refollow-panel .rf-err { color: #b02a37; font-size: 12px; margin-bottom: 8px; word-break: break-all; }
    #refollow-panel .rf-btns { display: flex; gap: 8px; margin-bottom: 8px; }
    #refollow-panel .rf-guide { background: #e8f5fd; color: #0b5ed7; border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-bottom: 8px; font-weight: 700; }
    #refollow-panel .rf-msg { background: #e8f5fd; color: #0b5ed7; border-radius: 8px; padding: 6px 10px; font-size: 12px; margin-bottom: 8px; font-weight: 700; }
    #refollow-panel .rf-keep { color: #b45309; font-size: 12px; background: #fff7ed; border-radius: 8px; padding: 6px 10px; }
    #refollow-widget .rf-btn { padding: 7px 20px; border-radius: 9999px; font-weight: 700; font-size: 13px; cursor: pointer; border: none; }
    #refollow-widget .rf-btn.primary { background: #1d9bf0; color: #fff; }
    #refollow-widget .rf-btn.primary:hover { background: #1a8cd8; }
    #refollow-widget .rf-btn.warn { background: #dc2626; color: #fff; }
    #refollow-widget .rf-btn.warn:hover { background: #b91c1c; }
    #refollow-widget .rf-btn.ghost { background: #fff; color: #1d9bf0; border: 1px solid #1d9bf0; font-weight: 400; }
    #refollow-widget .rf-btn.ghost:hover { background: #e8f5fd; }
  `;
  const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

  // 状态 → 文案/颜色; alert=true 表示需要用户立即操作(pill 红色脉动)
  const STATE_STYLE = {
    idle: { text: '未启动', color: '#536471' },
    running: { text: '运行中', color: '#1d9bf0' },
    fetching: { text: '拉取中', color: '#7c3aed' },
    'paused:manual': { text: '已暂停·手动', color: '#d97706' },
    'paused:stalled': { text: '已暂停·连续失败', color: '#d97706' },
    'paused:daily-limit': { text: '今日已达上限', color: '#d97706' },
    'paused:template-expired': { text: '模板过期', color: '#dc2626', alert: true },
    'paused:error': { text: '已暂停·连续异常', color: '#dc2626' },
    done: { text: '等待新粉', color: '#16a34a' },
  };
  function currentState(t) {
    if (!t) return STATE_STYLE.idle;
    if (t.state === 'running') return cachedFetchProgress ? STATE_STYLE.fetching : STATE_STYLE.running;
    if (t.state === 'paused') return STATE_STYLE['paused:' + t.pauseReason] || { text: '已暂停', color: '#d97706' };
    if (t.state === 'done') return STATE_STYLE.done;
    return STATE_STYLE.idle;
  }

  async function refreshCache() {
    const h = curHandle() || (await store.get(K.active, null));
    cachedTask = h ? await getTask(h) : null;
    cachedFetchProgress = await store.get(K.fetchProgress, null);
  }
  chrome.storage.onChanged.addListener(refreshCache);
  refreshCache();

  function renderWidget() {
    if (!widget) return;
    const t = cachedTask || { state: 'idle' };
    const q = t.queue || [];
    const total = q.length;
    const pending = q.filter((i) => i.status === 'pending').length;
    const st = currentState(t);
    const sig = [t.state, t.pauseReason, t.nextAutoResumeAt, total, pending, st.text, panelOpen, panelMsg, cachedTemplateCaptured,
      cachedFetchProgress ? cachedFetchProgress.page : 0, t.lastError, t.screenName].join('|');
    if (sig === widget.dataset.sig) return; // 内容没变跳过重渲染, 避免打断点击
    widget.dataset.sig = sig;

    const pill = widget.querySelector('#refollow-pill');
    if (st.alert) {
      pill.classList.add('alert');
      pill.textContent = `⚠ ${st.text} · 点击处理`;
    } else {
      pill.classList.remove('alert');
      pill.innerHTML = `<span class="dot" style="background:${st.color}"></span>待回关 ${pending}`;
    }

    const panel = widget.querySelector('#refollow-panel');
    const pauseHint = t.state === 'paused' && t.nextAutoResumeAt
      ? ' · ' + Math.max(0, Math.round((t.nextAutoResumeAt - Date.now()) / 60000)) + '分钟后自动恢复' : '';
    const fetchInfo = cachedFetchProgress ? ` · 第${cachedFetchProgress.page}页/累计${cachedFetchProgress.users}人` : '';
    const actionBtn = t.state === 'running'
      ? `<button class="rf-btn primary" data-act="pause">暂停</button>`
      : t.state === 'paused'
        ? `<button class="rf-btn ${st.alert ? 'warn' : 'primary'}" data-act="resume">恢复</button>`
        : `<button class="rf-btn primary" data-act="start">开始回关</button>`;
    panel.innerHTML = `
      <div class="rf-head"><strong>Refollow</strong><span>@${escHtml(t.screenName) || '—'}</span></div>
      <div class="rf-status"><span class="dot" style="background:${st.color}"></span>${st.text}${pauseHint}${fetchInfo}</div>
      <div class="rf-nums">总数 <b>${total}</b> · 待回关 <b>${pending}</b></div>
      ${cachedTemplateCaptured === false ? `<div class="rf-guide">首次使用: 请在下方列表中手动点一次任意用户的「回关」按钮, 插件即可学会自动回关(只需一次)</div>` : ''}
      ${st.alert ? `<div class="rf-alert">回关模板已过期——请在本列表点一次 X 的「回关」按钮, 再点「恢复」</div>` : ''}
      ${panelMsg ? `<div class="rf-msg">${escHtml(panelMsg)}</div>` : ''}
      ${t.lastError ? `<div class="rf-err">最近错误: ${escHtml(t.lastError).slice(0, 160)}</div>` : ''}
      <div class="rf-btns">${actionBtn}<button class="rf-btn ghost" data-act="refresh">更新列表</button></div>
      <div class="rf-keep">⏳ 任务在此页面内运行, 请保持标签页开启——关闭后会暂停, 重新打开会自动继续</div>
    `;
  }

  // 定位: 紧贴认证关注者页顶部姓名(h2)右侧一点点, 垂直在姓名行父容器内居中;
  // h2 不可得时退回主列右缘, 再退回右上角
  function positionWidget() {
    if (!widget) return;
    const col = document.querySelector('[data-testid="primaryColumn"]');
    const h2 = col && (col.querySelector('h2[role="heading"]') || col.querySelector('h2'));
    if (h2) {
      // 父容器太矮(纯名字包装层)时向上找有高度的行容器, 最多3层
      let box = h2.getBoundingClientRect();
      let parent = h2.parentElement;
      for (let i = 0; i < 3 && parent && parent !== document.body; i++) {
        const r = parent.getBoundingClientRect();
        if (r.height >= 30) { box = r; break; }
        parent = parent.parentElement;
      }
      const hr = h2.getBoundingClientRect();
      const pill = widget.querySelector('#refollow-pill');
      const pillH = (pill && pill.offsetHeight) || 36;
      widget.style.left = Math.round(hr.right + 12) + 'px';
      widget.style.top = Math.round(box.top + box.height / 2 - pillH / 2) + 'px';
      widget.style.width = 'auto';
      widget.style.right = 'auto';
      return;
    }
    if (col) {
      const r = col.getBoundingClientRect();
      widget.style.left = Math.round(r.left) + 'px';
      widget.style.width = Math.round(r.width) + 'px';
      widget.style.right = 'auto';
    } else {
      widget.style.left = 'auto';
      widget.style.width = 'auto';
      widget.style.right = '16px';
    }
  }

  function ensureBar() {
    const onVerifiedFollowers = /^\/[^/]+\/verified_followers/.test(location.pathname);
    if (!onVerifiedFollowers) {
      if (widget) { widget.remove(); widget = null; }
      return;
    }
    // 每5秒检查一次回关模板捕获状态(捕获发生在 MAIN world 内存, storage 变化感知不到)
    if (++tplTick % 5 === 1 || cachedTemplateCaptured == null) {
      callPage('list-captured', {}).then((cap) => {
        const v = !!(cap && (cap.apiEndpoints || []).some((e) => e.path === FOLLOW_API));
        if (v !== cachedTemplateCaptured) {
          cachedTemplateCaptured = v;
          if (v && panelOpen) setPanelMsg('✓ 模板已捕获, 可以点「开始回关」了');
          renderWidget();
        }
      }).catch(() => {});
    }
    if (!widget) {
      widget = document.createElement('div');
      widget.id = 'refollow-widget';
      widget.innerHTML = `<style>${WIDGET_CSS}</style><div id="refollow-pill"></div><div id="refollow-panel" style="display:none"></div>`;
      widget.addEventListener('click', (ev) => {
        const panel = widget.querySelector('#refollow-panel');
        const act = ev.target && ev.target.dataset && ev.target.dataset.act;
        if (act) {
          ev.preventDefault(); ev.stopPropagation();
          const handle = curHandle();
          if (act === 'start') startTask(handle).then((r) => setPanelMsg(r.message || '已启动'));
          else if (act === 'refresh') requestRefresh().then((r) => setPanelMsg(r.message || String(r.ok)));
          else if (act === 'pause') pauseTask(handle, 'manual').then(() => setPanelMsg('已暂停'));
          else if (act === 'resume') resumeTask(handle).then(() => setPanelMsg('已恢复'));
          return;
        }
        if (ev.target.closest('#refollow-pill')) {
          panelOpen = !panelOpen;
          panel.style.display = panelOpen ? 'block' : 'none';
          renderWidget();
        }
      });
      document.documentElement.appendChild(widget);
    }
    positionWidget();
    renderWidget();
  }
  // 孤儿自检: 插件被 reload 后 1 秒内触发 halt(), 清守卫标记/移除监听器, 不阻挡新实例接管
  intervals.push(setInterval(() => { if (!ctxValid()) return; ensureBar(); }, 1000));
  // 清理旧版单账号键(改为按账号分键前的遗留数据)
  chrome.storage.local.remove(['rf_task', 'rf_daily']);
})();
