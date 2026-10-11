// 全局常量: options 页(<script> 标签)与 content.js(动态 import)共用。
// 挂在 globalThis 上: content.js 会用 await import() 显式加载本文件并等待挂载完成。
const RF = {
  KEY: {
    settings: 'rf_settings',
    daily: 'rf_daily',   // 前缀, 实际键 rf_daily:{handle}(按账号分键)
    task: 'rf_task',     // 前缀, 实际键 rf_task:{handle}(按账号分键, 回关任务)
    afTask: 'rf_af_task', // 前缀, 实际键 rf_af_task:{handle}(主动关注任务: 队列+互关帖池)
    lock: 'rf_lock',
    log: 'rf_log',
    tidPool: 'rf_tid_pool', // tid 收割池(webRequest 被动收集, ADR-0004)
    gqlTpl: 'rf_tpl',    // 前缀, 实际键 rf_tpl:<op> —— GraphQL 直连模板(Route 1 运输材料)
    bearer: 'rf_bearer', // 页面 authorization 头(Route 1 直连传输用, bearer 是常量)
    fetchProgress: 'rf_fetch_progress',
    afProgress: 'rf_af_progress', // 主动关注搜索进度(面板展示用)
    active: 'rf_active', // 最近活跃账号(options/popup 无页面上下文时定位任务)
    loopWait: 'rf_loop_wait', // 循环等待状态落盘(限流重试/窗口用完): 控制台总览可见"系统在等, 不是死了"
  },
  // x.com 前端 JS 内置的公共 bearer(非用户专属, 多年未变, 开源生态普遍内置)。
  // 身份探针(ADR-0005)在收割到动态 bearer 之前兑底; 收割值始终优先。
  publicBearer: 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUro16cIUTA',
  DEFAULTS: {
    intervalMin: 3,       // 关注间隔随机区间下限(秒)
    intervalMax: 8,       // 关注间隔随机区间上限(秒)
    stallMin: 30,         // 持续失败多少分钟判定为限流并暂停
    autoResumeMin: 60,    // 暂停后每隔多少分钟自动尝试恢复
    dailyLimitRetryMin: 60, // 关注上限(161)后每隔多少分钟自动探测重试(X 按 24h 滚动窗口重置, 与本地 0 点无关)
    rateLimitBackoffMin: 15, // 命中 429/88 时的单次长退避(分钟)
    autoFetchMin: 30,     // 自动拉取认证粉丝间隔(分钟, 手动拉取后重新计时)
    tags: [],             // 互关标签列表(Options 页维护; 打开对应标签页才启用主动关注抓取)
  },
  // 主动关注(蓝V互关)业务参数——产品决策全部写死为常量, 不进配置页(ADR-0001 语境)
  AF: {
    SEARCH_MAX_PAGES: 4,     // 搜索阶段每轮最多翻页数(2026-10-10 用户决策: 10→4, 每轮更轻; tid 池轮换后单轮耗时会随池子深度自动缩短)
    SEARCH_PAGE_SIZE: 20,    // 搜索每页条数——必须是 20: SearchTimeline 实测 count≠20 直接 404(2026-10-10 对照实验: 21/40/100 均 404)
    QUEUE_CAP: 10000,        // 主动关注队列容量上限(满了暂停入队)
    RATIO_MAX: 1.2,          // 求粉特征阈值: 粉丝数/关注数 < 1.2 才入队
    SCAN_MAX: 3,             // 每帖最多扫描次数(帖子生命周期短, 三次后不再有新回复者)
    SCAN_INTERVAL_MS: 2 * 24 * 60 * 60 * 1000, // 重扫间隔: 隔两天
    SCAN_MAX_PAGES: 100,     // 单帖单次扫描回复的最大翻页数(首扫把回复跑完)
    SCAN_RETRY_MS: 30 * 60 * 1000, // 扫描被限流中断后, 该帖隔半小时重试(不消耗扫描次数)
    // 同一 x-client-transaction-id 的成功有约60秒冷却(2026-10-10 实测: 成功后1秒重放→404, 68秒后→200;
    // 冷却期内同tid任何请求都被拒, 字节相同也一样; 失败不延长冷却; cursor可复用/键序无关)。
    // tid 收割池(ADR-0004)让连发成为可能, 但限流桶不变: 两次 SearchTimeline 发射至少隔 SEARCH_MIN_GAP_MS。
    TID_COOLDOWN_MS: 70 * 1000,
    SEARCH_MIN_GAP_MS: 30 * 1000, // 搜索/扫描发射节奏兼底: 50次/15分钟桶 ≈ 18s/发, 30s/发给页面自己的搜索留余量
  },
};
globalThis.RF = RF;
