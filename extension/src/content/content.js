// 隔离世界 content script: 页面桥接、拉取器(生产者)、任务执行器(消费者)、x.com 页面状态条。
// 架构: 拉取器与关注循环解耦, 队列是唯一交界面:
//   回关: 拉取器翻页拉 BlueVerifiedFollowers → 纯追加合并进 rf_task:{handle}
//   主动关注: 搜索/扫描器(互关标签页)把候选人写进 rf_af_task:{handle}(见 CONTEXT.md/ADR-0001)
//   关注循环: 逐条优先(ADR-0001)——每取下一个人先查回关队列再查主动关注队列, 共享账号级每日计数与限流退避
// 任务循环跑在 x.com 标签页内(不依赖 MV3 service worker 常驻),
// 数据按账号分键持久化到 chrome.storage.local, 页面刷新/重开后可恢复。
(async () => {
  'use strict';

  // 重复注入守卫: 控制台会在页面早于插件打开时用 scripting API 补注入,
  // 活体实例直接退出; 孤儿实例在 halt() 时清除本标记并让出消息通道, 让新实例接管。
  if (window.__rfUiAlive) return;
  window.__rfUiAlive = true;

  // 依赖模块显式加载(不依赖 manifest 里的多文件注入顺序):
  // constants.js 挂 globalThis.RF, logic.js 挂 globalThis.XFollowBackLogic
  try {
    await import(chrome.runtime.getURL('src/shared/constants.js'));
    await import(chrome.runtime.getURL('src/shared/logic.js'));
    await import(chrome.runtime.getURL('src/shared/tidpool.js'));
    await import(chrome.runtime.getURL('src/shared/route1.js'));
  } catch (e) {
    throw new Error('[XFollowBack] 依赖模块动态加载失败: ' + ((e && e.message) || e));
  }
  const RFg = globalThis.RF;
  const L = globalThis.XFollowBackLogic;
  if (!RFg || !L) {
    throw new Error('[XFollowBack] 依赖模块执行后未挂载全局(RF/XFollowBackLogic)');
  }

  const K = RFg.KEY;
  const OP_FOLLOWERS = 'BlueVerifiedFollowers'; // 认证粉丝列表(GraphQL)
  const OP_SEARCH = 'SearchTimeline';           // 搜索/互关帖抓取 + 扫回复兑底(conversation_id)
  const OP_TWEET_DETAIL = 'TweetDetail';       // 帖子详情楼(扫回复主路径, ADR-0009)
  const FOLLOW_API = '/i/api/1.1/friendships/create.json'; // 回关动作: v1.1 REST, 非 GraphQL(实测确认)
  const AF = RFg.AF; // 主动关注写死参数(见 constants.js)

  const RESERVED_HANDLES = new Set(['i', 'home', 'explore', 'notifications', 'messages', 'settings', 'search', 'hashtag']);

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
      document.getElementById('xfollowback-widget')?.remove(); // 新版悬浮控件
      document.getElementById('xfollowback-bar')?.remove();     // 旧版顶部横条(升级兼容清理)
      document.getElementById('xfollowback-bar-style')?.remove();
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
  const afTaskKey = (h) => `${K.afTask}:${h}`;

  function newTask(handle) {
    return {
      state: 'idle', pauseReason: null, nextAutoResumeAt: null,
      screenName: handle, queue: [], consecutiveFailures: [],
      lastError: null, lastFetchAt: null, updatedAt: 0,
    };
  }
  // 主动关注任务: 队列 + 互关帖池(tags[tag].posts)。循环级字段与回关任务同构,
  // 暂停/退避由两个任务同步共享(ADR-0001: 同一时间只有一个循环)。
  function newAfTask(handle) {
    return {
      state: 'idle', pauseReason: null, nextAutoResumeAt: null,
      screenName: handle, queue: [], tags: {}, consecutiveFailures: [],
      lastError: null, updatedAt: 0,
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
  async function getAfTask(handle) {
    if (!handle) return newAfTask('');
    return (await store.get(afTaskKey(handle), null)) || newAfTask(handle);
  }
  async function saveAfTask(handle, t) {
    t.screenName = handle;
    t.updatedAt = Date.now();
    await store.set(afTaskKey(handle), t);
  }
  async function getDaily(handle) {
    return rolloverDaily(await store.get(dailyKey(handle), null));
  }
  // options/popup 无页面上下文, 通过最近活跃账号定位任务
  async function activeHandle() {
    return runningHandle || (await pageHandle()) || (await store.get(K.active, null)) || '';
  }
  async function setActive(handle) {
    if (handle) await store.set(K.active, handle);
  }

  // 互关标签页: /hashtag/<tag> 且 tag 在配置列表内(大小写不敏感) → 返回配置里的原始写法(保留大小写,
  // 搜索词必须与真实 hashtag 一致, 如 #蓝V互关 的大写 V), 未配置返回 null。
  // 同步函数: ensureBar 每秒由 SPA 路由检查调用, 不能 await; 配置列表由 refreshCache 异步刷新
  let cachedTags = null;
  function curTag() {
    const pathTag = curTagPath();
    if (!pathTag || cachedTags == null) return null;
    for (const t of cachedTags) {
      const norm = String(t).replace(/^#/, '').trim().toLowerCase();
      if (norm && norm === pathTag) return String(t).replace(/^#/, '').trim();
    }
    return null;
  }
  // 互关标签页: /hashtag/<tag>(路径段, 不校验配置列表——配置校验在 curTag 里)
  function curTagPath() {
    const m = /^\/hashtag\/([^/?#]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]).replace(/^#/, '').toLowerCase() : null;
  }
  // 兑底: 从侧栏账号切换器猜当前账号。多账号登录时可能取到别的账号(ADR-0003), 仅在 whoami 不可用时使用
  function loggedInHandle() {
    // 首选: 侧栏/底栏「个人资料」标签——永远指向当前登录账号, 多账号也不误。
    // ADR-0003 否掉的是账号切换器(第一个链接可能是别的账号), Profile 标签没有这个问题。
    // settings.json 已 404、Viewer op 已绝迹(见 background 身份探针), 这是页面侧最可靠的身份源。
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const m = link && /^\/([^/]+)/.exec(link.getAttribute('href') || '');
    const own = m ? m[1] : '';
    if (own && !RESERVED_HANDLES.has(own)) return own;
    // 兼容兑底: 账号切换器(Profile 标签不在时才用, 窄窗口/加载中)
    const el = document.querySelector('[data-testid="SideNav_AccountSwitcher_AccountSwitcher"]');
    const link2 = el && el.querySelector('a[href^="/"]');
    const m2 = link2 && /^\/([^/]+)/.exec(link2.getAttribute('href') || '');
    const h2 = m2 ? m2[1] : '';
    return h2 && !RESERVED_HANDLES.has(h2) ? h2 : '';
  }
  // 当前登录账号: 以 X 接口为准(settings.json, hook 缓存10分钟), DOM 猜测与最近活跃仅作兼容兑底。
  // 多账号登录时侧栏切换器里第一个链接可能是别的账号, 曾把搜索结果写进另一账号的任务键(ADR-0003)
  async function afHandle() {
    let h = await whoamiHandle();
    if (!h) h = loggedInHandle();
    if (!h) h = (await store.get(K.active, null)) || '';
    const prev = await store.get(K.active, null);
    if (h && h !== prev) {
      await setActive(h);
      if (prev) await log(`识别当前账号: @${h}(之前按 @${prev} 记录)`);
    }
    return h;
  }
  let meCache = { at: 0, name: '' };
  // 真实登录账号(hook: Viewer喍探优先, settings.json 兑底); 成功正缓存10分钟, 失败负缓存5分钟
  async function whoamiHandle() {
    if (meCache.name && Date.now() - meCache.at < 10 * 60_000) return meCache.name;
    if (!meCache.name && Date.now() - meCache.at < 5 * 60_000) return '';
    // 全局闸门(rf_whoami_gate, 与 background 探针共享, 详见 background.js):
    // settings.json 限额桶极小, 多标签页各自负缓存叠加也会打死它(实测: 认证粉丝页开着时
    // webRequest 事件高频唤醒 SW → 探针风暴 → 疯狂 429)。闸门跨页/跨进程: 60s 内有人试过
    // 就不叠; 失败按 retryAt 冷却; 成功 10 分内直接采纳。
    const g = (await store.get('rf_whoami_gate', null)) || {};
    const now = Date.now();
    if (g.ok && now - (g.at || 0) < 10 * 60_000) { meCache = { at: g.at, name: g.name }; return g.name; }
    if ((g.retryAt && now < g.retryAt) || now - (g.at || 0) < 60_000) return '';
    try {
      const r = await callPage('whoami', {});
      if (r && r.screenName) {
        meCache = { at: now, name: r.screenName };
        await store.set('rf_whoami_gate', { at: now, ok: true, name: r.screenName });
        return r.screenName;
      }
    } catch {}
    meCache = { at: now, name: '' };
    await store.set('rf_whoami_gate', { at: now, ok: false, retryAt: now + 5 * 60_000 });
    return '';
  }
  // 页面 URL 里的 handle → 任务账号: 只有等于真实登录账号才算数。
  // 逛别人的关注/粉丝列表时 URL 是别人的 handle, 过去会被误认成目标账号。
  // 身份不明时绝不采信 URL handle(宁可退回最近活跃账号)——盲信曾把拉取数据写进别人的键(ADR-0003)
  async function pageHandle() {
    const urlh = curHandle();
    if (!urlh) return '';
    const me = await whoamiHandle();
    if (me) return urlh.toLowerCase() === me.toLowerCase() ? me : '';
    // 接口识别失败时的兕底: 现代页面已不发 Viewer op(2026-10-11 实测: 无该 op,
    // viewer_context.json 是 200 空体心跳), settings.json 又常 429——嗅探源事实上已绝迹。
    // URL handle 与最近活跃账号(历史上经 API 确认过)一致才采信; 逛别人页面 URL handle ≠ active 依旧拒绝。
    const { [RFg.KEY.active]: active } = await chrome.storage.local.get(RFg.KEY.active);
    return active && urlh.toLowerCase() === String(active).toLowerCase() ? urlh : '';
  }

  // ---------- 与 MAIN world 的桥 ----------
  let msgSeq = 0;
  const pendingCalls = new Map();
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.source !== 'xfollowback-page' || m.type !== 'result') return;
    if (pendingCalls.has(m.id)) {
      pendingCalls.get(m.id)(m.data);
      pendingCalls.delete(m.id);
    }
  });
  function callPage(type, payload) {
    return new Promise((resolve) => {
      const id = ++msgSeq;
      pendingCalls.set(id, resolve);
      window.postMessage({ source: 'xfollowback-ui', type, id, payload }, '*');
      setTimeout(() => {
        if (pendingCalls.has(id)) {
          pendingCalls.delete(id);
          resolve({ status: -1, ok: false, body: 'bridge timeout' });
        }
      }, 60_000);
    });
  }
  const callGraphQL = (operationName, variables, tid) => callPage('graphql', { operationName, variables, tid });

  // background 消息(与 notify 同通道): 永不 reject, 无应答/异常都 resolve {error}(调用方据此回退)
  function sendBg(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (r) => {
          if (chrome.runtime.lastError) return resolve({ error: 'background 无响应: ' + chrome.runtime.lastError.message });
          resolve(r || { error: 'background 空应答' });
        });
      } catch (e) { resolve({ error: String((e && e.message) || e) }); }
    });
  }

  // ---- tid 收割池取用/写回(ADR-0004) ----
  // 池子由 background SW 的 webRequest 旁听填充(用户刷 X 即持续供血);
  // 只取同路径且冷却已过的 tid(跨路径未证实); 池子没有则返回 null, 调用方回退捕获 tid + 等冷却。
  async function poolPick(path) {
    try {
      const { [K.tidPool]: pool } = await chrome.storage.local.get(K.tidPool);
      const e = globalThis.RFTidPool.pick(pool, { path, now: Date.now(), cooldownMs: AF.TID_COOLDOWN_MS });
      return e ? e.t : null;
    } catch { return null; }
  }
  async function poolMark(tid, path, ok) {
    if (!tid || !path) return;
    try {
      const { [K.tidPool]: pool } = await chrome.storage.local.get(K.tidPool);
      await chrome.storage.local.set({ [K.tidPool]: globalThis.RFTidPool.markResult(pool, tid, path, ok, Date.now()) });
    } catch {}
  }

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
  // 纯逻辑(parseFollowers/interpret/mergeUsers/pickNextItem/...)在 shared/logic.js(顶部已显式 import), 有单元测试覆盖
  const { parseFollowers, parseFollowList, interpret, mergeUsers, findPendingItem, evaluateStall, rolloverDaily, atName, rateLimitBackoffMs, windowExhaustedWaitMs,
    parseSearchTimeline, parseTweetDetail, afEligible, pickNextItem, mergeAfCandidates, upsertPosts, duePost, duePostAcrossTags, markScanned,
    nextAutoSearchTag, shouldAutoSearch } = L;
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
    // 休眠期间随时检查: 两个任务都不再 running / 账号被切换 → 提前退出(返回 false)
    const deadline = Date.now() + ms;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return true;
      await sleep(Math.min(remaining, 30_000));
      const fb = await store.get(taskKey(handle), null);
      const af = await store.get(afTaskKey(handle), null);
      if ((!fb || fb.state !== 'running') && (!af || af.state !== 'running')) return false;
      if (!(await isLockMine())) return false;
    }
  }

  // 回关(Phase 2): Route 1 直连 create.json 优先; 仅传输失败才兑底页面重放(业务响应不重放, 防双关)
  async function followUser(userId) {
    const uid = String(userId);
    const r1 = await sendBg({ cmd: 'route1-follow', userId: uid });
    // 拿到 HTTP 状态 = 业务权威应答(含 403/429), 不再重放
    if (r1 && r1.status != null && !r1.transport) {
      return { status: r1.status, ok: !!r1.ok, body: r1.body || '', rl: r1.rl || {}, via: r1.via || 'route1' };
    }
    // 传输失败 → 页面重放兑底(需本页捕获过 create.json 模板)
    const cap = await callPage('list-captured', {});
    const has = (cap.apiEndpoints || []).some((e) => e.path === FOLLOW_API);
    if (!has) {
      const why = (r1 && r1.error) ? `Route 1 失败(${r1.error})且` : '';
      throw new Error(why + '未捕获回关请求——请在认证粉丝列表里点一次「回关」按钮刷新模板');
    }
    await log(`关注 Route 1 传输失败, 回退页面重放: ${(r1 && r1.error) || '未知'}`);
    const res = await callPage('api', { path: FOLLOW_API, params: { user_id: uid } });
    return Object.assign({}, res, { via: 'page' });
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
      // Route 1 优先(ADR-0004): 材料全在 storage, 不依赖本页捕获过模板; 结构性缺料才回退页面重放。
      // 变量基准两路径同源(rf_tpl 首见形状), 翻页 cursor 绑定会话基准(见 searchPage 同款修复)
      let entry = null;   // 页面捕获模板(回退路径用, 首次回退时惰性获取)
      let r1Base = null;  // rf_tpl 首见变量形状(回退路径的基准, 与 Route 1 同源)

      // 计时起点: 手动/自动一视同仁, 成功失败都算(失败也等下一个周期再试, 避免连打)
      const t0 = await getTask(screenName);
      t0.lastFetchAt = Date.now();
      await saveTask(screenName, t0);

      const settings = await getSettings();
      const count = 100;
      const MAX_PAGES = 8; // 100/页 → 最多拉前 800 人; 更后面的粉丝回关收益低
      const all = [];
      let cursor = null;
      let page = 0;
      let retries = 0;
      let incomplete = false;
      while (page < MAX_PAGES) {
        // Route 1: background 直连(screen_name 剔除/缺省 cursor 删除用 null 删键语义表达)
        let res = await sendBg({ cmd: 'route1-graphql', op: OP_FOLLOWERS, vars: { count, screen_name: null, cursor: cursor || null } });
        if (res && res.error) {
          await log(`Route 1 不可用(${res.error}), 本发回退页面重放`);
          if (!entry) {
            const cap = await callPage('list-captured', {});
            entry = (cap.operations || []).find((o) => o.operationName === OP_FOLLOWERS);
            if (!entry) {
              const msg = `Route 1 不可用(${res.error})且未捕获到 ${OP_FOLLOWERS} 请求——请先打开 /${screenName}/verified_followers 页面并等它加载完`;
              await log('⚠ ' + msg);
              return { ok: false, message: msg };
            }
            const { [K.gqlTpl + ':' + OP_FOLLOWERS]: r1Tpl } = await chrome.storage.local.get(K.gqlTpl + ':' + OP_FOLLOWERS);
            r1Base = (r1Tpl && r1Tpl.v0) || null;
          }
          const fvars = globalThis.RFRoute1.mergeVariables(r1Base || entry.variables, { count, screen_name: null, cursor: cursor || null });
          res = await callGraphQL(OP_FOLLOWERS, fvars);
        }
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

      // 按 userId 去重后纯追加合并。
      // 接口列表是新粉在前, 倒序后老粉排前; 队列纯追加 + 回关循环按队列顺序消费,
      // 因此先关注你的人(等最久的)会被先回关
      const seen = new Set();
      const users = all
        .filter((u) => (seen.has(u.userId) ? false : (seen.add(u.userId), true)))
        .reverse();
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
    const handle = await pageHandle();
    if (!handle) return { ok: false, message: '请在目标账号的 verified_followers 页面上操作' };
    if (fetchingFollowers) return { ok: false, message: '已在拉取中, 请等本轮完成' };
    await log(`手动更新认证粉丝列表(@${handle})`);
    runFetch(handle); // fire and forget, 进度见状态行"拉取中"
    return { ok: true, message: '已开始更新列表' };
  }

  // ============================================================
  // 未回关名单(方案 A): 翻页拉自己的 Following 列表, 过滤 followedBy=false。
  //   不拉粉丝列表求差集——Following 列表每个用户对象自带 followed_by, 一遍就够。
  //   前提: rf_tpl:Following 模板已捕获(先打开一次自己的 /following 页面), Route 1 直连。
  //   走 fire-and-forget(拉取可能几分钟), 进度落盘 fb_diff_progress, 结果落 fb_diff:{handle}。
  // ============================================================
  const OP_FOLLOWING = 'Following'; // 我关注的用户列表(GraphQL)
  let fetchingDiff = false;
  async function runDiffFetch() {
    if (fetchingDiff) return;
    fetchingDiff = true;
    try {
      const handle = await activeHandle();
      if (!handle) { await log('未回关名单: 未识别到登录账号, 跳过'); return; }
      const settings = await getSettings();
      const count = 100;
      const MAX_PAGES = 500; // 100/页 → 5万关注上限
      const all = [];
      let cursor = null;
      let page = 0;
      let retries = 0;
      let incomplete = false;
      while (page < MAX_PAGES) {
        const res = await sendBg({
          cmd: 'route1-graphql', op: OP_FOLLOWING,
          vars: { count, cursor: cursor || null },
        });
        if (res && res.error) {
          const msg = `未回关名单: Route 1 不可用(${res.error})——请先打开自己的 x.com/${handle}/following 页面并等它加载完(捕获模板), 再重新拉取`;
          await log('⚠ ' + msg);
          await store.set(K.diffProgress, { handle, running: false, error: msg, ts: Date.now() });
          return;
        }
        if (res.status === 429) {
          if (++retries > 3) {
            incomplete = true;
            await log('未回关名单: 拉取连续限流, 先保存已拉到的部分, 稍后重新拉取补全');
            break;
          }
          const backoff = rateLimitBackoffMs(interpret(res), Date.now(), settings.rateLimitBackoffMin * 60_000);
          await log(`未回关名单: 拉取限流, ${Math.round(backoff / 1000)}秒后重试第${page + 1}页`);
          await sleep(backoff);
          continue;
        }
        retries = 0;
        const parsed = parseFollowList(res.body);
        if (parsed.error) throw new Error(parsed.error);
        if (page === 0 && parsed.firstRaw) {
          await log('未回关名单: 用户对象结构样本: ' + parsed.firstRaw);
        }
        all.push(...parsed.users);
        await store.set(K.diffProgress, {
          handle, running: true, page: page + 1, maxPages: MAX_PAGES,
          users: all.length, hasMore: !!parsed.cursor, ts: Date.now(),
        });
        await log(`未回关名单: 第${page + 1}页 +${parsed.users.length}, 累计${all.length}`);
        // 实测: 列表拉完后接口仍会返回 cursor(非空但无数据), 所以 0 人即视为拉完
        if (!parsed.cursor || parsed.cursor === cursor || parsed.users.length === 0) break;
        cursor = parsed.cursor;
        page++;
        await sleep(800 + Math.random() * 700);
      }
      if (page >= MAX_PAGES) incomplete = true;

      // 按 userId 去重, 过滤出未回关(followedBy=false)的人
      const seen = new Set();
      const users = all.filter((u) => (seen.has(u.userId) ? false : (seen.add(u.userId), true)));
      const notBack = users
        .filter((u) => !u.followedBy)
        .map((u) => ({
          userId: u.userId, screenName: u.screenName, name: u.name,
          description: u.description || '',
          followersCount: u.followersCount, friendsCount: u.friendsCount,
        }));
      await store.set(K.diff + ':' + handle, {
        handle, ts: Date.now(), total: users.length, notBackCount: notBack.length,
        incomplete: incomplete || undefined,
        users: notBack,
      });
      await store.set(K.diffProgress, { handle, running: false, ts: Date.now() });
      await log(`未回关名单更新${incomplete ? '(可能不全)' : ''}: 我关注${users.length}, 其中未回关${notBack.length}`);
    } catch (e) {
      await store.set(K.diffProgress, { running: false, error: String(e), ts: Date.now() });
      await log(`未回关名单拉取失败: ${e}`);
    } finally {
      fetchingDiff = false;
    }
  }

  // ============================================================
  // 主动关注(蓝V互关): 搜索阶段 + 扫描阶段(生产者)
  //   搜索: 控制台手动触发(任意 x.com 标签页宿主, 标签经消息指定)或池子断供自动触发;
  //         翻页拉互关帖 → 帖子 ID 入互关帖池, 帖子作者入队列
  //   扫描: 到期帖回复翻页 → 新评论者入队; 主路径 TweetDetail(与页面评论同源, ADR-0009),
  //         无模板/首屏失败兑底 conversation_id Search; 首扫拉完, 隔两天重扫, 最多三次;
  //         触发=循环水位顺路 / 互关标签页 tick / 控制台手动连扫(补到 MANUAL_SCAN_TARGET)
  // ============================================================
  let afSearching = false;
  let afScanning = false;
  let afBurstScanning = false; // 控制台手动连扫(补到 MANUAL_SCAN_TARGET)

  // 从 SearchTimeline 响应里筛出合格候选人(去转推, 过滤蓝V/保护/已关注/比值)
  function eligibleFromItems(items, tag) {
    const stats = { total: 0, retweet: 0, notBlue: 0, protected: 0, already: 0, ratio: 0 };
    const users = [];
    for (const it of items || []) {
      if (it.isRetweet) { stats.retweet++; continue; }
      stats.total++;
      const el = afEligible(it.user, AF.RATIO_MAX);
      if (!el.ok) {
        if (el.reason === 'not-blue') stats.notBlue++;
        else if (el.reason === 'protected') stats.protected++;
        else if (el.reason === 'already-following') stats.already++;
        else if (el.reason === 'ratio') stats.ratio++;
        continue;
      }
      users.push({ userId: it.user.userId, screenName: it.user.screenName, name: it.user.name, source: tag });
    }
    return { users, stats };
  }

  // 把候选人合入主动关注队列(剔除已在回关队列的人), done 状态下扫到新人自动续跑
  async function enqueueAfCandidates(handle, users, tag) {
    if (!users.length) return { added: 0, capped: false };
    const fb = await getTask(handle);
    const exclude = new Set(fb.queue.map((q) => q.userId));
    const t = await getAfTask(handle);
    const { added, capped } = mergeAfCandidates(t, users, exclude, AF.QUEUE_CAP);
    if (capped) {
      t.lastError = `主动关注队列已达上限(${AF.QUEUE_CAP}), 暂停入队`;
      await log(`⚠ ${t.lastError}`);
    }
    await saveAfTask(handle, t);
    // 等待中(done)扫到新 pending → 自动续跑; idle(未启动过)不自动开跑
    if (t.state === 'done' && t.queue.some((q) => q.status === 'pending')) {
      t.state = 'running';
      t.pauseReason = null;
      t.nextAutoResumeAt = null;
      await saveAfTask(handle, t);
      await log('检测到新待关注, 主动关注自动续跑');
      runLoop(handle);
    }
    return { added, capped };
  }

  // 重放 SearchTimeline, 返回解析结果(429 按 reset 退避重试同一页, 最多3次)。
  // 传输路径优先级(ADR-0004):
  //   Route 1: background 直连(bearer+csrf+tid 三件套, 2026-10-11 对照实验双 200)——材料全在 storage,
  //     不依赖本页捕获过模板, 浏览器刚重启也能直接扫; 结构性缺料才回退页面内重放。
  //   页面重放(回退): page-hook 用本页捕获模板, tid 来源=池子同路径 → 捕获 tid+等冷却(历史行为)。
  // tid 冷却: 同 tid 成功后约60秒内 X 拒绝一切同tid请求(404, 空 body); 失败不延长冷却。
  let lastSearchOkAt = 0;
  let lastSearchFireAt = 0; // 上次发射时刻(含失败): 桶节奏兼底用, 与 tid 冷却是两套独立约束
  async function searchPage(rawQuery, cursor) {
    let retries = 0;
    while (true) {
      // 桶节奏兼底(两条路径共用, 先于发射): SearchTimeline 限流 50次/15分钟(≈18s/发),
      // 池子深时连发会烧穿桶——连带页面自己的轮询也被 429。两次发射至少隔 AF.SEARCH_MIN_GAP_MS。
      const sinceFire = Date.now() - lastSearchFireAt;
      if (sinceFire < AF.SEARCH_MIN_GAP_MS) {
        const waitMs = AF.SEARCH_MIN_GAP_MS - sinceFire;
        await log(`搜索节奏控制(限流桶50次/15分钟), 等${Math.ceil(waitMs / 1000)}秒`);
        await sleepSegments(waitMs);
      }
      lastSearchFireAt = Date.now();

      // Route 1: background 直连
      let res = await sendBg({ cmd: 'route1-graphql', op: OP_SEARCH, vars: { rawQuery, count: AF.SEARCH_PAGE_SIZE, cursor: cursor || null } });
      const viaRoute1 = !!(res && !res.error);
      let poolTid = null, searchPath = null, entry = null;
      if (!viaRoute1) {
        if (res && res.error) await log(`Route 1 不可用(${res.error}), 本发回退页面内重放`);
        const cap = await callPage('list-captured', {});
        entry = (cap.operations || []).find((o) => o.operationName === OP_SEARCH);
        // Route 1 失败原因随消息上抛(模板/bearer/ct0/tid池/网络一眼可辨), 不用翻日志
        if (!entry) return { error: `Route 1 不可用(${(res && res.error) || 'background 无应答'})且页面未捕获到 ${OP_SEARCH}——请先打开互关标签页并等它加载完` };
        // 变量基准必须与 Route 1 同源(rf_tpl 首见形状): X 的翻页 cursor 绑定会话基准,
        // 页1(Route1/如 Latest)的 cursor 拿去页2(页面捕获/如 Top) → MalformedCursor(2026-10-11 实测)
        const { [K.gqlTpl + ':' + OP_SEARCH]: r1Tpl } = await chrome.storage.local.get(K.gqlTpl + ':' + OP_SEARCH);
        const base = (r1Tpl && r1Tpl.v0) || entry.variables || {};
        const variables = { ...base, rawQuery, count: AF.SEARCH_PAGE_SIZE };
        if (cursor) variables.cursor = cursor; else delete variables.cursor;
        searchPath = new URL(entry.url).pathname;
        poolTid = await poolPick(searchPath);
        if (!poolTid) {
          // 冷却基准取两者较晚者: 捕获请求自身的成功时刻(capturedAt) / 我们上一次重放成功时刻
          const since = Date.now() - Math.max(entry.capturedAt || 0, lastSearchOkAt);
          if (since < AF.TID_COOLDOWN_MS) {
            const waitMs = AF.TID_COOLDOWN_MS - since;
            await log(`同tid冷却中, 等${Math.ceil(waitMs / 1000)}秒后再发`);
            await sleepSegments(waitMs);
          }
        }
        res = await callGraphQL(OP_SEARCH, variables, poolTid);
      }
      if (res.status === 429) {
        if (++retries > 3) return { rateLimitedOut: true };
        const backoff = rateLimitBackoffMs(interpret(res), Date.now(), 15 * 60_000);
        await log(`搜索限流, ${Math.round(backoff / 1000)}秒后重试`);
        await sleepSegments(backoff);
        continue;
      }
      if (res.ok) lastSearchOkAt = Date.now();
      // 404 也记消耗: 否则同 tid 会被立刻重选连打(与 background route1Graphql 同策略)
      if (!viaRoute1) await poolMark(poolTid, searchPath, res.ok || res.status === 404);
      const parsed = parseSearchTimeline(res.body);
      // 非 JSON 响应(空体/错误页)带上状态码, 便于定位
      if (parsed.error) {
        parsed.error = `HTTP ${res.status}: ` + parsed.error;
        if (viaRoute1) {
          // 404 空体多半是 tid 刚被别路用过/边缘冷却: 换 tid 再试几次, 别立刻判整帖失败
          if (res.status === 404 && ++retries <= 3) {
            await log(`Route 1 404(疑似 tid 冷却), 换 tid 重试(${retries}/3)`);
            continue;
          }
          if (res.status === 404) parsed.error += '(Route 1: tid 冷却未过或参数无效——请带日志反馈)';
          await log(`Route 1 发射失败: ${parsed.error}`);
          return parsed;
        }
        if (res.status === 404) parsed.error += '(同tid冷却未过或参数无效, 冷却已由重放前等待排除——请带日志反馈)';
        // 对照实验: 原样重放捕获变量。冷却期内它必然也404(字节相同也不例外), 但能区分"传输层完全坏"(连接失败/非404)与"冷却/参数"
        if (res.status === 404) {
          try {
            const retry = await callGraphQL(OP_SEARCH, entry.variables || {});
            await log(`对照实验: 原样重放捕获请求 → HTTP ${retry.status}, body长度=${(retry.body || '').length}`);
          } catch (e) {
            await log(`对照实验异常: ${e}`);
          }
        }
        // 失败取证: 模板信息 + 实际请求 URL 分段完整输出(URL 不含凭证, 可安全外发), 便于与页面成功请求逐字节对比
        // (entry 来自 list-captured, 无 search 字段, features 长度从实际失败的 URL 上取)
        const featLen = res.url ? (new URL(res.url).searchParams.get('features') || '').length : 0;
        await log(`搜索失败取证: method=${entry.method} queryId=${entry.queryId} 捕获变量含cursor=${'cursor' in (entry.variables || {})} 发送cursor=${cursor ? '有' : '无'} features长度=${featLen}`);
        // 重放真实发送状态由 page-hook 回传(list-captured 的 headers 被剥过, 这里不能信它)
        const s = res.sent || {};
        await log(`重放实际发送: 头[${(s.headerKeys || []).join(',')}] tid长度=${s.tidLen ?? '?'} tid龄=${s.tidAgeMs != null ? Math.round(s.tidAgeMs / 1000) + '秒' : '?'} csrf长度=${s.csrfLen ?? '?'} URL长度=${(res.url || '').length}`);
        if (res.url) for (let i = 0; i < res.url.length; i += 450) await log(`失败URL[${Math.floor(i / 450) + 1}/${Math.ceil(res.url.length / 450)}]: ${res.url.slice(i, i + 450)}`);
      }
      return parsed;
    }
  }

  // 搜索阶段(手动/自动): 翻页拉互关帖, 帖子入池 + 作者入队。
  // 宿主=任意 x.com 标签页(Route 1 直连不挑场; 回退重放才需要页面捕获过模板)。
  // 发车即记自动补池时钟(lastAutoSearchAt/Tag, 手动抓取同样刷新): 失败也计冷却,
  // 防断供时每 30s 一 tick 地空烧限流桶。
  // 分页期间只攒本地数据, 不持有任务对象(避免覆盖循环写入的状态); 最后逐块"重读→改→存"
  async function runAfSearch(tag, handle) {
    if (afSearching) return { ok: false, message: '已在搜索中' };
    if (!handle) return { ok: false, message: '未识别到登录账号——请确认已登录 x.com' };
    afSearching = true;
    let done = null; // 结束时留档(running:false + finishedAt), 供控制台显示"上轮抓取完成"
    try {
      await setActive(handle);
      // 发车即记自动补池时钟: 下次自动补池从现在起算冷却(手动抓取同样刷新)
      {
        const t = await getAfTask(handle);
        t.lastAutoSearchAt = Date.now();
        t.lastAutoSearchTag = tag;
        await saveAfTask(handle, t);
      }
      // 发车即写进度(running:true): 控制台 storage 监听 ~300ms 内亮起"抓取中", 不等首页返回
      await store.set(K.afProgress, { tag, page: 0, maxPages: AF.SEARCH_MAX_PAGES, posts: 0, running: true, updatedAt: Date.now() });
      await log(`抓取互关帖发车: #${tag}, 最多${AF.SEARCH_MAX_PAGES}页(桶节奏 30s/发; 若遇供血/tid 冷却, 等待原因都会写进日志)`);
      const rawQuery = '#' + tag;
      let cursor = null;
      let page = 0;
      let incomplete = false;
      const postIds = [];
      const nonRtItems = [];
      while (page < AF.SEARCH_MAX_PAGES) {
        const out = await searchPage(rawQuery, cursor);
        if (out.error) { await log(`搜索失败: ${out.error}`); return { ok: false, message: out.error }; }
        if (out.rateLimitedOut) { incomplete = true; await log('搜索连续限流, 本轮先合并已拉到的部分'); break; }
        for (const it of out.items) {
          if (it.postId) postIds.push({ postId: it.postId, replyCount: it.replyCount });
          if (!it.isRetweet) nonRtItems.push(it);
        }
        await store.set(K.afProgress, { tag, page: page + 1, maxPages: AF.SEARCH_MAX_PAGES, posts: postIds.length, running: true, updatedAt: Date.now() });
        await log(`搜索第${page + 1}页: 累计帖子${postIds.length}, cursor=${out.cursor ? '有' : '无'}`);
        if (!out.cursor || out.cursor === cursor || out.items.length === 0) break;
        cursor = out.cursor;
        page++;
        await sleep(800 + Math.random() * 700);
      }
      if (page >= AF.SEARCH_MAX_PAGES) incomplete = true;

      // 帖子入池(新帖 nextScanAt=now, 首扫立即到期): 重读→改→存, 中间无 await
      let poolAdded = 0, poolTotal = 0;
      {
        const t = await getAfTask(handle);
        const pool = (t.tags[tag] = t.tags[tag] || { posts: [] }).posts;
        poolAdded = upsertPosts(pool, postIds, Date.now()).added;
        poolTotal = pool.length;
        await saveAfTask(handle, t);
      }
      // 候选人入队(内部自己重读→追加→存, 并处理 done 自动续跑)
      const { users, stats } = eligibleFromItems(nonRtItems, tag);
      const candOut = await enqueueAfCandidates(handle, users, tag);
      const t2 = await getAfTask(handle);
      const pending = t2.queue.filter((q) => q.status === 'pending').length;
      await log(`搜索完成${incomplete ? '(可能不全)' : ''}: 帖子池+${poolAdded}(共${poolTotal}), 候选+${candOut.added}` +
        `(非蓝V${stats.notBlue}/比值${stats.ratio}/已关注${stats.already}/保护${stats.protected}/转推${stats.retweet})` +
        `, 待关注${pending}`);
      done = { tag, page, maxPages: AF.SEARCH_MAX_PAGES, posts: postIds.length };
      return {
        ok: true,
        message: `帖子池+${poolAdded}(共${poolTotal}), 候选+${candOut.added}, 待关注${pending}` + (incomplete ? '(可能不全)' : ''),
      };
    } catch (e) {
      await log(`搜索失败: ${e}`);
      return { ok: false, message: String(e) };
    } finally {
      afSearching = false;
      // 留档而非删除: running:false + finishedAt 让控制台显示"上轮抓取完成", 而不是状态凭空消失
      await store.set(K.afProgress, Object.assign({ running: false, finishedAt: Date.now() }, done || { tag }));
    }
  }

  // 是否已旁听到 GraphQL 模板(Route 1 材料)
  async function hasGqlTpl(op) {
    try {
      const { [K.gqlTpl + ':' + op]: tpl } = await chrome.storage.local.get(K.gqlTpl + ':' + op);
      return !!(tpl && tpl.p && tpl.q && tpl.v0); // 与 route1Graphql 结构性材料一致
    } catch { return false; }
  }

  // 与 searchPage 共用发射节奏兼底(SEARCH_MIN_GAP_MS)
  async function awaitSearchGap(label) {
    const sinceFire = Date.now() - lastSearchFireAt;
    if (sinceFire < AF.SEARCH_MIN_GAP_MS) {
      const waitMs = AF.SEARCH_MIN_GAP_MS - sinceFire;
      await log(`${label}节奏控制, 等${Math.ceil(waitMs / 1000)}秒`);
      // 连扫等待期间也刷新心跳, 避免控制台把长扫误判成卡死把按钮灰死
      if (afBurstScanning) {
        try {
          const cur = await store.get(K.afScanProgress, null);
          if (cur && cur.running) await store.set(K.afScanProgress, Object.assign({}, cur, { updatedAt: Date.now() }));
        } catch {}
      }
      await sleepSegments(waitMs);
    }
    lastSearchFireAt = Date.now();
  }

  // TweetDetail 翻页(ADR-0009): Route 1 直连; 变量补丁 focalTweetId + cursor(null 删键)。
  // 模板需用户打开过任意 /status/ 帖(webRequest 旁听 rf_tpl:TweetDetail)。
  async function tweetDetailPage(postId, cursor) {
    let retries = 0;
    while (true) {
      await awaitSearchGap('详情');
      const res = await sendBg({
        cmd: 'route1-graphql',
        op: OP_TWEET_DETAIL,
        vars: { focalTweetId: String(postId), cursor: cursor || null },
      });
      if (res && res.error) return { error: res.error };
      if (res.status === 429) {
        if (++retries > 3) return { rateLimitedOut: true };
        const backoff = rateLimitBackoffMs(interpret(res), Date.now(), 15 * 60_000);
        await log(`详情限流, ${Math.round(backoff / 1000)}秒后重试`);
        await sleepSegments(backoff);
        continue;
      }
      if (res.ok) lastSearchOkAt = Date.now();
      const parsed = parseTweetDetail(res.body || '');
      if (parsed.error) {
        parsed.error = `HTTP ${res.status}: ` + parsed.error;
        if (res.status === 404 && ++retries <= 3) {
          await log(`详情 Route 1 404(疑似 tid), 换 tid 重试(${retries}/3)`);
          continue;
        }
        return parsed;
      }
      return parsed;
    }
  }

  // 扫描阶段(自动/手动连扫): 扫一个到期帖子的回复, 新评论者入队。每 tick 至多一帖。
  // 主路径 TweetDetail; 无模板或首屏失败兑底 conversation_id Search。
  // 返回 { skipped|transportErr|limited|added } 供连扫统计; 无到期帖/互斥时 skipped。
  async function runAfScanOne(tag, handle) {
    if (afScanning || afSearching) return { skipped: true };
    afScanning = true;
    try {
      const t0 = await getAfTask(handle);
      const post = duePost((t0.tags[tag] && t0.tags[tag].posts) || [], Date.now(), AF.SCAN_MAX);
      if (!post) return { skipped: true };
      const postId = post.postId;
      const scanNo = post.scanCount + 1;
      let cursor = null;
      let page = 0;
      let limited = false;
      const allItems = [];
      let transportErr = null;
      let mode = (await hasGqlTpl(OP_TWEET_DETAIL)) ? 'detail' : 'search';
      if (mode === 'search') {
        await log(`扫描帖子 ${postId}: 未旁听 TweetDetail 模板, 兑底 conversation_id 搜索(打开任意帖子详情页即可启用完整楼)`);
      }

      while (page < AF.SCAN_MAX_PAGES) {
        const out = mode === 'detail'
          ? await tweetDetailPage(postId, cursor)
          : await searchPage(`conversation_id:${postId}`, cursor);
        if (out.error) {
          if (mode === 'detail' && page === 0) {
            await log(`扫描帖子 ${postId}: 详情首屏失败(${out.error}), 兑底 conversation_id 搜索`);
            mode = 'search';
            cursor = null;
            continue;
          }
          transportErr = out.error;
          await log(`扫描帖子 ${postId} 失败: ${out.error}`);
          break;
        }
        if (out.rateLimitedOut) { limited = true; break; }
        allItems.push(...out.items);
        if (!out.cursor || out.cursor === cursor || out.items.length === 0) break;
        cursor = out.cursor;
        page++;
        await sleep(800 + Math.random() * 700);
      }

      const t1 = await getAfTask(handle);
      const post1 = ((t1.tags[tag] = t1.tags[tag] || { posts: [] }).posts || []).find((p) => p.postId === postId);
      if (post1) {
        if (transportErr) {
          post1.nextScanAt = Date.now() + AF.SCAN_ERR_RETRY_MS;
        } else if (limited) {
          post1.nextScanAt = Date.now() + AF.SCAN_RETRY_MS;
        } else {
          markScanned(post1, Date.now(), AF.SCAN_INTERVAL_MS);
        }
      }
      await saveAfTask(handle, t1);
      if (transportErr) {
        await log(`扫描帖子 ${postId} 推后${Math.round(AF.SCAN_ERR_RETRY_MS / 60000)}分钟重试(不消耗扫描次数)`);
        return { transportErr };
      }
      if (limited) {
        await log(`扫描帖子 ${postId} 被限流, 隔${AF.SCAN_RETRY_MS / 60000}分钟重试(不消耗扫描次数)`);
        return { limited: true };
      }
      const { users } = eligibleFromItems(allItems, tag);
      const { added } = await enqueueAfCandidates(handle, users, tag);
      const pathLabel = mode === 'detail' ? '详情' : '搜索';
      await log(`扫描帖子 ${postId}(第${scanNo}/${AF.SCAN_MAX}次, ${pathLabel}${page + 1}页, 解析${allItems.length}条): 候选+${added}`);
      return { added };
    } catch (e) {
      await log(`扫描异常: ${e}`);
      return { transportErr: String(e) };
    } finally {
      afScanning = false;
    }
  }

  // 控制台手动连扫: 跨标签扫到期帖, 直到待关注 ≥ MANUAL_SCAN_TARGET 或无到期帖。
  // 与主动关注启停无关(暂停/idle/done 都能扫——只补队列, 不替你开关注循环;
  //   done 扫到新人仍走 enqueueAfCandidates 自动续跑; paused 不强制恢复)。
  // 校验通过后立即返回「已发车」, 循环转后台(节奏走 SEARCH_MIN_GAP_MS);
  // 进度 rf_af_scan_progress, 双击由 afBurstScanning 拦下。
  async function runAfScanBurst(handle) {
    if (!handle) return { ok: false, message: '未识别到登录账号——请确认已登录 x.com' };
    if (afBurstScanning) return { ok: false, message: '已在连扫中, 等本轮跑完' };
    if (afSearching) return { ok: false, message: '正在抓取互关帖, 等本轮跑完再扫' };
    if (afScanning) return { ok: false, message: '正在扫描中, 稍后再试' };

    const t0 = await getAfTask(handle);
    const pend0 = t0.queue.filter((q) => q.status === 'pending').length;
    if (pend0 >= AF.MANUAL_SCAN_TARGET) {
      return { ok: false, message: `待关注已有 ${pend0}, 已达目标 ${AF.MANUAL_SCAN_TARGET}` };
    }
    if (!duePostAcrossTags(t0.tags, Date.now(), AF.SCAN_MAX)) {
      return { ok: false, message: '无到期帖——可先点「抓取互关帖」补池' };
    }

    afBurstScanning = true;
    (async () => {
      let scanned = 0;
      let totalAdded = 0;
      let errStreak = 0;
      let stopReason = '';
      let pending = pend0;
      try {
        await log(`手动连扫发车: 待关注 ${pend0} → 目标 ${AF.MANUAL_SCAN_TARGET}`);
        const writeScanProg = (extra) => store.set(K.afScanProgress, Object.assign({
          running: true, scanned, added: totalAdded, pending, target: AF.MANUAL_SCAN_TARGET,
          updatedAt: Date.now(),
        }, extra || {}));
        await writeScanProg({ scanned: 0, added: 0, pending: pend0 });

        while (true) {
          if (halted) { stopReason = '宿主离线'; break; }
          const t = await getAfTask(handle);
          pending = t.queue.filter((q) => q.status === 'pending').length;
          if (pending >= AF.MANUAL_SCAN_TARGET) {
            stopReason = `待关注已达 ${pending}`;
            break;
          }
          const due = duePostAcrossTags(t.tags, Date.now(), AF.SCAN_MAX);
          if (!due) {
            stopReason = '无到期帖——可先点「抓取互关帖」补池';
            break;
          }
          if (afSearching) { stopReason = '抓取互关帖介入, 连扫让路'; break; }
          // 循环水位扫描可能正占着 afScanning, 等它让开再扫
          while (afScanning && !halted) await sleep(400);
          if (halted) { stopReason = '宿主离线'; break; }
          if (afSearching) { stopReason = '抓取互关帖介入, 连扫让路'; break; }

          const one = await runAfScanOne(due.tag, handle);
          if (one && one.skipped) { await sleep(400); continue; } // 互斥竞态, 稍后再试
          scanned++;
          if (one && one.transportErr) {
            errStreak++;
            if (errStreak >= 3) { stopReason = `连续传输失败 ${errStreak} 次, 停止连扫`; break; }
          } else {
            errStreak = 0;
            if (one && typeof one.added === 'number') totalAdded += one.added;
          }
          const t2 = await getAfTask(handle);
          pending = t2.queue.filter((q) => q.status === 'pending').length;
          await writeScanProg();
        }

        await log(`手动连扫结束: 扫了 ${scanned} 帖, 候选+${totalAdded}, 待关注 ${pending}/${AF.MANUAL_SCAN_TARGET}(${stopReason})`);
      } catch (e) {
        stopReason = String(e);
        await log(`手动连扫异常: ${e}`);
      } finally {
        afBurstScanning = false;
        await store.set(K.afScanProgress, {
          running: false, finishedAt: Date.now(), updatedAt: Date.now(), scanned, added: totalAdded,
          pending, target: AF.MANUAL_SCAN_TARGET, stopReason,
        });
      }
    })();

    return {
      ok: true,
      message: `连扫已发车(目标待关注 ${AF.MANUAL_SCAN_TARGET})——进度见控制台状态行与日志`,
    };
  }

  // 主动关注启动(标签页面板按钮): 与回关同一个循环, 逐条优先自动生效
  async function startAfTask(handle) {
    if (!handle) return { ok: false, message: '未识别到登录账号——请确认已登录 x.com' };
    const t0 = await getAfTask(handle);
    if (t0.state === 'running') return { ok: false, message: '主动关注任务已在运行' };
    if (runningHandle) {
      // 循环已在跑(可能在限流等待): 只登记状态, 醒来后回关优先自动接续。
      // 旧语义直接拒绝("任务已在运行"), 逼用户等窗口过去才能点——不合理: 点开始的语义就是
      // "我要这个任务跑", 节奏/等待是循环自己的事
      t0.state = 'running';
      t0.pauseReason = null;
      t0.nextAutoResumeAt = null;
      t0.lastError = null;
      await saveAfTask(handle, t0);
      await setActive(handle);
      await log('主动关注已登记运行(循环醒来后按回关优先接续)');
      return { ok: true, message: '已登记运行——循环醒来后自动接续(当前在限流等待)' };
    }
    // Phase 2: 关注走 Route 1, 无模板也可开跑; 模板仅作传输失败兑底
    try {
      const cap = await callPage('list-captured', {});
      if (!(cap.apiEndpoints || []).some((e) => e.path === FOLLOW_API)) {
        await log('未捕获回关模板——关注走 Route 1 直连; 若直连失败需在认证粉丝列表点一次「回关」才能兑底');
      }
    } catch {}
    const t = await getAfTask(handle);
    const pending = t.queue.filter((q) => q.status === 'pending').length;
    t.state = 'running';
    t.pauseReason = null;
    t.nextAutoResumeAt = null;
    t.lastError = null;
    await saveAfTask(handle, t);
    await setActive(handle);
    await log(`主动关注启动: 待关注${pending}`);
    runLoop(handle);
    return { ok: true, message: pending > 0 ? `待关注${pending}, 已开始` : '队列暂空——先点「抓取互关帖」, 扫到人会自动开跑' };
  }

  // ============================================================
  // 任务状态机 + 回关循环(消费者)
  // ============================================================
  let runningHandle = null; // 本标签页正在跑回关的账号(同一时间只跑一个)

  // 自动暂停时发系统通知(带系统声音), 避免用户以为还在正常跑
  const PAUSE_ALERTS = {
    'template-expired': '回关模板已过期: 请在认证粉丝列表点一次「回关」, 然后点「恢复」',
    'daily-limit': '关注数已达上限(X 按 24 小时滚动窗口重置), 每小时自动探测重试',
    'stalled': '连续失败超过阈值, 稍后自动恢复',
    'error': '连续请求异常, 稍后自动恢复',
  };
  function notifyPause(reason) {
    // chrome.notifications 仅扩展页面可用, 经 background SW 代理; 同 tag 覆盖旧通知防堆积
    try {
      const p = chrome.runtime.sendMessage({
        cmd: 'notify',
        tag: 'pause-' + reason,
        title: 'XFollowBack 已暂停',
        message: PAUSE_ALERTS[reason] || reason,
      });
      if (p && p.catch) p.catch(() => {});
    } catch {} // 孤儿/通知失败不影响主流程
  }
  // 循环级暂停: 两个任务同步(ADR-0001 同一时间只有一个循环, 退避状态不区分任务)
  async function pauseTask(handle, reason, resumeAt) {
    for (const [get, save] of [[getTask, saveTask], [getAfTask, saveAfTask]]) {
      const t = await get(handle);
      if (t.state !== 'running') continue;
      t.state = 'paused';
      t.pauseReason = reason;
      t.nextAutoResumeAt = resumeAt || null;
      await save(handle, t);
    }
    await log(`任务暂停(${reason})`);
    if (reason !== 'manual') notifyPause(reason);
  }
  // 恢复: 两个任务一起恢复(手动恢复任一面板效果相同); 失败项重新入队重试
  async function resumeTask(handle) {
    let resumed = false;
    for (const [get, save] of [[getTask, saveTask], [getAfTask, saveAfTask]]) {
      const t = await get(handle);
      if (t.state !== 'paused') continue;
      for (const item of t.queue) {
        if (item.status === 'failed') { item.status = 'pending'; item.error = null; }
      }
      t.state = 'running';
      t.pauseReason = null;
      t.nextAutoResumeAt = null;
      await save(handle, t);
      resumed = true;
    }
    if (!resumed) return getTask(handle);
    await log('任务恢复');
    runLoop(handle);
    return getTask(handle);
  }

  async function startTask(screenName) {
    screenName = (screenName || '').replace(/\/+$/, '') || (await pageHandle());
    if (!screenName) {
      return { ok: false, message: '缺少 screenName——请在目标账号的 verified_followers 页面上操作' };
    }
    const t0 = await getTask(screenName);
    if (t0.state === 'running') return { ok: false, message: '回关任务已在运行' };
    if (runningHandle) {
      // 循环已在跑(可能在限流等待): 只登记状态, 醒来后回关优先自动接续(与 startAfTask 同语义)
      t0.state = 'running';
      t0.pauseReason = null;
      t0.nextAutoResumeAt = null;
      t0.lastError = null;
      await saveTask(screenName, t0);
      await setActive(screenName);
      await log('回关已登记运行(循环醒来后按回关优先接续)');
      return { ok: true, message: '已登记运行——循环醒来后自动接续(当前在限流等待)' };
    }
    // Phase 2: 关注走 Route 1, 无模板也可开跑; 模板仅作传输失败兑底
    // (拉取不受影响, 打开页面后观察器会自动补拉)
    try {
      const cap = await callPage('list-captured', {});
      if (!(cap.apiEndpoints || []).some((e) => e.path === FOLLOW_API)) {
        await log('未捕获回关模板——关注走 Route 1 直连; 若直连失败需在认证粉丝列表点一次「回关」才能兑底');
      }
    } catch {}
    const t = t0;
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

  // ---------- 主循环(消费者, 两队列一循环见 ADR-0001) ----------
  let loopRunning = false;
  // 循环的静默等待期(429限流/窗口次数用完): 状态仍是 running, 但面板要标出原因与剩余时间,
  // 否则看起来像挂掉了(2026-10-10 用户反馈)。
  // 落盘(rf_loop_wait): 总览卡/任务 Tab/弹窗同款展示——用户不看细节也知道"系统在等, 不是死了"
  let loopWait = null;
  async function setLoopWait(v) {
    loopWait = v;
    await store.set(K.loopWait, v || null).catch(() => {});
  }
  async function runLoop(handle) {
    if (loopRunning || !handle) return;
    if (!(await acquireLock())) return;
    loopRunning = true;
    runningHandle = handle;
    await setLoopWait(null); // 接手时清掉上个宿主可能残留的旧等待(页签关闭等异常退出)
    // src → 该任务的读写器(回关/主动关注各自的存储键)
    const io = {
      fb: { get: getTask, save: saveTask },
      af: { get: getAfTask, save: saveAfTask },
    };
    try {
      let rateRetryUserId = null; // B: 429 重试同一人计数
      let rateRetryCount = 0;
      let errorStreak = 0;        // C: 请求层连续异常计数

      while (true) {
        await refreshLock();

        // 生产侧(水位驱动): 主动关注待关注低于水位线时, 循环顺路扫一帖到期帖。
        // 与消费同循环串行 → 无锁竞争(旧机制扫描在 tick 里抢锁, 被回关循环饿死);
        // 扫描走 Route 1, 不要求标签页在场。扫完本轮继续关注, 候选回填后自然提速
        {
          const afNow = await io.af.get(handle);
          if (afNow.state === 'running') {
            const pend = afNow.queue.filter((i) => i.status === 'pending').length;
            if (pend < RFg.AF.PENDING_TARGET) {
              const due = duePostAcrossTags(afNow.tags, Date.now(), RFg.AF.SCAN_MAX);
              if (due) await runAfScanOne(due.tag, handle);
            }
          }
        }

        // 逐条优先(ADR-0001): 每取下一个人先查回关队列, 空了才取主动关注队列
        let src, task, item;
        {
          const fb = await io.fb.get(handle);
          const af = await io.af.get(handle);
          if (fb.state !== 'running' && af.state !== 'running') break;
          const picked = pickNextItem(fb, af);
          if (!picked) {
            // 各自收尾: running 但已无 pending → done
            let changed = false;
            if (fb.state === 'running' && !fb.queue.some((i) => i.status === 'pending')) { fb.state = 'done'; changed = true; }
            if (af.state === 'running' && !af.queue.some((i) => i.status === 'pending')) { af.state = 'done'; changed = true; }
            if (changed) {
              await io.fb.save(handle, fb); await io.af.save(handle, af);
              await log('队列已空: 回关等待新粉(拉到后自动续跑), 主动关注已清空(扫到新人后自动续跑)');
            }
            break;
          }
          src = picked.src;
          task = src === 'fb' ? fb : af;
          item = picked.item;
        }

        // 随机间隔(模拟人工)
        const settings = await getSettings();
        const delayMs = randInt(settings.intervalMin, settings.intervalMax) * 1000;
        if (!(await sleepInterruptible(delayMs, handle))) break;

        // 重读 task 后旧 item 引用已失效, 按 userId 重新定位。
        // (否则"已完成"标在旧快照上, 存储里仍是 pending, 会重复关注同一人)
        task = await io[src].get(handle);
        if (task.state !== 'running') break;
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
          await io[src].save(handle, task); // 先落库(get→改→存之间无 await, 不会被拉取器插入)
          const d = await getDaily(handle);
          d.followed++;
          await store.set(dailyKey(handle), d);
          await log(`已关注 ${atName(current)}${src === 'af' ? '(主动)' : ''}${res.via === 'page' ? '(页面重放)' : '(Route 1)'}, 今日 ${d.followed}`);
          // 主动限流: 窗口次数耗尽时等到 reset 再发下一个, 避免吃 429
          const pw = windowExhaustedWaitMs(r, Date.now());
          if (pw > 0) {
            await setLoopWait({ until: Date.now() + pw, text: '窗口次数用完' });
            await log(`本窗口次数已用完(remaining=0), ${Math.round(pw / 1000)}秒后窗口重置自动继续`);
            if (!(await sleepInterruptible(pw, handle))) break;
            await setLoopWait(null);
          }
        } else if (r.rateLimited) {
          // B: 429/88 是环境问题不是这个人的问题 → 不标失败不进 stall,
          // 等窗口重置后重试同一人; 连续超过 3 次才标 failed 跳过
          if (rateRetryUserId !== item.userId) { rateRetryUserId = item.userId; rateRetryCount = 1; }
          else rateRetryCount++;
          // 人为冷却仅挂关注循环的 429/88(有 reset 时公式内叠加; 无头不加)。拉取/搜索不传。
          const coolMs = Math.max(0, Math.min(10, settings.humanCooldownMin ?? 1)) * 60_000;
          const backoff = rateLimitBackoffMs(r, Date.now(), settings.rateLimitBackoffMin * 60_000, 5000, coolMs);
          if (rateRetryCount > 3) {
            current.status = 'failed';
            current.error = `连续限流 ${rateRetryCount} 次: ${r.errorText}`;
            task.lastError = `${atName(current)}: ${current.error}`;
            await io[src].save(handle, task);
            await log(`关注失败 ${atName(current)}: 连续限流, 暂时跳过(恢复时重新入队)`);
            rateRetryUserId = null;
          } else {
            const resetTxt = r.rateReset ? ', 窗口 ' + new Date(r.rateReset * 1000).toLocaleTimeString() + ' 重置' : '';
            await setLoopWait({ until: Date.now() + backoff, text: '限流重试' });
            await log(`限流(连续第${rateRetryCount}次, 满3次跳过)${resetTxt}, ${Math.round(backoff / 1000)}秒后重试同一人 ${atName(current)}`);
            if (!(await sleepInterruptible(backoff, handle))) break;
            await setLoopWait(null);
          }
        } else if (r.alreadyFollowing) {
          // 160: 对方已在关注列表(或无法关注)——不是故障, 标 skipped 不进失败窗口
          rateRetryUserId = null;
          current.status = 'skipped';
          current.error = r.errorText;
          await io[src].save(handle, task);
          await log(`跳过 ${atName(current)}(已关注/无法关注)`);
        } else {
          // 其他失败: 标 failed, 记原始错误
          rateRetryUserId = null;
          current.status = 'failed';
          current.error = r.errorText;
          task.lastError = `${atName(current)}: ${r.errorText}`;
          if (r.followLimited) {
            // 161: 关注数已达上限(实测包在 HTTP 403 里返回)。X 按 24h 滚动窗口重置, 与本地 0 点无关,
            // 固定等到次日 0 点会白等十几小时 → 定时探测: 每 dailyLimitRetryMin 分钟恢复试一次,
            // 成功即续跑, 仍 161 则再等一轮。重试时该项标 failed 后由 resumeTask 重新入队, 不会丢人。
            await io[src].save(handle, task);
            await log(`关注数已达上限: ${settings.dailyLimitRetryMin}分钟后自动探测重试(直到额度恢复)`);
            await pauseTask(handle, 'daily-limit', Date.now() + settings.dailyLimitRetryMin * 60_000);
          } else if (res.status === 403) {
            // 403 且非 161/160: 大概率回关模板过期 → 立即暂停 + 系统通知, 不空转烧请求
            await io[src].save(handle, task);
            await log(`模板过期(403) ${atName(current)}: 请在认证粉丝列表点一次「回关」刷新模板, 然后手动恢复`);
            await pauseTask(handle, 'template-expired');
          } else {
            task.consecutiveFailures.push(Date.now());
            const stall = evaluateStall(task.consecutiveFailures, Date.now(), settings.stallMin * 60_000, settings.stallMin * 60_000);
            task.consecutiveFailures = stall.kept;
            await io[src].save(handle, task); // 先落库
            await log(`关注失败 ${atName(current)}: ${r.errorText}`);
            if (stall.shouldPause) {
              await pauseTask(handle, 'stalled', Date.now() + settings.autoResumeMin * 60_000);
            }
          }
        }
        task = await io[src].get(handle);
        if (!task || task.state !== 'running') break;
      }
    } finally {
      loopRunning = false;
      runningHandle = null;
      await setLoopWait(null);
    }
  }

  // ---------- 自动恢复 / 自动拉取 / 互关帖扫描观察器 ----------
  async function autoTick() {
    // 任务归属永久锚定最近活跃账号: 接管/恢复在任意 x.com 页面都能继续;
    // URL handle 只有匹配登录账号(pageHandle)才用于 setActive/自动拉取(ADR-0003)
    const handle = await pageHandle();
    let active = handle || (await store.get(K.active, null)) || '';
    if (handle) setActive(handle);
    if (!active) {
      // 无 URL handle 的页面(/home 等)也要能建立身份——否则"打开 x.com 完成识别"是死路。
      // 先问 API(whoami), 再读 DOM(Profile 标签, 零请求), 成功即落盘; 各自自带负缓存/纯同步, 不会扛接口
      const me = (await whoamiHandle()) || loggedInHandle();
      if (me) { await setActive(me); active = me; }
    }
    const tag = curTag();
    if (!active && !tag) return;
    if (fetchingFollowers || afSearching || afScanning || afBurstScanning) return;
    const settings = await getSettings();

    // 池子断供自动补池: 待关注低于水位 + 无到期帖(当日已扫完/池见底) + 冷却已过 → 自动抓一轮新帖。
    // 放在标签页分支之前: 任一 x.com 页面都能触发(Route 1 直连不挑场); 搜到新人 → done 自动续跑。
    {
      const h = await afHandle();
      if (h) {
        const af = await getAfTask(h);
        const autoTag = nextAutoSearchTag(settings.tags, af.lastAutoSearchTag);
        if (autoTag && shouldAutoSearch(af, Date.now(),
          { pendingTarget: AF.PENDING_TARGET, scanMax: AF.SCAN_MAX, poolMin: AF.POOL_MIN, cooldownMs: AF.AUTO_SEARCH_COOLDOWN_MS })) {
          if (await acquireLock()) {
            await log(`池子断供自动补池: 待关注低于水位${AF.PENDING_TARGET}且池子供给不足(存活帖<${AF.POOL_MIN}或无到期帖), 自动抓取 #${autoTag}`);
            runAfSearch(autoTag, h).catch((e) => log(`自动抓取异常: ${e}`));
          }
          return; // 本 tick 到此为止(与扫描/回关拉取的互斥由顶部 afSearching 等闸门 + 抓取内节奏控制保证)
        }
      }
    }

    // 互关标签页: 主动关注任务接管/恢复优先, 其次到期帖扫描(每 tick 一帖)
    if (tag) {
      const h = await afHandle();
      if (!h) return;
      const af0 = await getAfTask(h);
      // 接管中断的任务(页面刷新后 loopRunning=false, 任务仍是 running)
      if (af0.state === 'running' && !loopRunning) {
        if (!(await isLockMine()) && !(await acquireLock())) return;
        runLoop(h);
        return;
      }
      if (af0.state === 'paused' && af0.nextAutoResumeAt && Date.now() >= af0.nextAutoResumeAt) {
        if (await acquireLock()) resumeTask(h); // 恢复入口双任务同步
        return;
      }
      // 到期帖扫描: 生产者, 与循环解耦(纯追加合并); 无到期帖时内部静默返回。
      // 不再要求页面可见: 扫描走 Route 1 直连, 后台标签页照样能发(定时器节流到 ~1次/分,
      // 恰好匹配一 tick 一帖的节奏); 只要标签页存在即可
      if (await acquireLock()) runAfScanOne(tag, h);
      return; // 标签页不做回关自动拉取(那是 verified_followers 页的事)
    }

    if (fetchingFollowers) return;

    // 自动拉取: 仅在已验证的本账号 followers 页触发(模板在该页捕获); 页面可见 + 距上次拉取超 autoFetchMin 分钟
    const t0 = await getTask(active);
    if (document.visibilityState === 'visible' && handle &&
        (!t0.lastFetchAt || Date.now() - t0.lastFetchAt >= settings.autoFetchMin * 60_000)) {
      if (await acquireLock()) runFetch(active);
      return;
    }

    // 页面刷新后接管中断的任务(锚定 active, 任何页面都能接管)
    if (t0.state === 'running') {
      if (!loopRunning && !(await isLockMine()) && (await acquireLock())) runLoop(active);
      return;
    }
    // 暂停到期自动恢复
    if (t0.state === 'paused' && t0.nextAutoResumeAt && Date.now() >= t0.nextAutoResumeAt) {
      if (await acquireLock()) resumeTask(active);
    }
  }
  intervals.push(setInterval(autoTick, 30_000));
  autoTick();

  // ---------- options 页消息入口 ----------
  // 控制台已改 storage 直读(与 popup 同法), 这里只保留两件只有页面才知道的事:
  //   tpl-captured: 回关模板是否已捕获(MAIN world 的捕获记录); 页面早于插件安装/重载打开时是孤儿,
  //                 无响应 → 控制台会用 scripting API 补注入自愈
  //   reset-task:   清任务(经由页面保证运行中循环下一拍即见空; 页面不可达时控制台直接清 storage)
  msgHandler = (msg, sender, sendResponse) => {
    if (halted) return false; // 孤儿不响应也不占通道, 让新注入的实例接管
    (async () => {
      try {
        const h = await activeHandle();
        switch (msg && msg.cmd) {
          case 'tpl-captured': {
            let captured = null;
            try {
              const cap = await callPage('list-captured', {});
              captured = (cap.apiEndpoints || []).some((e) => e.path === FOLLOW_API);
            } catch {}
            sendResponse({ captured });
            break;
          }
          case 'start-task':
            if (!h) { sendResponse({ ok: false, message: '未识别到登录账号——先打开 x.com 完成识别' }); break; }
            sendResponse(await startTask(h));
            break;
          case 'start-af-task':
            if (!h) { sendResponse({ ok: false, message: '未识别到登录账号——先打开 x.com 完成识别' }); break; }
            sendResponse(await startAfTask(h));
            break;
          case 'af-search': {
            // 抓取宿主=任意 x.com 标签页(Route 1 直连不挑场), 标签由调用方指定并按配置校验
            // (旧机制要求互关标签页在场, 只是为了从 URL 拿标签+捕获模板; Route 1 落地后两者都不再必需)。
            // 立即应答, 搜索转后台执行——全程可达数分钟(桶节奏 30s/发、池子供血、tid 冷却 70s),
            // 若同步等它, 按钮会几分钟无反应。进度走 rf_af_progress + 日志, 双击由 afSearching 拦下。
            if (afSearching) { sendResponse({ ok: false, message: '已在搜索中, 等本轮跑完' }); break; }
            if (afBurstScanning) { sendResponse({ ok: false, message: '正在连扫帖子, 等本轮跑完再抓取' }); break; }
            const tags = ((await getSettings()).tags) || [];
            const norm = (t) => String(t || '').replace(/^#/, '').trim().toLowerCase();
            const want = norm(msg.tag);
            const tag = tags.find((t) => norm(t) === want) || (tags.length === 1 ? tags[0] : null);
            const tagStr = tag ? String(tag).replace(/^#/, '').trim() : null;
            if (!tagStr) {
              sendResponse({ ok: false, message: want ? `#${want} 不在配置的互关标签里——先在设置里添加` : '未指定标签——先在设置里配置互关标签' });
              break;
            }
            runAfSearch(tagStr, h).catch((e) => log(`抓取异常: ${e}`));
            sendResponse({ ok: true, message: '搜索已发车——进度见控制台状态行与日志(页间有节奏控制, 非卡住)' });
            break;
          }
          case 'af-scan': {
            // 手动连扫: 任意 x.com 宿主, 跨标签扫到期帖补待关注到 MANUAL_SCAN_TARGET。
            // 立即应答(校验在 runAfScanBurst 内), 循环转后台; 进度 rf_af_scan_progress。
            if (!h) { sendResponse({ ok: false, message: '未识别到登录账号——先打开 x.com 完成识别' }); break; }
            sendResponse(await runAfScanBurst(h));
            break;
          }
          case 'pause-task':
            if (!h) { sendResponse({ ok: false, message: '未识别到登录账号' }); break; }
            await pauseTask(h, 'manual');
            sendResponse({ ok: true, message: '已暂停' });
            break;
          case 'resume-task':
            if (!h) { sendResponse({ ok: false, message: '未识别到登录账号' }); break; }
            await resumeTask(h);
            sendResponse({ ok: true, message: '已恢复' });
            break;
          case 'refresh-list':
            sendResponse(await requestRefresh());
            break;
          case 'diff-fetch': {
            // 未回关名单拉取: fire-and-forget(可达数分钟), 立即应答; 进度走 fb_diff_progress + 日志
            if (fetchingDiff) { sendResponse({ ok: false, message: '已在拉取中, 请等本轮完成' }); break; }
            runDiffFetch().catch((e) => log(`未回关名单拉取异常: ${e}`));
            sendResponse({ ok: true, message: '拉取已发车——进度见日志(页间有节奏控制, 非卡住)' });
            break;
          }
          case 'reset-task': await store.set(taskKey(h), null); sendResponse({ ok: true }); break;
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
  let cachedAfTask = null;   // 主动关注任务缓存(仅互关标签页展示用)
  let cachedAfHandle = '';
  let cachedAfProgress = null; // 搜索阶段进度(存储键, 搜索结束后置 null)

  const WIDGET_CSS = `
    #xfollowback-widget { position: fixed; top: 20px; z-index: 99999; display: flex; flex-direction: column; align-items: flex-end;
      pointer-events: none; font: 13px/1.5 -apple-system, system-ui, sans-serif; }
    #xfollowback-widget > * { pointer-events: auto; }
    #xfollowback-pill { display: flex; align-items: center; gap: 8px; padding: 8px 18px; border-radius: 9999px;
      background: #1d9bf0; color: #fff; border: 1px solid #1a8cd8; box-shadow: 0 2px 12px rgba(0,0,0,.25);
      cursor: pointer; user-select: none; white-space: nowrap; font-weight: 700; }
    #xfollowback-pill:hover { background: #1a8cd8; }
    #xfollowback-pill .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px rgba(255,255,255,.85); }
    #xfollowback-pill.alert { background: #dc2626; border-color: #dc2626; animation: xfollowbackPulse 1.2s ease-in-out infinite; }
    @keyframes xfollowbackPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.07); } }
    #xfollowback-panel { position: absolute; top: calc(100% + 8px); right: 0; width: 340px;
      background: #fff; color: #0f1419; border: 1px solid #e1e8ed;
      border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.22); padding: 14px 16px; }
    #xfollowback-panel .rf-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
    #xfollowback-panel .rf-head span { color: #536471; font-size: 12px; }
    #xfollowback-panel .rf-status { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    #xfollowback-panel .rf-status .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
    #xfollowback-panel .rf-nums { margin-bottom: 8px; }
    #xfollowback-panel .rf-nums b { font-size: 16px; }
    #xfollowback-panel .rf-alert { background: #fdecec; color: #b02a37; border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-bottom: 8px; font-weight: 700; }
    #xfollowback-panel .rf-err { color: #b02a37; font-size: 12px; margin-bottom: 8px; word-break: break-all; }
    #xfollowback-panel .rf-btns { display: flex; gap: 8px; margin-bottom: 8px; }
    #xfollowback-panel .rf-guide { background: #e8f5fd; color: #0b5ed7; border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-bottom: 8px; font-weight: 700; }
    #xfollowback-panel .rf-msg { background: #e8f5fd; color: #0b5ed7; border-radius: 8px; padding: 6px 10px; font-size: 12px; margin-bottom: 8px; font-weight: 700; }
    #xfollowback-panel .rf-keep { color: #b45309; font-size: 12px; background: #fff7ed; border-radius: 8px; padding: 6px 10px; }
    #xfollowback-widget .rf-btn { padding: 7px 20px; border-radius: 9999px; font-weight: 700; font-size: 13px; cursor: pointer; border: none; }
    #xfollowback-widget .rf-btn.primary { background: #1d9bf0; color: #fff; }
    #xfollowback-widget .rf-btn.primary:hover { background: #1a8cd8; }
    #xfollowback-widget .rf-btn.warn { background: #dc2626; color: #fff; }
    #xfollowback-widget .rf-btn.warn:hover { background: #b91c1c; }
    #xfollowback-widget .rf-btn.ghost { background: #fff; color: #1d9bf0; border: 1px solid #1d9bf0; font-weight: 400; }
    #xfollowback-widget .rf-btn.ghost:hover { background: #e8f5fd; }
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

  // 主动关注状态文案(done = 队列已清空, 与回关的"等待新粉"区分)
  function afCurrentState(t) {
    if (!t) return STATE_STYLE.idle;
    if (t.state === 'running') return (cachedAfProgress || afSearching || afScanning || afBurstScanning) ? { text: '后台任务中', color: '#7c3aed' } : STATE_STYLE.running;
    if (t.state === 'paused') return STATE_STYLE['paused:' + t.pauseReason] || { text: '已暂停', color: '#d97706' };
    if (t.state === 'done') return { text: '队列已空', color: '#16a34a' };
    return STATE_STYLE.idle;
  }

  async function refreshCache() {
    // 回关任务: 认证粉丝页用 URL 里的账号, 其余页面用最近活跃账号
    // 回关任务: URL handle 匹配登录账号才用它, 否则退回最近活跃(逛别人主页时面板仍显示自己的任务)
    const h = (await pageHandle()) || (await store.get(K.active, null));
    cachedTask = h ? await getTask(h) : null;
    cachedFetchProgress = await store.get(K.fetchProgress, null);
    // 主动关注: 仅互关标签页展示; 账号识别与 afHandle 同链(接口为准, ADR-0003)
    cachedTags = ((await getSettings()).tags) || [];
    const tag = curTag();
    const ah = tag ? await afHandle() : '';
    cachedAfHandle = ah;
    cachedAfTask = tag && ah ? await getAfTask(ah) : null;
    cachedAfProgress = await store.get(K.afProgress, null);
  }
  chrome.storage.onChanged.addListener(refreshCache);
  refreshCache();

  function renderWidget() {
    if (!widget) return;
    const tag = curTag();
    if (tag) return renderAfWidget(tag);
    const t = cachedTask || { state: 'idle' };
    const q = t.queue || [];
    const total = q.length;
    const pending = q.filter((i) => i.status === 'pending').length;
    const st = currentState(t);
    const waitMin = (at) => (at ? Math.max(0, Math.ceil((at - Date.now()) / 60000)) : 0);
    const sig = [t.state, t.pauseReason, total, pending, st.text, panelOpen, panelMsg, cachedTemplateCaptured,
      waitMin(t.nextAutoResumeAt), loopWait ? loopWait.text + waitMin(loopWait.until) : '',
      cachedFetchProgress ? cachedFetchProgress.page : 0, t.lastError, t.screenName].join('|');
    if (sig === widget.dataset.sig) return; // 内容没变跳过重渲染, 避免打断点击
    widget.dataset.sig = sig;

    const pill = widget.querySelector('#xfollowback-pill');
    if (st.alert) {
      pill.classList.add('alert');
      pill.textContent = `⚠ ${st.text} · 点击处理`;
    } else {
      pill.classList.remove('alert');
      pill.innerHTML = `<span class="dot" style="background:${st.color}"></span>待回关 ${pending}`;
    }

    const panel = widget.querySelector('#xfollowback-panel');
    const pauseHint = t.state === 'paused' && t.nextAutoResumeAt
      ? ' · ' + Math.max(0, Math.round((t.nextAutoResumeAt - Date.now()) / 60000)) + '分钟后自动恢复' : '';
    const loopWaitHint = loopWait
      ? ` · ${loopWait.text}, 约${Math.max(1, Math.ceil((loopWait.until - Date.now()) / 60000))}分钟后继续` : '';
    const fetchInfo = cachedFetchProgress ? ` · 第${cachedFetchProgress.page}页/累计${cachedFetchProgress.users}人` : '';
    panel.innerHTML = `
      <div class="rf-head"><strong>XFollowBack</strong><span>@${escHtml(t.screenName) || '—'}</span></div>
      <div class="rf-status"><span class="dot" style="background:${st.color}"></span>${st.text}${pauseHint}${loopWaitHint}${fetchInfo}</div>
      <div class="rf-nums">总数 <b>${total}</b> · 待回关 <b>${pending}</b></div>
      ${cachedTemplateCaptured === false ? `<div class="rf-guide">首次使用: 请在下方列表中手动点一次任意用户的「回关」按钮, 插件即可学会自动回关(只需一次)</div>` : ''}
      ${st.alert ? `<div class="rf-alert">回关模板已过期——请在列表点一次「回关」, 插件会自动恢复</div>` : ''}
      ${panelMsg ? `<div class="rf-msg">${escHtml(panelMsg)}</div>` : ''}
      ${t.lastError ? `<div class="rf-err">最近错误: ${escHtml(t.lastError).slice(0, 160)}</div>` : ''}
      <div class="rf-btns"><button class="rf-btn ghost" data-act="console">打开控制台</button></div>
      <div class="rf-keep">⏳ 任务在此页面内运行, 请保持标签页开启——关闭后会暂停, 重新打开会自动继续</div>
    `;
  }

  // 互关标签页面板(主动关注): 状态/帖子池/队列 + 抓取与启停
  function renderAfWidget(tag) {
    const t = cachedAfTask || { state: 'idle' };
    const q = t.queue || [];
    const total = q.length;
    const pending = q.filter((i) => i.status === 'pending').length;
    const pool = (t.tags && t.tags[tag] && t.tags[tag].posts) || [];
    const dueCount = pool.filter((p) => p.scanCount < AF.SCAN_MAX && p.nextScanAt <= Date.now()).length;
    const st = afCurrentState(t);
    // 倒计时按分钟纳入 sig: 每过一分钟触发一次重渲染, 否则"N分钟后"会冻结在首次渲染的数值
    const waitMin = (at) => (at ? Math.max(0, Math.ceil((at - Date.now()) / 60000)) : 0);
    const sig = ['af', t.state, t.pauseReason, total, pending, pool.length, dueCount, st.text,
      waitMin(t.nextAutoResumeAt), loopWait ? loopWait.text + waitMin(loopWait.until) : '',
      panelOpen, panelMsg, cachedTemplateCaptured, afScanning, afSearching, afBurstScanning,
      cachedAfProgress ? cachedAfProgress.page : 0, t.lastError, t.screenName, tag].join('|');
    if (sig === widget.dataset.sig) return;
    widget.dataset.sig = sig;

    const pill = widget.querySelector('#xfollowback-pill');
    if (st.alert) {
      pill.classList.add('alert');
      pill.textContent = `⚠ ${st.text} · 点击处理`;
    } else {
      pill.classList.remove('alert');
      pill.innerHTML = `<span class="dot" style="background:${st.color}"></span>主动关注 ${pending}`;
    }

    const panel = widget.querySelector('#xfollowback-panel');
    const pauseHint = t.state === 'paused' && t.nextAutoResumeAt
      ? ' · ' + Math.max(0, Math.round((t.nextAutoResumeAt - Date.now()) / 60000)) + '分钟后自动恢复' : '';
    const loopWaitHint = loopWait
      ? ` · ${loopWait.text}, 约${Math.max(1, Math.ceil((loopWait.until - Date.now()) / 60000))}分钟后继续` : '';
    const searchInfo = cachedAfProgress ? ` · 搜索第${cachedAfProgress.page}/${cachedAfProgress.maxPages}页`
      : (afBurstScanning ? ' · 手动连扫中' : (afScanning ? ' · 扫描回复中' : ''));
    const actionBtn = t.state === 'running'
      ? `<button class="rf-btn primary" data-act="pause">暂停</button>`
      : t.state === 'paused'
        ? `<button class="rf-btn ${st.alert ? 'warn' : 'primary'}" data-act="resume">恢复</button>`
        : `<button class="rf-btn primary" data-act="start">开始主动关注</button>`;
    panel.innerHTML = `
      <div class="rf-head"><strong>XFollowBack</strong><span>主动关注 #${escHtml(tag)} · @${escHtml(t.screenName) || '—'}</span></div>
      <div class="rf-status"><span class="dot" style="background:${st.color}"></span>${st.text}${pauseHint}${loopWaitHint}${searchInfo}</div>
      <div class="rf-nums">帖子池 <b>${pool.length}</b> · 待扫描 <b>${dueCount}</b> · 队列 <b>${total}</b> · 待关注 <b>${pending}</b></div>
      ${cachedTemplateCaptured === false ? `<div class="rf-guide">首次使用: 请先在认证粉丝列表页点一次任意用户的「回关」按钮, 插件学会关注动作后回来点「开始」(只需一次)</div>` : ''}
      ${st.alert ? `<div class="rf-alert">回关模板已过期——请在认证粉丝列表页点一次「回关」刷新, 再点「恢复」</div>` : ''}
      ${panelMsg ? `<div class="rf-msg">${escHtml(panelMsg)}</div>` : ''}
      ${t.lastError ? `<div class="rf-err">最近错误: ${escHtml(t.lastError).slice(0, 160)}</div>` : ''}
      <div class="rf-btns">${actionBtn}<button class="rf-btn ghost" data-act="af-search">抓取互关帖</button><button class="rf-btn ghost" data-act="af-scan">扫描帖子</button></div>
      <div class="rf-keep">⏳ 保持本标签页开启: 扫描与关注都在此页面内运行, 关闭会暂停, 重新打开自动继续</div>
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
      const pill = widget.querySelector('#xfollowback-pill');
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

  // 手动关注兑底(ADR-0007): 页面上手动点「关注」撞额度失败的人, 收进主动关注队列,
  // 额度恢复后由循环自动补关注(显式人工意图 → 不做蓝V/求粉过滤, 队列去重+回关互斥照旧)。
  // 由 ensureBar 每5秒调一次; take 即清, 身份未知/自己粉丝页场景不取, 失败记录留在 page-hook 下轮再取。
  async function pollManualFollows() {
    try {
      const h = await activeHandle();
      if (!h) return; // 身份未知: 不取走, 留给下一轮
      // 自己的认证粉丝页上点「关注」= 回关意图(目标必是已关注自己的人),
      // 回关拉取会自然把它们收进回关队列, 不重复入主动关注
      const m = /^\/([^/]+)\/verified_followers/.exec(location.pathname);
      if (m && m[1].toLowerCase() === String(h).toLowerCase()) return;
      const r = await callPage('take-failed-follows', {});
      const follows = ((r && r.follows) || []).filter((f) => f.userId);
      // 诊断: 每条未被捕获的关注失败都落一行日志(含请求/响应片段), "为什么没接住"一目了然
      for (const d of ((r && r.diag) || [])) {
        if (d.note === 'captured') continue;
        await log(`关注失败观测(未捕获): HTTP ${d.status}, body格式=${d.fmt}, 原因=${d.note}, ` +
          `请求片段=${(d.reqHead || '').slice(0, 80) || '-'} 响应片段=${(d.bodyHead || '').slice(0, 100) || '-'}`);
      }
      if (!follows.length) return;
      const { added } = await enqueueAfCandidates(
        h,
        follows.map((f) => ({ userId: f.userId, screenName: f.screenName || '', name: '', source: null })),
        null
      );
      if (!added) {
        await log(`手动关注撞额度兑底: ${follows.length}人已在队列(或已在回关队列), 不重复入队`);
        return;
      }
      const names = follows.slice(0, 3).map((f) => '@' + (f.screenName || f.userId)).join(' ');
      await log(`手动关注撞额度兑底: ${added}人收进主动关注队列(额度恢复→自动补关注): ${names}${follows.length > 3 ? ' 等' : ''}`);
      sendBg({
        cmd: 'notify', tag: 'rf-manual-follow',
        title: 'XFollowBack: 已记入稍后关注',
        message: `关注额度不足, ${added}人已入主动关注队列, 额度恢复后自动补关注`,
      });
    } catch {}
  }

  let lastPath = '';
  let ffTick = 0; // 手动关注兑底轮询计数(独立于 tplTick: 后者在无控件页面会提前 return 不递增)
  function ensureBar() {
    // SPA 路由切换不触发 storage 事件, 靠路径变化强制刷新缓存(否则控件拿旧任务渲染)
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      refreshCache();
    }
    // 手动关注兑底轮询(ADR-0007):
    // ⚠ 必须在「非标签页/非认证粉丝页提前 return」之前调——手动关注发生在任意页面(逛主页/搜索/时间线)
    if (++ffTick % 5 === 0) pollManualFollows();
    const tag = curTag();
    const onVerifiedFollowers = /^\/[^/]+\/verified_followers/.test(location.pathname);
    // 认证粉丝页 → 回关面板; 已配置的互关标签页 → 主动关注面板; 其余页面不展示
    if (!tag && !onVerifiedFollowers) {
      if (widget) { widget.remove(); widget = null; }
      return;
    }
    // 每5秒检查一次回关模板捕获状态(捕获发生在 MAIN world 内存, storage 变化感知不到)
    if (++tplTick % 5 === 1 || cachedTemplateCaptured == null) {
      callPage('list-captured', {}).then(async (cap) => {
        const v = !!(cap && (cap.apiEndpoints || []).some((e) => e.path === FOLLOW_API));
        if (v !== cachedTemplateCaptured) {
          cachedTemplateCaptured = v;
          if (v) {
            if (panelOpen) setPanelMsg('✓ 模板已捕获');
            // 模板过期暂停后的自动恢复: 用户刚在列表里点了一次「回关」, 不必再去找「恢复」按钮
            try {
              const h = await activeHandle();
              const t = h && (await getTask(h));
              if (t && t.state === 'paused' && t.pauseReason === 'template-expired') {
                await resumeTask(h);
                await log('模板已刷新, 自动恢复任务');
              }
            } catch {}
          }
          renderWidget();
        }
      }).catch(() => {});
    }
    if (!widget) {
      widget = document.createElement('div');
      widget.id = 'xfollowback-widget';
      widget.innerHTML = `<style>${WIDGET_CSS}</style><div id="xfollowback-pill"></div><div id="xfollowback-panel" style="display:none"></div>`;
      widget.addEventListener('click', (ev) => {
        const panel = widget.querySelector('#xfollowback-panel');
        const act = ev.target && ev.target.dataset && ev.target.dataset.act;
        if (act) {
          ev.preventDefault(); ev.stopPropagation();
          if (act === 'console') { sendBg({ cmd: 'open-options' }); return; }
          // 标签页 URL 没有账号名, 异步解析(侧栏读取, 退回最近活跃)
          const tag = curTag();
          const taskHandle = tag ? afHandle() : pageHandle();
          taskHandle.then((handle) => {
            if (act === 'start') return (tag ? startAfTask(handle) : startTask(handle)).then((r) => setPanelMsg(r.message || '已启动'));
            if (act === 'af-search') return runAfSearch(tag, handle).then((r) => setPanelMsg(r.message || String(r.ok)));
            if (act === 'af-scan') return runAfScanBurst(handle).then((r) => setPanelMsg(r.message || String(r.ok)));
            if (act === 'refresh') return requestRefresh().then((r) => setPanelMsg(r.message || String(r.ok)));
            if (act === 'pause') return pauseTask(handle, 'manual').then(() => setPanelMsg('已暂停'));
            if (act === 'resume') return resumeTask(handle).then(() => setPanelMsg('已恢复'));
          }).catch(() => {});
          return;
        }
        if (ev.target.closest('#xfollowback-pill')) {
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
