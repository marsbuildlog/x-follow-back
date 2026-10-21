// 控制台宿主运行时(ADR-0010): 关注循环 + 抓取/连扫/未回关名单编排跑在 options 页。
// 依赖: constants / logic / tidpool / route1 已挂 globalThis; 由 options.html 先于本文件加载。
(() => {
  'use strict';
  const RF = globalThis.RF;
  const L = globalThis.XFollowBackLogic;
  if (!RF || !L) {
    console.error('[XFollowBack] host-runtime 依赖未挂载');
    return;
  }
  const K = RF.KEY;
  const AF = RF.AF;
  const OP_FOLLOWERS = 'BlueVerifiedFollowers';
  const OP_FOLLOWING = 'Following'; // 我关注的用户列表(未回关名单)
  const OP_SEARCH = 'SearchTimeline';
  const OP_TWEET_DETAIL = 'TweetDetail';
  const FOLLOW_API = '/i/api/1.1/friendships/create.json';

  const {
    parseFollowers, parseFollowList, interpret, mergeUsers, findPendingItem, evaluateStall, rolloverDaily, atName,
    rateLimitBackoffMs, windowExhaustedWaitMs, parseSearchTimeline, parseTweetDetail, afEligible,
    pickNextItem, mergeAfCandidates, upsertPosts, duePost, duePostAcrossTags, markScanned,
    nextAutoSearchTag, shouldAutoSearch,
  } = L;

  const store = {
    async get(k, d) {
      try {
        const r = await chrome.storage.local.get(k);
        return k in r ? r[k] : d;
      } catch { return d; }
    },
    async set(k, v) {
      try { await chrome.storage.local.set({ [k]: v }); return true; } catch { return false; }
    },
  };

  const taskKey = (h) => `${K.task}:${h}`;
  const dailyKey = (h) => `${K.daily}:${h}`;
  const afTaskKey = (h) => `${K.afTask}:${h}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  async function log(text) {
    const arr = (await store.get(K.log, [])) || [];
    arr.push({ ts: Date.now(), text: String(text).slice(0, 500) });
    while (arr.length > 200) arr.shift();
    await store.set(K.log, arr);
  }
  async function getSettings() {
    return { ...RF.DEFAULTS, ...((await store.get(K.settings, {})) || {}) };
  }
  function newTask(handle) {
    return {
      state: 'idle', pauseReason: null, nextAutoResumeAt: null,
      screenName: handle, queue: [], consecutiveFailures: [],
      lastError: null, lastFetchAt: null, updatedAt: 0,
    };
  }
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
    t.screenName = handle; t.updatedAt = Date.now();
    await store.set(taskKey(handle), t);
  }
  async function getAfTask(handle) {
    if (!handle) return newAfTask('');
    return (await store.get(afTaskKey(handle), null)) || newAfTask(handle);
  }
  async function saveAfTask(handle, t) {
    t.screenName = handle; t.updatedAt = Date.now();
    await store.set(afTaskKey(handle), t);
  }
  async function getDaily(handle) {
    return rolloverDaily(await store.get(dailyKey(handle), null));
  }
  async function setActive(handle) {
    if (handle) await store.set(K.active, handle);
  }
  async function activeHandle() {
    return runningHandle || (await store.get(K.active, null)) || '';
  }

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

  async function findXTab() {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
      if (!tabs.length) return null;
      return tabs.find((t) => /\/verified_followers/.test(t.url || '')) || tabs[0];
    } catch { return null; }
  }

  // 兑底: 让某 x.com 页重放 create.json
  async function pageReplayFollow(userId) {
    const tab = await findXTab();
    if (!tab) return { error: '无 x.com 标签页可兑底重放——请打开认证粉丝页并点一次回关刷模板' };
    try {
      return await chrome.tabs.sendMessage(tab.id, { cmd: 'page-replay-follow', userId: String(userId) });
    } catch (e) {
      return { error: '页面重放失败: ' + ((e && e.message) || e) };
    }
  }

  async function followUser(userId) {
    const uid = String(userId);
    const r1 = await sendBg({ cmd: 'route1-follow', userId: uid });
    if (r1 && r1.status != null && !r1.transport) {
      return { status: r1.status, ok: !!r1.ok, body: r1.body || '', rl: r1.rl || {}, via: r1.via || 'route1' };
    }
    const res = await pageReplayFollow(uid);
    if (res && res.status != null) return Object.assign({}, res, { via: 'page' });
    const why = (r1 && r1.error) ? `Route 1 失败(${r1.error}); ` : '';
    throw new Error(why + ((res && res.error) || '页面重放不可用'));
  }
  // 取关: destroy.json 直连(与 create 同形态); 无页面重放兑底(未回关名单只走 Route 1)
  async function unfollowUser(userId) {
    const uid = String(userId);
    const r1 = await sendBg({ cmd: 'route1-unfollow', userId: uid });
    if (r1 && r1.status != null && !r1.transport) {
      return { status: r1.status, ok: !!r1.ok, body: r1.body || '', rl: r1.rl || {}, via: r1.via || 'route1' };
    }
    throw new Error((r1 && r1.error) || '取关直连失败');
  }
  function unfollowSucceeded(res) {
    const r = interpret(res);
    if (r.ok) return { ok: true, rateLimited: false };
    const body = String((res && res.body) || '');
    // 已不在关注列表 / 幂等成功
    if (/not following|You are not friends|already unfollowed|还未关注/i.test(body.slice(0, 2000))) {
      return { ok: true, rateLimited: false, already: true };
    }
    return { ok: false, rateLimited: !!r.rateLimited, errorText: r.errorText };
  }

  // ---------- 领导权锁(控制台优先 token 前缀 console-) ----------
  let myLockToken = null;
  async function acquireLock() {
    const lock = await store.get(K.lock, null);
    const now = Date.now();
    const fresh = lock && now - lock.ts < 15_000;
    if (fresh && lock.token !== myLockToken) return false;
    myLockToken = myLockToken || ('console-' + Math.random().toString(36).slice(2));
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

  async function sleepSegments(ms) {
    const deadline = Date.now() + ms;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return true;
      await sleep(Math.min(remaining, 30_000));
    }
  }
  async function sleepInterruptible(ms, handle) {
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

  // ---------- 搜索 / 详情(Route 1 only) ----------
  let lastSearchFireAt = 0;
  let lastSearchOkAt = 0;
  let afSearching = false;
  let afScanning = false;
  let afBurstScanning = false;
  let fetchingFollowers = false;
  let fetchingDiff = false;
  let unfollowingDiff = false;
  let unfollowAbort = false;

  async function hasGqlTpl(op) {
    try {
      const { [K.gqlTpl + ':' + op]: tpl } = await chrome.storage.local.get(K.gqlTpl + ':' + op);
      return !!(tpl && tpl.p && tpl.q && tpl.v0);
    } catch { return false; }
  }
  async function awaitSearchGap(label) {
    const sinceFire = Date.now() - lastSearchFireAt;
    if (sinceFire < AF.SEARCH_MIN_GAP_MS) {
      const waitMs = AF.SEARCH_MIN_GAP_MS - sinceFire;
      await log(`${label}节奏控制, 等${Math.ceil(waitMs / 1000)}秒`);
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

  async function searchPage(rawQuery, cursor) {
    let retries = 0;
    while (true) {
      await awaitSearchGap('搜索');
      let res = await sendBg({
        cmd: 'route1-graphql', op: OP_SEARCH,
        vars: { rawQuery, count: AF.SEARCH_PAGE_SIZE, cursor: cursor || null },
      });
      if (res && res.error) return { error: res.error + '——打开互关标签页旁听 SearchTimeline 或点手动供血' };
      if (res.status === 429) {
        if (++retries > 3) return { rateLimitedOut: true };
        const backoff = rateLimitBackoffMs(interpret(res), Date.now(), 15 * 60_000);
        await log(`搜索限流, ${Math.round(backoff / 1000)}秒后重试`);
        await sleepSegments(backoff);
        continue;
      }
      if (res.ok) lastSearchOkAt = Date.now();
      const parsed = parseSearchTimeline(res.body || '');
      if (parsed.error) {
        parsed.error = `HTTP ${res.status}: ` + parsed.error;
        if (res.status === 404 && ++retries <= 3) {
          await log(`Route 1 404(疑似 tid), 换 tid 重试(${retries}/3)`);
          continue;
        }
        return parsed;
      }
      return parsed;
    }
  }

  async function tweetDetailPage(postId, cursor) {
    let retries = 0;
    while (true) {
      await awaitSearchGap('详情');
      const res = await sendBg({
        cmd: 'route1-graphql', op: OP_TWEET_DETAIL,
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

  function eligibleFromItems(items, tag) {
    const users = [];
    const stats = { total: 0, retweet: 0, notBlue: 0, protected: 0, already: 0, ratio: 0 };
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

  async function runAfSearch(tag, handle) {
    if (afSearching) return { ok: false, message: '已在搜索中' };
    if (!handle) return { ok: false, message: '未识别到登录账号——请先完成身份识别' };
    afSearching = true;
    let done = null;
    try {
      await setActive(handle);
      {
        const t = await getAfTask(handle);
        t.lastAutoSearchAt = Date.now();
        t.lastAutoSearchTag = tag;
        await saveAfTask(handle, t);
      }
      await store.set(K.afProgress, { tag, page: 0, maxPages: AF.SEARCH_MAX_PAGES, posts: 0, running: true, updatedAt: Date.now() });
      await log(`抓取互关帖发车(控制台宿主): #${tag}, 最多${AF.SEARCH_MAX_PAGES}页`);
      const rawQuery = '#' + tag;
      let cursor = null;
      const postIds = [];
      const authorItems = [];
      for (let page = 0; page < AF.SEARCH_MAX_PAGES; page++) {
        const out = await searchPage(rawQuery, cursor);
        if (out.error) { await log(`搜索失败: ${out.error}`); done = { tag, page, maxPages: AF.SEARCH_MAX_PAGES, posts: postIds.length, running: false, error: out.error, finishedAt: Date.now(), updatedAt: Date.now() }; break; }
        if (out.rateLimitedOut) { done = { tag, page, maxPages: AF.SEARCH_MAX_PAGES, posts: postIds.length, running: false, rateLimited: true, finishedAt: Date.now(), updatedAt: Date.now() }; break; }
        const nonRtItems = [];
        for (const it of out.items || []) {
          if (it.postId) postIds.push({ postId: it.postId, replyCount: it.replyCount });
          if (!it.isRetweet) nonRtItems.push(it);
        }
        authorItems.push(...nonRtItems);
        await store.set(K.afProgress, { tag, page: page + 1, maxPages: AF.SEARCH_MAX_PAGES, posts: postIds.length, running: true, updatedAt: Date.now() });
        await log(`搜索第${page + 1}页: 累计帖子${postIds.length}, cursor=${out.cursor ? '有' : '无'}`);
        if (!out.cursor || out.cursor === cursor || out.items.length === 0) break;
        cursor = out.cursor;
      }
      const t1 = await getAfTask(handle);
      const bucket = (t1.tags[tag] = t1.tags[tag] || { posts: [] });
      upsertPosts(bucket.posts, postIds, Date.now());
      await saveAfTask(handle, t1);
      const { users } = eligibleFromItems(authorItems, tag);
      const { added } = await enqueueAfCandidates(handle, users, tag);
      await log(`抓取完成 #${tag}: 帖子${postIds.length}, 作者候选+${added}`);
      if (!done) done = { tag, page: AF.SEARCH_MAX_PAGES, maxPages: AF.SEARCH_MAX_PAGES, posts: postIds.length, running: false, finishedAt: Date.now(), updatedAt: Date.now() };
      return { ok: true, message: `抓取完成: 帖${postIds.length}, 候选+${added}` };
    } catch (e) {
      await log(`抓取异常: ${e}`);
      done = { tag, running: false, error: String(e), finishedAt: Date.now(), updatedAt: Date.now() };
      return { ok: false, message: String(e) };
    } finally {
      afSearching = false;
      if (done) await store.set(K.afProgress, done).catch(() => {});
      else await store.set(K.afProgress, { running: false, finishedAt: Date.now(), updatedAt: Date.now() }).catch(() => {});
    }
  }

  async function runAfScanOne(tag, handle) {
    if (afScanning || afSearching) return { skipped: true };
    afScanning = true;
    try {
      const t0 = await getAfTask(handle);
      const post = duePost((t0.tags[tag] && t0.tags[tag].posts) || [], Date.now(), AF.SCAN_MAX);
      if (!post) return { skipped: true };
      const postId = post.postId;
      let page = 0, cursor = null, limited = false, transportErr = null;
      const allItems = [];
      let mode = (await hasGqlTpl(OP_TWEET_DETAIL)) ? 'detail' : 'search';
      if (mode === 'search') {
        await log(`扫描帖子 ${postId}: 未旁听 TweetDetail 模板, 兑底 conversation_id 搜索`);
      }
      while (page < AF.SCAN_MAX_PAGES) {
        const pathLabel = mode === 'detail' ? '详情' : '搜索';
        // 总页数事先未知: 日志用「当前页/上限页」(SCAN_MAX_PAGES)
        await log(`扫描帖子 ${postId}: 抓取评论第${page + 1}/${AF.SCAN_MAX_PAGES}页(上限, ${pathLabel})`);
        const out = mode === 'detail'
          ? await tweetDetailPage(postId, cursor)
          : await searchPage(`conversation_id:${postId}`, cursor);
        if (out.error) {
          if (mode === 'detail' && page === 0) {
            await log(`扫描帖子 ${postId}: 详情首屏失败(${out.error}), 兑底 conversation_id 搜索`);
            mode = 'search'; cursor = null; continue;
          }
          transportErr = out.error;
          await log(`扫描帖子 ${postId} 失败: ${out.error}`);
          break;
        }
        if (out.rateLimitedOut) { limited = true; break; }
        allItems.push(...out.items);
        await log(`扫描帖子 ${postId}: 评论第${page + 1}/${AF.SCAN_MAX_PAGES}页完成, +${out.items.length}条, 累计${allItems.length}`);
        if (!out.cursor || out.cursor === cursor || out.items.length === 0) break;
        cursor = out.cursor;
        page++;
        await sleep(800 + Math.random() * 700);
      }
      const t1 = await getAfTask(handle);
      const post1 = ((t1.tags[tag] = t1.tags[tag] || { posts: [] }).posts || []).find((p) => p.postId === postId);
      let scanNo = post1 ? post1.scanCount + 1 : 1;
      if (post1) {
        if (transportErr) post1.nextScanAt = Date.now() + AF.SCAN_ERR_RETRY_MS;
        else if (limited) post1.nextScanAt = Date.now() + AF.SCAN_RETRY_MS;
        else markScanned(post1, Date.now(), AF.SCAN_INTERVAL_MS);
        await saveAfTask(handle, t1);
        scanNo = post1.scanCount;
      }
      const { users } = eligibleFromItems(allItems, tag);
      const { added } = await enqueueAfCandidates(handle, users, tag);
      const pathLabel = mode === 'detail' ? '详情' : '搜索';
      await log(`扫描帖子 ${postId} 完成(第${scanNo}/${AF.SCAN_MAX}次, ${pathLabel}实际${page + 1}页/上限${AF.SCAN_MAX_PAGES}, 解析${allItems.length}条): 候选+${added}`);
      return { added };
    } catch (e) {
      await log(`扫描异常: ${e}`);
      return { transportErr: String(e) };
    } finally {
      afScanning = false;
    }
  }

  async function runAfScanBurst(handle) {
    if (!handle) return { ok: false, message: '未识别到登录账号——请先完成身份识别' };
    if (afBurstScanning) return { ok: false, message: '已在连扫中' };
    if (afSearching) return { ok: false, message: '正在抓取互关帖, 等本轮跑完再连扫' };
    afBurstScanning = true;
    const startedAt = Date.now();
    await store.set(K.afScanProgress, {
      running: true, startedAt, updatedAt: startedAt, scanned: 0, added: 0, target: AF.MANUAL_SCAN_TARGET,
    });
    (async () => {
      let scanned = 0, added = 0;
      try {
        await log(`连扫发车(控制台宿主): 补待关注到 ${AF.MANUAL_SCAN_TARGET}`);
        while (true) {
          const t = await getAfTask(handle);
          const pending = (t.queue || []).filter((q) => q.status === 'pending').length;
          if (pending >= AF.MANUAL_SCAN_TARGET) {
            await store.set(K.afScanProgress, {
              running: false, finishedAt: Date.now(), updatedAt: Date.now(),
              scanned, added, pending, stopReason: '已达目标', target: AF.MANUAL_SCAN_TARGET,
            });
            await log(`连扫结束: 待关注${pending}≥${AF.MANUAL_SCAN_TARGET}, 扫${scanned}帖, 候选+${added}`);
            break;
          }
          const due = duePostAcrossTags(t.tags, Date.now(), AF.SCAN_MAX);
          if (!due) {
            await store.set(K.afScanProgress, {
              running: false, finishedAt: Date.now(), updatedAt: Date.now(),
              scanned, added, pending, stopReason: '无到期帖', target: AF.MANUAL_SCAN_TARGET,
            });
            await log(`连扫结束: 无到期帖, 待关注${pending}, 扫${scanned}帖, 候选+${added}`);
            break;
          }
          await store.set(K.afScanProgress, {
            running: true, startedAt, updatedAt: Date.now(), scanned, added, pending,
            currentPostId: due.post.postId, tag: due.tag, target: AF.MANUAL_SCAN_TARGET,
          });
          const r = await runAfScanOne(due.tag, handle);
          if (r && !r.skipped) {
            scanned++;
            added += (r.added || 0);
          } else if (r && r.skipped) {
            await sleep(500);
          }
        }
      } catch (e) {
        await log(`连扫异常: ${e}`);
        await store.set(K.afScanProgress, {
          running: false, finishedAt: Date.now(), updatedAt: Date.now(),
          scanned, added, error: String(e), target: AF.MANUAL_SCAN_TARGET,
        });
      } finally {
        afBurstScanning = false;
      }
    })();
    return { ok: true, message: '连扫已发车——进度见控制台状态行与日志' };
  }

  // ---------- 未回关名单(Route 1 Following) ----------
  // 翻页拉自己的 Following, 过滤 followedBy=false; 进度 fb_diff_progress, 结果 fb_diff:{handle}。
  // 前提: rf_tpl:Following 已捕获(先打开一次自己的 /following)。
  // 页间受 FOLLOWING_MIN_GAP_MS 节流(同路径 tid 冷却 70s, 过快会烧穿池)。
  let lastFollowingFireAt = 0;
  async function awaitFollowingGap() {
    const gap = AF.FOLLOWING_MIN_GAP_MS || 5_000;
    const sinceFire = Date.now() - lastFollowingFireAt;
    if (sinceFire < gap) {
      const waitMs = gap - sinceFire;
      await log(`未回关名单: 节奏控制, 等${Math.ceil(waitMs / 1000)}秒(防 tid 池烧穿)`);
      try {
        const cur = await store.get(K.diffProgress, null);
        if (cur && cur.running) await store.set(K.diffProgress, Object.assign({}, cur, { ts: Date.now() }));
      } catch {}
      await sleepSegments(waitMs);
    }
    lastFollowingFireAt = Date.now();
  }
  async function runDiffFetch() {
    if (fetchingDiff) return { ok: false, message: '已在拉取中, 请等本轮完成' };
    if (unfollowingDiff) return { ok: false, message: '正在批量取关, 请先停止或等结束再拉取' };
    fetchingDiff = true;
    try {
      const handle = await activeHandle();
      if (!handle) {
        const msg = '未回关名单: 未识别到登录账号, 跳过';
        await log(msg);
        return { ok: false, message: msg };
      }
      const settings = await getSettings();
      const count = 100;
      const MAX_PAGES = 500; // 100/页 → 5万关注上限
      const all = [];
      let cursor = null;
      let page = 0;
      let retries = 0;
      let tidRetries = 0;
      let incomplete = false;
      await store.set(K.diffProgress, {
        handle, running: true, page: 0, maxPages: MAX_PAGES, users: 0, ts: Date.now(),
      });
      await log(`未回关名单发车: 页间节奏约 ${Math.round((AF.FOLLOWING_MIN_GAP_MS || 5_000) / 1000)} 秒/页`);
      while (page < MAX_PAGES) {
        await awaitFollowingGap();
        const res = await sendBg({
          cmd: 'route1-graphql', op: OP_FOLLOWING,
          vars: { count, cursor: cursor || null },
        });
        if (res && res.error) {
          // Following 供血稀: 池见底时提示开 /following 旁听, 并等冷却再试(搜索供血帮不上)
          const tidEmpty = /无同路径可用 tid|全在冷却/.test(String(res.error));
          if (tidEmpty && ++tidRetries <= 5) {
            const waitMs = AF.TID_COOLDOWN_MS || 70_000;
            await log(`未回关名单: Following tid 见底——请打开 https://x.com/${handle}/following 刷几下补 tid; ${Math.round(waitMs / 1000)}秒后重试第${page + 1}页(${tidRetries}/5)`);
            try {
              const cur = await store.get(K.diffProgress, null);
              if (cur && cur.running) await store.set(K.diffProgress, Object.assign({}, cur, { ts: Date.now() }));
            } catch {}
            await sleepSegments(waitMs);
            lastFollowingFireAt = 0; // 已等满冷却, 下一发不再叠页间 gap
            continue;
          }
          const msg = `未回关名单: Route 1 不可用(${res.error})——请先打开自己的 x.com/${handle}/following 页面并等它加载完(捕获模板), 再重新拉取`;
          await log('⚠ ' + msg);
          await store.set(K.diffProgress, { handle, running: false, error: msg, ts: Date.now() });
          return { ok: false, message: msg };
        }
        if (res.status === 429) {
          if (++retries > 3) {
            incomplete = true;
            await log('未回关名单: 拉取连续限流, 先保存已拉到的部分, 稍后重新拉取补全');
            break;
          }
          const backoff = rateLimitBackoffMs(interpret(res), Date.now(), settings.rateLimitBackoffMin * 60_000);
          await log(`未回关名单: 拉取限流, ${Math.round(backoff / 1000)}秒后重试第${page + 1}页`);
          await sleepSegments(backoff);
          lastFollowingFireAt = 0;
          continue;
        }
        retries = 0;
        tidRetries = 0;
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
        // 列表拉完后接口仍可能返回非空 cursor, 0 人即视为拉完
        if (!parsed.cursor || parsed.cursor === cursor || parsed.users.length === 0) break;
        cursor = parsed.cursor;
        page++;
      }
      if (page >= MAX_PAGES) incomplete = true;

      const seen = new Set();
      const users = all.filter((u) => (seen.has(u.userId) ? false : (seen.add(u.userId), true)));
      // 固定保护(@marsbuildlog 等): 进免取关; 未回关名单根本不写这些人
      await ensureAlwaysExempt(handle, users);
      const exempt = await store.get(K.diffExempt + ':' + handle, null);
      const exemptIds = new Set(((exempt && exempt.users) || []).map((x) => String(x.userId)).filter(Boolean));
      const skipNames = exemptScreenNameSet(exempt); // 含 DIFF_EXEMPT_ALWAYS
      const notBack = users
        .filter((u) => !u.followedBy)
        .filter((u) => {
          const sn = String(u.screenName || '').toLowerCase();
          return !exemptIds.has(String(u.userId)) && !skipNames.has(sn);
        })
        .map((u) => ({
          userId: u.userId, screenName: u.screenName, name: u.name,
          description: u.description || '',
          followersCount: u.followersCount, friendsCount: u.friendsCount,
        }));
      const exemptSkipped = users.filter((u) => !u.followedBy && (
        exemptIds.has(String(u.userId)) || skipNames.has(String(u.screenName || '').toLowerCase())
      )).length;
      await store.set(K.diff + ':' + handle, {
        handle, ts: Date.now(), total: users.length, notBackCount: notBack.length,
        incomplete: incomplete || undefined,
        users: notBack,
      });
      await store.set(K.diffProgress, { handle, running: false, ts: Date.now() });
      await log(
        `未回关名单更新${incomplete ? '(可能不全)' : ''}: 我关注${users.length}, 其中未回关${notBack.length}`
        + (exemptSkipped ? `(另有${exemptSkipped}人在免取关名单已跳过)` : '')
      );
      return {
        ok: true,
        message: `拉取完成: 我关注${users.length}, 未回关${notBack.length}` + (incomplete ? '(可能不全)' : ''),
      };
    } catch (e) {
      await store.set(K.diffProgress, { running: false, error: String(e), ts: Date.now() });
      await log(`未回关名单拉取失败: ${e}`);
      return { ok: false, message: String(e) };
    } finally {
      fetchingDiff = false;
    }
  }

  // ---------- 固定免取关账号(如 @marsbuildlog) ----------
  // 按 screen_name 写入当前登录号的 fb_diff_exempt; 拉取 Following 时若撞上则补全 userId/资料。
  function alwaysExemptHandles() {
    return (RF.DIFF_EXEMPT_ALWAYS || []).map((s) => String(s || '').replace(/^@/, '').trim().toLowerCase()).filter(Boolean);
  }
  function exemptScreenNameSet(exempt) {
    const names = new Set(alwaysExemptHandles());
    for (const u of (exempt && exempt.users) || []) {
      const sn = String(u.screenName || '').toLowerCase();
      if (sn) names.add(sn);
    }
    return names;
  }
  async function ensureAlwaysExempt(ownerHandle, followingUsers) {
    if (!ownerHandle) return null;
    const wants = alwaysExemptHandles();
    if (!wants.length) return null;
    const byName = new Map();
    for (const u of followingUsers || []) {
      const sn = String(u.screenName || '').toLowerCase();
      if (sn) byName.set(sn, u);
    }
    const ekey = K.diffExempt + ':' + ownerHandle;
    const exempt = await store.get(ekey, null);
    const users = ((exempt && exempt.users) || []).slice();
    let changed = false;
    for (const sn of wants) {
      const fromFollow = byName.get(sn);
      const idx = users.findIndex((u) => String(u.screenName || '').toLowerCase() === sn
        || (fromFollow && String(u.userId) && String(u.userId) === String(fromFollow.userId)));
      const prev = idx >= 0 ? users[idx] : null;
      const entry = {
        userId: (fromFollow && fromFollow.userId) || (prev && prev.userId) || '',
        screenName: (fromFollow && fromFollow.screenName) || (prev && prev.screenName) || sn,
        name: (fromFollow && fromFollow.name) || (prev && prev.name) || sn,
        description: (fromFollow && fromFollow.description) || (prev && prev.description) || '',
        followersCount: (fromFollow && fromFollow.followersCount) ?? (prev && prev.followersCount) ?? 0,
        friendsCount: (fromFollow && fromFollow.friendsCount) ?? (prev && prev.friendsCount) ?? 0,
        pinned: true,
        ts: (prev && prev.ts) || Date.now(),
      };
      if (idx >= 0) {
        const same = prev.pinned && String(prev.userId || '') === String(entry.userId || '')
          && String(prev.screenName || '') === String(entry.screenName || '')
          && String(prev.name || '') === String(entry.name || '');
        if (!same) { users[idx] = entry; changed = true; }
      } else {
        users.unshift(entry);
        changed = true;
      }
    }
    if (!changed) return exempt;
    const next = { handle: ownerHandle, users, ts: Date.now() };
    await store.set(ekey, next);
    return next;
  }

  // ---------- 未回关名单批量取关(Route 1 destroy) ----------
  // 按设置的关注间隔节奏逐个 destroy; 成功则从 fb_diff:{handle} 移除; 可随时停止。
  async function runDiffUnfollow() {
    if (unfollowingDiff) return { ok: false, message: '已在取关中, 请等本轮完成或先停止' };
    if (fetchingDiff) return { ok: false, message: '正在拉取名单, 请等拉取完成再取关' };
    unfollowingDiff = true;
    unfollowAbort = false;
    try {
      const handle = await activeHandle();
      if (!handle) {
        const msg = '批量取关: 未识别到登录账号';
        await log(msg);
        return { ok: false, message: msg };
      }
      await ensureAlwaysExempt(handle, null);
      const key = K.diff + ':' + handle;
      const diff = await store.get(key, null);
      const exempt = await store.get(K.diffExempt + ':' + handle, null);
      const exemptIds = new Set(((exempt && exempt.users) || []).map((x) => String(x.userId)).filter(Boolean));
      const exemptNames = exemptScreenNameSet(exempt);
      const queue = ((diff && diff.users) || []).filter((u) => u && u.userId
        && !exemptIds.has(String(u.userId))
        && !exemptNames.has(String(u.screenName || '').toLowerCase()));
      if (!queue.length) {
        return { ok: false, message: '名单为空——先拉取未回关名单(免取关名单中的人不会被取关)' };
      }
      const settings = await getSettings();
      const floor = AF.UNFOLLOW_GAP_FLOOR_S || 5;
      let gapMin = Math.max(floor, Math.round(+settings.unfollowIntervalMin) || RF.DEFAULTS.unfollowIntervalMin);
      let gapMax = Math.max(floor, Math.round(+settings.unfollowIntervalMax) || RF.DEFAULTS.unfollowIntervalMax);
      if (gapMin > gapMax) { const t = gapMin; gapMin = gapMax; gapMax = t; }
      const total = queue.length;
      let done = 0, okN = 0, failN = 0, skipN = 0;
      await store.set(K.diffUnfollowProgress, {
        handle, running: true, total, done: 0, ok: 0, fail: 0, skip: 0,
        current: null, ts: Date.now(),
      });
      await log(`批量取关发车: ${total} 人, 间隔 ${gapMin}~${gapMax} 秒随机`);

      for (const u of queue) {
        if (unfollowAbort) {
          await log(`批量取关已停止: 成功${okN}, 跳过${skipN}, 失败${failN}, 剩余${total - done}`);
          break;
        }
        const label = atName(u);
        if (exemptNames.has(String(u.screenName || '').toLowerCase()) || exemptIds.has(String(u.userId))) {
          skipN++;
          done++;
          await log(`批量取关: 跳过免取关 ${label}`);
          continue;
        }
        await store.set(K.diffUnfollowProgress, {
          handle, running: true, total, done, ok: okN, fail: failN, skip: skipN,
          current: u.screenName || u.userId, ts: Date.now(),
        });

        let attempts = 0;
        let finished = false;
        while (!finished && attempts < 4) {
          if (unfollowAbort) break;
          attempts++;
          try {
            const res = await unfollowUser(u.userId);
            const verdict = unfollowSucceeded(res);
            if (verdict.ok) {
              // 从名单移除(按最新 storage, 防与其它写交叉)
              const cur = await store.get(key, null);
              const users = ((cur && cur.users) || []).filter((x) => String(x.userId) !== String(u.userId));
              await store.set(key, Object.assign({}, cur || {}, {
                users, notBackCount: users.length, ts: (cur && cur.ts) || Date.now(),
              }));
              if (verdict.already) { skipN++; await log(`批量取关: ${label} 已不在关注中, 移出名单`); }
              else { okN++; await log(`批量取关: 已取关 ${label}`); }
              finished = true;
            } else if (verdict.rateLimited) {
              const coolMs = (settings.humanCooldownMin || 0) * 60_000;
              const backoff = rateLimitBackoffMs(interpret(res), Date.now(), settings.rateLimitBackoffMin * 60_000, 5000, coolMs);
              await log(`批量取关: 限流, ${Math.round(backoff / 1000)}秒后重试 ${label}`);
              await sleepSegments(backoff);
            } else {
              failN++;
              await log(`批量取关失败: ${label} — ${verdict.errorText || '未知'}`);
              finished = true;
            }
          } catch (e) {
            failN++;
            await log(`批量取关异常: ${label} — ${e}`);
            finished = true;
          }
        }
        if (!finished && !unfollowAbort) {
          failN++;
          await log(`批量取关放弃: ${label}(连续限流重试耗尽)`);
        }
        done++;
        await store.set(K.diffUnfollowProgress, {
          handle, running: true, total, done, ok: okN, fail: failN, skip: skipN,
          current: u.screenName || u.userId, ts: Date.now(),
        });
        if (unfollowAbort || done >= total) break;
        const gap = randInt(gapMin, gapMax) * 1000;
        await sleepSegments(gap);
      }

      const stopped = unfollowAbort;
      await store.set(K.diffUnfollowProgress, {
        handle, running: false, total, done, ok: okN, fail: failN, skip: skipN,
        finishedAt: Date.now(), ts: Date.now(),
        stopReason: stopped ? '用户停止' : undefined,
      });
      await log(`批量取关结束${stopped ? '(已停止)' : ''}: 成功${okN}, 跳过${skipN}, 失败${failN}`);
      return {
        ok: true,
        message: `取关结束: 成功${okN}, 跳过${skipN}, 失败${failN}` + (stopped ? '(已停止)' : ''),
      };
    } catch (e) {
      await store.set(K.diffUnfollowProgress, { running: false, error: String(e), ts: Date.now() });
      await log(`批量取关失败: ${e}`);
      return { ok: false, message: String(e) };
    } finally {
      unfollowingDiff = false;
      unfollowAbort = false;
    }
  }

  // ---------- 拉粉(Route 1) ----------
  // 进度字段与 content.js / 控制台 UI 对齐: {running, page, maxPages, users}
  function clampFetchFollowersMaxPages(raw) {
    const lo = RF.FETCH_FOLLOWERS_PAGES_MIN || 2;
    const hi = RF.FETCH_FOLLOWERS_PAGES_MAX || 1000;
    const n = Math.round(+raw);
    if (!Number.isFinite(n)) return RF.DEFAULTS.fetchFollowersMaxPages;
    return Math.max(lo, Math.min(hi, n));
  }
  async function runFetch(screenName) {
    if (fetchingFollowers) return { ok: false, message: '已在拉取中' };
    fetchingFollowers = true;
    try {
      // 计时起点: 手动/自动一视同仁, 成功失败都算(失败也等下一个周期再试, 避免连打)
      const t0 = await getTask(screenName);
      t0.lastFetchAt = Date.now();
      await saveTask(screenName, t0);

      let cursor = null;
      let page = 0;
      const settings = await getSettings();
      const MAX_PAGES = clampFetchFollowersMaxPages(settings.fetchFollowersMaxPages);
      const count = 100;
      const all = [];
      await store.set(K.fetchProgress, {
        running: true, screenName, page: 0, maxPages: MAX_PAGES, users: 0, updatedAt: Date.now(),
      });
      await log(`拉粉发车: 最多 ${MAX_PAGES} 页(空页/无游标提前停)`);
      while (page < MAX_PAGES) {
        const res = await sendBg({
          cmd: 'route1-graphql', op: OP_FOLLOWERS,
          vars: { count, screen_name: null, cursor: cursor || null },
        });
        if (res && res.error) {
          await log(`拉粉 Route 1 不可用(${res.error})——请打开认证粉丝页旁听模板`);
          return { ok: false, message: res.error };
        }
        if (res.status === 429) {
          const backoff = rateLimitBackoffMs(interpret(res), Date.now(), 15 * 60_000);
          await log(`拉粉限流, ${Math.round(backoff / 1000)}秒后重试`);
          await sleepSegments(backoff);
          continue;
        }
        const parsed = parseFollowers(res.body || '');
        if (parsed.error) {
          await log(`拉粉解析失败: ${parsed.error}`);
          return { ok: false, message: parsed.error };
        }
        all.push(...(parsed.users || []));
        await store.set(K.fetchProgress, {
          running: true, screenName,
          page: page + 1, maxPages: MAX_PAGES, users: all.length,
          hasMore: !!parsed.cursor, updatedAt: Date.now(),
        });
        await log(`拉取第${page + 1}页: +${(parsed.users || []).length}, 累计${all.length}, cursor=${parsed.cursor ? '有' : '无'}`);
        // 列表拉完后接口仍可能返回非空 cursor, 0 人即视为拉完(与 content.js 一致)
        if (!parsed.cursor || parsed.cursor === cursor || !(parsed.users || []).length) break;
        cursor = parsed.cursor;
        page++;
        await sleep(1200 + Math.random() * 800);
      }
      if (page >= MAX_PAGES) await log(`拉粉已达设置上限 ${MAX_PAGES} 页(可能还有更老的粉未拉)`);
      // 新粉在前 → 倒序后老粉先入队(等最久的先回关)
      const seen = new Set();
      const users = all
        .filter((u) => (seen.has(u.userId) ? false : (seen.add(u.userId), true)))
        .reverse();
      const t = await getTask(screenName);
      const added = mergeUsers(t, users);
      await saveTask(screenName, t);
      if (t.state === 'done' && t.queue.some((q) => q.status === 'pending')) {
        t.state = 'running';
        await saveTask(screenName, t);
        await log('拉到新粉, 回关自动续跑');
        runLoop(screenName);
      }
      await log(`拉取完成: 本轮${users.length}人, 新入队${added}`);
      return { ok: true, message: `拉取完成: +${added}` };
    } catch (e) {
      await log(`拉取异常: ${e}`);
      return { ok: false, message: String(e) };
    } finally {
      fetchingFollowers = false;
      await store.set(K.fetchProgress, null).catch(() => {});
    }
  }

  // ---------- 暂停 / 恢复 / 循环 ----------
  let runningHandle = null;
  let loopRunning = false;
  let loopWait = null;

  const PAUSE_ALERTS = {
    'template-expired': '回关模板已过期: 请在认证粉丝列表点一次「回关」, 然后点「恢复」',
    'daily-limit': '关注数已达上限(X 按 24 小时滚动窗口重置), 每小时自动探测重试',
    'stalled': '连续失败超过阈值, 稍后自动恢复',
    'error': '连续请求异常, 稍后自动恢复',
  };
  function notifyPause(reason) {
    try {
      const p = chrome.runtime.sendMessage({
        cmd: 'notify', tag: 'pause-' + reason, title: 'XFollowBack 已暂停',
        message: PAUSE_ALERTS[reason] || reason,
      });
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }
  async function setLoopWait(v) {
    loopWait = v;
    await store.set(K.loopWait, v || null).catch(() => {});
  }
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
    if (!screenName) return { ok: false, message: '缺少账号——请先完成身份识别' };
    const t0 = await getTask(screenName);
    if (t0.state === 'running') return { ok: false, message: '回关任务已在运行' };
    if (runningHandle) {
      t0.state = 'running'; t0.pauseReason = null; t0.nextAutoResumeAt = null; t0.lastError = null;
      await saveTask(screenName, t0);
      await setActive(screenName);
      await log('回关已登记运行(循环醒来后按回关优先接续)');
      return { ok: true, message: '已登记运行——循环醒来后自动接续(当前在限流等待)' };
    }
    const t = t0;
    const pendingCount = t.queue.filter((q) => q.status === 'pending').length;
    t.state = 'running'; t.pauseReason = null; t.nextAutoResumeAt = null; t.lastError = null;
    await saveTask(screenName, t);
    await setActive(screenName);
    await log(`任务启动: 总数${t.queue.length}, 待回关${pendingCount}`);
    if (pendingCount === 0 && !fetchingFollowers) runFetch(screenName);
    runLoop(screenName);
    return {
      ok: true,
      message: `总数${t.queue.length}, 待回关${pendingCount}` + (pendingCount === 0 ? '(已触发拉取, 拉到后自动续跑)' : ''),
      total: t.queue.length,
    };
  }

  async function startAfTask(handle) {
    if (!handle) return { ok: false, message: '未识别到登录账号——请先完成身份识别' };
    const t0 = await getAfTask(handle);
    if (t0.state === 'running') return { ok: false, message: '主动关注任务已在运行' };
    if (runningHandle) {
      t0.state = 'running'; t0.pauseReason = null; t0.nextAutoResumeAt = null; t0.lastError = null;
      await saveAfTask(handle, t0);
      await setActive(handle);
      await log('主动关注已登记运行(循环醒来后按回关优先接续)');
      return { ok: true, message: '已登记运行——循环醒来后自动接续(当前在限流等待)' };
    }
    const t = await getAfTask(handle);
    const pending = t.queue.filter((q) => q.status === 'pending').length;
    t.state = 'running'; t.pauseReason = null; t.nextAutoResumeAt = null; t.lastError = null;
    await saveAfTask(handle, t);
    await setActive(handle);
    await log(`主动关注启动: 待关注${pending}`);
    runLoop(handle);
    return { ok: true, message: pending > 0 ? `待关注${pending}, 已开始` : '队列暂空——先点「抓取互关帖」, 扫到人会自动开跑' };
  }

  async function runLoop(handle) {
    if (loopRunning || !handle) return;
    if (!(await acquireLock())) return;
    loopRunning = true;
    runningHandle = handle;
    await setLoopWait(null);
    const io = {
      fb: { get: getTask, save: saveTask },
      af: { get: getAfTask, save: saveAfTask },
    };
    try {
      let rateRetryUserId = null;
      let rateRetryCount = 0;
      let errorStreak = 0;
      while (true) {
        await refreshLock();
        {
          const afNow = await io.af.get(handle);
          if (afNow.state === 'running') {
            const pend = afNow.queue.filter((i) => i.status === 'pending').length;
            if (pend < AF.PENDING_TARGET) {
              const due = duePostAcrossTags(afNow.tags, Date.now(), AF.SCAN_MAX);
              if (due) await runAfScanOne(due.tag, handle);
            }
          }
        }
        let src, task, item;
        {
          const fb = await io.fb.get(handle);
          const af = await io.af.get(handle);
          if (fb.state !== 'running' && af.state !== 'running') break;
          const picked = pickNextItem(fb, af);
          if (!picked) {
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
        const settings = await getSettings();
        const floor = AF.FOLLOW_GAP_FLOOR_S || 5;
        let gapLo = Math.max(floor, Math.round(+settings.intervalMin) || RF.DEFAULTS.intervalMin);
        let gapHi = Math.max(floor, Math.round(+settings.intervalMax) || RF.DEFAULTS.intervalMax);
        if (gapLo > gapHi) { const t = gapLo; gapLo = gapHi; gapHi = t; }
        const delayMs = randInt(gapLo, gapHi) * 1000;
        if (!(await sleepInterruptible(delayMs, handle))) break;
        task = await io[src].get(handle);
        if (task.state !== 'running') break;
        if (!(await isLockMine())) break;
        const current = findPendingItem(task.queue, item.userId);
        if (!current) continue;
        let res;
        try {
          res = await followUser(current.userId);
        } catch (e) {
          errorStreak++;
          await log(`关注请求异常(${errorStreak}/2) ${atName(current)}: ${e}`);
          if (errorStreak >= 2) {
            await pauseTask(handle, 'error', Date.now() + settings.autoResumeMin * 60_000);
            break;
          }
          await sleep(5_000);
          continue;
        }
        const r = interpret(res);
        errorStreak = 0;
        if (r.ok) {
          rateRetryUserId = null;
          current.status = 'done';
          current.doneAt = Date.now();
          current.error = null;
          task.consecutiveFailures = [];
          await io[src].save(handle, task);
          const d = await getDaily(handle);
          d.followed++;
          await store.set(dailyKey(handle), d);
          await log(`已关注 ${atName(current)}${src === 'af' ? '(主动)' : ''}${res.via === 'page' ? '(页面重放)' : '(Route 1)'}, 今日 ${d.followed}`);
          const pw = windowExhaustedWaitMs(r, Date.now());
          if (pw > 0) {
            await setLoopWait({ until: Date.now() + pw, text: '窗口次数用完' });
            await log(`本窗口次数已用完(remaining=0), ${Math.round(pw / 1000)}秒后窗口重置自动继续`);
            if (!(await sleepInterruptible(pw, handle))) break;
            await setLoopWait(null);
          }
        } else if (r.rateLimited) {
          if (rateRetryUserId !== item.userId) { rateRetryUserId = item.userId; rateRetryCount = 1; }
          else rateRetryCount++;
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
          rateRetryUserId = null;
          current.status = 'skipped';
          current.error = r.errorText;
          await io[src].save(handle, task);
          await log(`跳过 ${atName(current)}(已关注/无法关注)`);
        } else {
          rateRetryUserId = null;
          current.status = 'failed';
          current.error = r.errorText;
          task.lastError = `${atName(current)}: ${r.errorText}`;
          if (r.followLimited) {
            await io[src].save(handle, task);
            await log(`关注数已达上限: ${settings.dailyLimitRetryMin}分钟后自动探测重试(直到额度恢复)`);
            await pauseTask(handle, 'daily-limit', Date.now() + settings.dailyLimitRetryMin * 60_000);
          } else if (res.status === 403) {
            await io[src].save(handle, task);
            await log(`模板过期(403) ${atName(current)}: 请在认证粉丝列表点一次「回关」刷新模板, 然后手动恢复`);
            await pauseTask(handle, 'template-expired');
          } else {
            task.consecutiveFailures.push(Date.now());
            const stall = evaluateStall(task.consecutiveFailures, Date.now(), settings.stallMin * 60_000, settings.stallMin * 60_000);
            task.consecutiveFailures = stall.kept;
            await io[src].save(handle, task);
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

  // ---------- 自动 tick(定时补拉 / 补池 / 自动恢复) ----------
  async function autoTick() {
    const handle = await activeHandle();
    if (!handle) return;
    if (fetchingFollowers || afSearching || afScanning || afBurstScanning) return;
    const settings = await getSettings();
    const af = await getAfTask(handle);
    const fb = await getTask(handle);

    // 定时自动补拉回关列表: 控制台宿主跑(ADR-0010), 与手动「更新列表」同路径;
    // 距上次拉取超 autoFetchMin 即发车(成功失败都已在 runFetch 入口重计时)
    const autoMin = +settings.autoFetchMin || RF.DEFAULTS.autoFetchMin;
    if (!fb.lastFetchAt || Date.now() - fb.lastFetchAt >= autoMin * 60_000) {
      if (await acquireLock()) {
        await log(`定时自动补拉认证粉丝列表(间隔 ${autoMin} 分钟)`);
        runFetch(handle).catch((e) => log(`自动补拉异常: ${e}`));
        return;
      }
    }

    const autoTag = nextAutoSearchTag(settings.tags, af.lastAutoSearchTag);
    if (autoTag && shouldAutoSearch(af, Date.now(), {
      pendingTarget: AF.PENDING_TARGET, scanMax: AF.SCAN_MAX, poolMin: AF.POOL_MIN, cooldownMs: AF.AUTO_SEARCH_COOLDOWN_MS,
    })) {
      if (await acquireLock()) {
        await log(`池子断供自动补池: 待关注低于水位${AF.PENDING_TARGET}且池子供给不足, 自动抓取 #${autoTag}`);
        runAfSearch(String(autoTag).replace(/^#/, '').trim(), handle).catch((e) => log(`自动补池异常: ${e}`));
      }
    }
    const now = Date.now();
    for (const t of [fb, af]) {
      if (t.state === 'paused' && t.nextAutoResumeAt && now >= t.nextAutoResumeAt) {
        if (await acquireLock()) resumeTask(handle);
        break;
      }
    }
    if ((fb.state === 'running' || af.state === 'running') && !loopRunning) {
      if (await acquireLock()) runLoop(handle);
    }
  }

  // ---------- 心跳 + 对外 API ----------
  let hbTimer = null;
  let tickTimer = null;
  let port = null;

  function startHeartbeat() {
    const beat = () => store.set(K.consoleHost, { at: Date.now() });
    beat();
    clearInterval(hbTimer);
    hbTimer = setInterval(beat, 3_000);
    try {
      port = chrome.runtime.connect({ name: 'console-host' });
      port.onDisconnect.addListener(() => { port = null; });
    } catch {}
    window.addEventListener('beforeunload', () => {
      try { chrome.storage.local.set({ [K.consoleHost]: { at: 0 } }); } catch {}
    });
  }

  async function dispatch(cmd, extra) {
    const h = await activeHandle();
    switch (cmd) {
      case 'start-task':
        if (!h) return { ok: false, message: '未识别到登录账号——点就绪清单打开 x.com 完成识别' };
        return startTask(h);
      case 'start-af-task':
        if (!h) return { ok: false, message: '未识别到登录账号——点就绪清单打开 x.com 完成识别' };
        return startAfTask(h);
      case 'pause-task':
        if (!h) return { ok: false, message: '未识别到登录账号' };
        await pauseTask(h, 'manual');
        return { ok: true, message: '已暂停' };
      case 'resume-task':
        if (!h) return { ok: false, message: '未识别到登录账号' };
        await resumeTask(h);
        return { ok: true, message: '已恢复' };
      case 'af-search': {
        if (afSearching) return { ok: false, message: '已在搜索中, 等本轮跑完' };
        if (afBurstScanning) return { ok: false, message: '正在连扫帖子, 等本轮跑完再抓取' };
        if (!h) return { ok: false, message: '未识别到登录账号' };
        const tags = ((await getSettings()).tags) || [];
        const norm = (t) => String(t || '').replace(/^#/, '').trim().toLowerCase();
        const want = norm(extra && extra.tag);
        const tag = tags.find((t) => norm(t) === want) || (tags.length === 1 ? tags[0] : null);
        const tagStr = tag ? String(tag).replace(/^#/, '').trim() : null;
        if (!tagStr) {
          return { ok: false, message: want ? `#${want} 不在配置的互关标签里——先在设置里添加` : '未指定标签——先在设置里配置互关标签' };
        }
        runAfSearch(tagStr, h).catch((e) => log(`抓取异常: ${e}`));
        return { ok: true, message: '搜索已发车——进度见控制台状态行与日志' };
      }
      case 'af-scan':
        if (!h) return { ok: false, message: '未识别到登录账号' };
        return runAfScanBurst(h);
      case 'refresh-list':
        if (!h) return { ok: false, message: '未识别到登录账号' };
        return runFetch(h);
      case 'diff-fetch':
        // fire-and-forget(可达数分钟); 进度 fb_diff_progress + 日志
        if (fetchingDiff) return { ok: false, message: '已在拉取中, 请等本轮完成' };
        if (unfollowingDiff) return { ok: false, message: '正在批量取关, 请先停止或等结束再拉取' };
        if (!h) return { ok: false, message: '未识别到登录账号——点就绪清单打开 x.com 完成识别' };
        runDiffFetch().catch((e) => log(`未回关名单拉取异常: ${e}`));
        return { ok: true, message: '拉取已发车——进度见未回关名单状态行与日志(约5秒/页, 非卡住)' };
      case 'diff-unfollow':
        if (unfollowingDiff) return { ok: false, message: '已在取关中, 请等本轮完成或先停止' };
        if (fetchingDiff) return { ok: false, message: '正在拉取名单, 请等拉取完成再取关' };
        if (!h) return { ok: false, message: '未识别到登录账号——点就绪清单打开 x.com 完成识别' };
        runDiffUnfollow().catch((e) => log(`批量取关异常: ${e}`));
        return { ok: true, message: '批量取关已发车——进度见未回关名单状态行与日志(间隔见设置)' };
      case 'diff-unfollow-stop':
        if (!unfollowingDiff) return { ok: false, message: '当前没有在跑的批量取关' };
        unfollowAbort = true;
        return { ok: true, message: '已请求停止——当前这个人结束后停下' };
      case 'reset-task':
        if (!h) return { ok: false, message: '无活跃账号' };
        await store.set(taskKey(h), null);
        return { ok: true, message: '已重置' };
      default:
        return { ok: false, message: 'unknown cmd: ' + cmd };
    }
  }

  // 扩展重载/控制台重启后内存闸门已空, 但 storage 里 running 可能仍为 true → 按钮长期灰掉。
  // 启动时清掉抓取/连扫/拉粉进行中标志(15 分钟陈旧兜底仍保留在 options UI)。
  async function clearInterruptedProgress() {
    const now = Date.now();
    try {
      const snap = await chrome.storage.local.get([
        K.afProgress, K.afScanProgress, K.fetchProgress, K.diffProgress, K.diffUnfollowProgress,
      ]);
      const patch = {};
      const afp = snap[K.afProgress];
      if (afp && afp.running) {
        patch[K.afProgress] = Object.assign({}, afp, {
          running: false, finishedAt: now, updatedAt: now, stopReason: '宿主重启/重载中断',
        });
      }
      const afsp = snap[K.afScanProgress];
      if (afsp && afsp.running) {
        patch[K.afScanProgress] = Object.assign({}, afsp, {
          running: false, finishedAt: now, updatedAt: now, stopReason: '宿主重启/重载中断',
        });
      }
      if (snap[K.fetchProgress] && snap[K.fetchProgress].running) {
        patch[K.fetchProgress] = null;
      }
      const diffp = snap[K.diffProgress];
      if (diffp && diffp.running) {
        patch[K.diffProgress] = Object.assign({}, diffp, {
          running: false, ts: now, stopReason: '宿主重启/重载中断',
        });
      }
      const difu = snap[K.diffUnfollowProgress];
      if (difu && difu.running) {
        patch[K.diffUnfollowProgress] = Object.assign({}, difu, {
          running: false, finishedAt: now, ts: now, stopReason: '宿主重启/重载中断',
        });
      }
      if (Object.keys(patch).length) {
        await chrome.storage.local.set(patch);
        await log('已清除重载前未结束的进度标志(抓取/连扫/拉粉/未回关名单/批量取关), 按钮可再点');
      }
    } catch {}
  }

  function boot() {
    startHeartbeat();
    clearInterruptedProgress().catch(() => {});
    clearInterval(tickTimer);
    tickTimer = setInterval(() => { autoTick().catch(() => {}); }, 30_000);
    autoTick().catch(() => {});
    // 识别到账号后立刻把固定免取关(@marsbuildlog 等)写入名单
    activeHandle().then((h) => { if (h) ensureAlwaysExempt(h, null).catch(() => {}); }).catch(() => {});
    // 浮层/其它页把任务标成 running 时尽快接手, 不必干等 30s tick
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[K.active] && changes[K.active].newValue) {
        ensureAlwaysExempt(changes[K.active].newValue, null).catch(() => {});
      }
      const hit = Object.keys(changes).some((k) =>
        k.startsWith(K.task + ':') || k.startsWith(K.afTask + ':'));
      if (hit) autoTick().catch(() => {});
    });
  }

  globalThis.RFHost = { boot, dispatch, startHeartbeat, activeHandle, findXTab };
})();
