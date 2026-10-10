// 池子自动供血(ADR-0004 遗留B)纯逻辑: 何时收割 + 收割 URL。
// 原理: 池见底时开一个后台搜索页签, 页面自己发的 SearchTimeline 被 webRequest 旁听,
// tid 连路径标签入库; 数发加载攒 2~4 条, 70s 冷却后即可轮换。IO(chrome.tabs)在 background 装配。
(function () {
  const ROUNDS = 3;           // 一次供血的加载次数(首载+重载), 每轮等真入库再翻页, 期望攒 2~4 条同路径 tid
  const POLL_INTERVAL_MS = 1000;
  const POLL_MAX_MS = 8000;   // 每轮等入库上限: x.com 后台页签整页加载要 5~9s 才发搜索请求, 盲等 4s 会扑空(实测)
  const MIN_GAP_MS = 90_000;  // 两次供血最小间隔(防页签风暴; 冷却 70s, 90s 间隔正好衔接)

  // state = {running, lastAt}: 只有"没在跑 且 (从未跑过 或 距上次供血够久)"才跑(lastAt 持久化, SW 重启也不风暴)
  function shouldRun(state, now) {
    if (!state || state.running) return false;
    if (state.lastAt == null) return true; // 从没跑过
    return now - state.lastAt >= MIN_GAP_MS;
  }

  // 收割 URL: 第一个已配置互关标签的 live 搜索(整页加载必发 SearchTimeline); 没配标签退化成通用词
  function searchUrl(tags) {
    const t = (tags && tags.length ? String(tags[0]) : 'x').replace(/^#/, '').trim() || 'x';
    return 'https://x.com/search?q=' + encodeURIComponent('#' + t) + '&f=live';
  }

  globalThis.RFHarvest = { ROUNDS, POLL_INTERVAL_MS, POLL_MAX_MS, MIN_GAP_MS, shouldRun, searchUrl };
})();
