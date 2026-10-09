// 纯逻辑函数集合: content script / page-hook / 单元测试三方共用。
// 内容脚本不支持 ES Modules, 因此用经典脚本 + globalThis 挂载的模式。
// ⚠ 修改本文件后运行 `npm test`(仓库根目录), 全绿再重载插件。
(() => {
  'use strict';

  function localDateStr(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // 每日计数跨天归零
  function rolloverDaily(daily, now = new Date()) {
    const today = localDateStr(now);
    return daily && daily.date === today ? daily : { date: today, followed: 0 };
  }

  // 展示名: screenName 缺失时退回 userId, 避免 @undefined
  const atName = (item) => '@' + (item && (item.screenName || item.userId));

  // GraphQL 响应 → 用户列表 + 翻页游标。
  // 兼容多代字段结构:
  //   身份: legacy.* → core.user_legacy.* → core.*
  //   关注状态: relationship_perspectives.following(实测) → legacy.following → 顶层 following
  function parseFollowers(body) {
    const out = { users: [], cursor: null, error: null, firstRaw: null, followFields: null };
    let data;
    try { data = JSON.parse(body); } catch { out.error = '响应不是 JSON: ' + String(body).slice(0, 300); return out; }
    if (data.errors) { out.error = JSON.stringify(data.errors).slice(0, 500); return out; }
    const instructions =
      data?.data?.user?.result?.timeline?.timeline?.instructions ||
      data?.data?.user?.result?.verified_followers_timeline?.timeline?.instructions || [];
    if (!instructions.length) {
      out.error = '响应结构无法解析(可能接口已变), 原始片段: ' + String(body).slice(0, 300);
      return out;
    }
    for (const ins of instructions) {
      for (const e of ins.entries || []) {
        const id = e.entryId || '';
        if (id.startsWith('user-')) {
          const r = e.content?.itemContent?.user_results?.result;
          if (!r) continue;
          if (!out.firstRaw) {
            out.firstRaw = JSON.stringify(r).slice(0, 4000);
            // 单独抽出关注关系相关字段(含值), 便于诊断字段位置变化
            const ff = {};
            for (const k of Object.keys(r)) if (/follow|relationship/i.test(k)) ff[k] = r[k];
            if (r.legacy && typeof r.legacy === 'object') {
              for (const k of Object.keys(r.legacy)) if (/follow/i.test(k)) ff['legacy.' + k] = r.legacy[k];
            }
            out.followFields = JSON.stringify(ff).slice(0, 800);
          }
          const legacy = r.legacy || r.core?.user_legacy || {};
          const screenName = legacy.screen_name || r.core?.screen_name || '';
          const name = legacy.name || r.core?.name || '';
          const rel = r.relationship_perspectives || {};
          const following = rel.following ?? legacy.following ?? r.following ?? false;
          out.users.push({
            userId: r.rest_id || r.core?.id_str,
            screenName,
            name,
            following: !!following,
            followedBy: !!(rel.followed_by ?? legacy.followed_by),
            blue: !!r.is_blue_verified,
          });
        } else if (id.startsWith('cursor-bottom')) {
          out.cursor = e.content?.value ?? out.cursor;
        }
      }
    }
    return out;
  }

  // 解释关注/查询接口返回, 归类错误(驱动限流退避/暂停决策)
  // res.rl: 响应头限流信息 {limit, remaining, reset}(reset 为 UTC epoch 秒), 由 page-hook 重放时提取
  function interpret(res) {
    const out = { ok: false, rateLimited: false, followLimited: false, errorText: `HTTP ${res.status}` };
    const rl = res && res.rl;
    if (rl && Number.isFinite(rl.reset)) {
      out.rateReset = rl.reset; // 窗口重置时刻(epoch 秒)
      if (Number.isFinite(rl.remaining)) out.rateRemaining = rl.remaining;
    }
    if (res.status === 429) {
      out.rateLimited = true;
      out.errorText = '429 Rate limit exceeded';
      return out;
    }
    let data = null;
    try { data = JSON.parse(res.body); } catch {}
    const bodyText = res.body || '';
    if (res.status === 403) {
      // 实测: 161(单日关注上限)等业务错误会包在 HTTP 403 里返回,
      // 必须先解析错误码, 否则会误判为模板过期
      const errs403 = data && data.errors;
      if (Array.isArray(errs403) && errs403.length) {
        if (errs403.some((e) => e.code === 161)) {
          out.followLimited = true;
          out.errorText = '今日关注已超过上限(161), 明日 00:05 自动恢复';
          return out;
        }
        out.errorText = errs403.map((e) => `${e.code} ${e.message}`).join('; ').slice(0, 200);
        if (errs403.some((e) => e.code === 88 || /rate limit/i.test(e.message || ''))) out.rateLimited = true;
        return out;
      }
      out.errorText = '403 (大概率是回关请求模板已过期——在认证粉丝列表里点一次「回关」即可刷新) ' + String(res.body || '').slice(0, 150);
      return out;
    }
    // 已关注/重复关注视为成功(幂等)
    if (/already|已经关注/i.test(bodyText.slice(0, 2000))) { out.ok = true; return out; }
    const errs = data && data.errors;
    if (Array.isArray(errs) && errs.length) {
      out.errorText = errs.map((e) => `${e.code} ${e.message}`).join('; ');
      if (errs.some((e) => e.code === 88 || /rate limit/i.test(e.message || ''))) out.rateLimited = true;
      if (errs.some((e) => e.code === 161)) out.followLimited = true; // 无法关注更多人(达到关注上限)
      return out;
    }
    if (res.ok) out.ok = true;
    else out.errorText = `HTTP ${res.status} ${String(res.body || '').slice(0, 200)}`;
    return out;
  }

  // 429 后应等待的毫秒数: 优先按响应头 x-rate-limit-reset 精确等到窗口重置(+缓冲),
  // 无响应头时退回固定退避(fallbackMs)。上限 20 分钟防异常值; reset 已过则不等待。
  function rateLimitBackoffMs(r, now, fallbackMs, bufMs = 5000) {
    if (r && Number.isFinite(r.rateReset)) {
      const wait = r.rateReset * 1000 + bufMs - now;
      if (wait <= 0) return 0;
      return Math.min(wait, 20 * 60_000);
    }
    return fallbackMs;
  }

  // 主动限流: 未 429 但窗口次数耗尽(remaining=0)时, 也等到 reset 再发下一个, 避免吃 429
  function windowExhaustedWaitMs(r, now, bufMs = 5000) {
    if (r && r.rateRemaining === 0 && Number.isFinite(r.rateReset)) {
      return Math.max(0, Math.min(r.rateReset * 1000 + bufMs - now, 20 * 60_000));
    }
    return 0;
  }

  // 队列合并: 新人追加, 已关注(u.following, 来自列表自带 relationship_perspectives.following)标 skipped; 返回新增数。
  // 幂等: 队列里已有的 userId 不会重复添加, 已有状态不受影响。
  function mergeUsers(t, users) {
    const existing = new Set(t.queue.map((q) => q.userId));
    let added = 0;
    for (const u of users) {
      if (existing.has(u.userId)) continue;
      t.queue.push({
        userId: u.userId, screenName: u.screenName, name: u.name,
        status: u.following ? 'skipped' : 'pending', // 已关注直接跳过
        error: null,
      });
      added++;
    }
    return added;
  }

  // 重读任务后按 userId 重新定位 pending 项。
  // ⚠ 任务循环重读 task 后旧对象引用失效, 必须用它重新定位,
  //   否则状态标在旧快照上会导致重复关注同一人(已发生过的 bug)。
  function findPendingItem(queue, userId) {
    const item = queue.find((i) => i.userId === userId);
    return item && item.status === 'pending' ? item : null;
  }

  // 连续失败窗口评估: 先剪掉窗口外的失败, 窗口内最早失败距今超过 stallMs → 应暂停
  function evaluateStall(failures, now, windowMs, stallMs) {
    const kept = failures.filter((ts) => ts >= now - windowMs);
    const shouldPause = kept.length > 0 && now - kept[0] >= stallMs;
    return { kept, shouldPause };
  }

  // v1.1 REST 重放请求构造(纯函数; csrf 由调用方从当前会话注入)。
  // form 类 body 仅替换指定参数; 替换 user_id 时删除 screen_name 避免冲突。
  function buildApiRequest(entry, params, csrf) {
    const init = { method: entry.method, credentials: 'include', headers: { ...entry.headers } };
    let url = entry.url;
    if (csrf) init.headers['x-csrf-token'] = csrf;
    if (entry.method === 'GET') {
      const p = new URLSearchParams(entry.search);
      for (const [k, v] of Object.entries(params || {})) p.set(k, v);
      url += '?' + p.toString();
    } else {
      const ct = (entry.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/json')) {
        let obj = {};
        try { obj = JSON.parse(entry.body || '{}'); } catch {}
        Object.assign(obj, params || {});
        init.body = JSON.stringify(obj);
      } else {
        const bp = new URLSearchParams(entry.body || '');
        for (const [k, v] of Object.entries(params || {})) {
          bp.set(k, v);
          if (k === 'user_id') bp.delete('screen_name');
        }
        init.body = bp.toString();
        init.headers['content-type'] = init.headers['content-type'] || 'application/x-www-form-urlencoded';
      }
    }
    return { url, init };
  }

  globalThis.RefollowLogic = {
    localDateStr, rolloverDaily, atName, parseFollowers, interpret,
    mergeUsers, findPendingItem, evaluateStall, buildApiRequest,
    rateLimitBackoffMs, windowExhaustedWaitMs,
  };
})();
