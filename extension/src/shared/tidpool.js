// tid 收割池: 浏览器级收集与轮换页面自己产生的 x-client-transaction-id(ADR-0004)。
// 纯逻辑, background(SW 收割)/content(取用)/测试三方共用, 挂 globalThis.RFTidPool。
// 规则(ADR-0002/0004): 同 tid 成功后约 60 秒冷却, 冷却期内任何请求 404; 失败不延长冷却;
//   GraphQL 生产只取同路径。跨路径不对称(2026-10-19: Search→Detail 200, Detail→Search 404),
//   禁止无向兑底; pickCrossPath / allowCrossPath 仅调试闸门用。
(function () {
  const CAP = 512; // 全池上限(多路径合计兜底)
  const CAP_PER_PATH = 30; // 同路径最多保留条数; 多了淘汰更早加入的(池内最新在前)

  // 只收 Route 1 会按路径取用的 op / 回关 REST。首页 timeline、avatar_content、viewer_context
  // 等噪声刷屏会挤掉真库存。
  const HARVEST_GQL_OPS = new Set([
    'SearchTimeline', 'TweetDetail', 'BlueVerifiedFollowers', 'Following', 'UserByScreenName',
  ]);
  function shouldHarvest(path) {
    if (!path) return false;
    if (path.startsWith('/i/api/graphql/')) {
      const op = path.split('/').pop();
      return HARVEST_GQL_OPS.has(op);
    }
    return path === '/i/api/1.1/friendships/create.json';
  }
  // 池最新在前: 同路径保留前 CAP_PER_PATH 条(最新), 更早加入的直接丢掉
  function trimPerPath(pool, perPath) {
    const limit = perPath || CAP_PER_PATH;
    const counts = Object.create(null);
    const out = [];
    for (const e of pool || []) {
      const p = e.p || '';
      const n = counts[p] || 0;
      if (n >= limit) continue;
      counts[p] = n + 1;
      out.push(e);
    }
    return out;
  }
  function prune(pool) {
    return trimPerPath((pool || []).filter((e) => shouldHarvest(e.p)), CAP_PER_PATH).slice(0, CAP);
  }

  // 收割入库: 形状 sanity(实测 94 字符); 同 tid+路径只刷新时间戳; 最新在前;
  // 同路径超 CAP_PER_PATH 淘汰更早的; 顺手丢掉非白名单旧条目。
  function add(pool, tid, path, now) {
    const base = prune(pool);
    if (!tid || tid.length < 60 || !shouldHarvest(path)) return base;
    const rest = base.filter((e) => !(e.t === tid && e.p === path));
    rest.unshift({ t: tid, p: path || '', at: now });
    return trimPerPath(rest, CAP_PER_PATH).slice(0, CAP);
  }

  // 取异路径可用 tid(仅调试对照 / 显式 allowCrossPath): p !== notPath 且冷却已过。
  function pickCrossPath(pool, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const cd = o.cooldownMs || 70000;
    const notPath = o.notPath || '';
    const usable = (e) => now - Math.max(e.at, e.ok || 0) >= cd;
    const cross = (pool || []).filter((e) => e.p && e.p !== notPath && usable(e));
    return cross.length ? cross[0] : null;
  }

  // 取可用 tid: 默认只同路径。allowCrossPath:true 时才兑底异路径(调试用; 生产勿开——跨路径不对称)。
  // 冷却基准 = max(捕获时刻 at, 我们上次成功时刻 ok)。
  // 返回条目含原捕获路径 p——markResult 必须用 e.p。
  function pick(pool, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const cd = o.cooldownMs || 70000;
    const path = o.path || '';
    const usable = (e) => now - Math.max(e.at, e.ok || 0) >= cd;
    const same = (pool || []).filter((e) => e.p === path && usable(e));
    if (same.length) return same[0];
    if (!o.allowCrossPath) return null;
    return pickCrossPath(pool, { notPath: path, now, cooldownMs: cd });
  }

  // 写回结果: 成功记 ok(进入冷却); 失败不动 ok(失败不延长冷却, ADR-0002), 只记 fail 供排查
  function markResult(pool, tid, path, ok, now) {
    return (pool || []).map((e) =>
      e.t === tid && e.p === path ? Object.assign({}, e, ok ? { ok: now } : { fail: now }) : e
    );
  }

  globalThis.RFTidPool = {
    add, pick, pickCrossPath, markResult, prune, trimPerPath, shouldHarvest,
    CAP, CAP_PER_PATH, HARVEST_GQL_OPS,
  };
})();
