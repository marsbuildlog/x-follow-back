// tid 收割池: 浏览器级收集与轮换页面自己产生的 x-client-transaction-id(ADR-0004)。
// 纯逻辑, background(SW 收割)/content(取用)/测试三方共用, 挂 globalThis.RFTidPool。
// 规则(ADR-0002/0004): 同 tid 成功后约 60 秒冷却, 冷却期内任何请求 404; 失败不延长冷却;
//   tid 不绑定 URL, 同路径跨查询可复用; 跨路径未证实(生成时哈希了 method+path), 池子默认只取同路径。
(function () {
  const CAP = 64; // 池容量: 只留最近的(tid 存活实测 ≥1h, 上限未知, 过期条目无价值)

  // 收割入库: 形状 sanity(实测 94 字符); 同 tid+路径只刷新时间戳; 最新在前, 超容截断
  function add(pool, tid, path, now) {
    if (!tid || tid.length < 60) return pool || [];
    const rest = (pool || []).filter((e) => !(e.t === tid && e.p === path));
    rest.unshift({ t: tid, p: path || '', at: now });
    return rest.slice(0, CAP);
  }

  // 取一个可用 tid(同路径且冷却已过), 最新在前; 没有则返回 null(调用方回退捕获 tid + 等冷却)。
  // 冷却基准 = max(捕获时刻 at, 我们上次成功时刻 ok): 收割到它说明页面刚用过(进入冷却),
  // 但页面那次成功与否无从得知, 保守从捕获时刻起算。
  function pick(pool, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const cd = o.cooldownMs || 70000;
    const path = o.path || '';
    const usable = (e) => now - Math.max(e.at, e.ok || 0) >= cd;
    const same = (pool || []).filter((e) => e.p === path && usable(e));
    return same.length ? same[0] : null;
  }

  // 写回结果: 成功记 ok(进入冷却); 失败不动 ok(失败不延长冷却, ADR-0002), 只记 fail 供排查
  function markResult(pool, tid, path, ok, now) {
    return (pool || []).map((e) =>
      e.t === tid && e.p === path ? Object.assign({}, e, ok ? { ok: now } : { fail: now }) : e
    );
  }

  globalThis.RFTidPool = { add, pick, markResult, CAP };
})();
