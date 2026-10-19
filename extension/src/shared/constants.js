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
    diff: 'fb_diff',       // 前缀, 实际键 fb_diff:{handle}(未回关名单: 我关注但对方没关注我)
    diffProgress: 'fb_diff_progress', // 未回关名单拉取进度(面板展示用)
    afProgress: 'rf_af_progress', // 主动关注搜索进度(面板展示用)
    afScanProgress: 'rf_af_scan_progress', // 主动关注手动连扫进度(面板展示用)
    active: 'rf_active', // 最近活跃账号(options/popup 无页面上下文时定位任务)
    loopWait: 'rf_loop_wait', // 循环等待状态落盘(限流重试/窗口用完): 控制台总览可见"系统在等, 不是死了"
    consoleHost: 'rf_console_host', // 控制台宿主心跳(ADR-0010): { at }; 约 15s 内有更新视为在线
    followTplSeen: 'rf_follow_tpl_seen', // 旁听到 create.json 的时刻(兑底材料就绪提示用)
  },
  // 控制台心跳新鲜窗口(与领导权锁 15s 同量级)
  CONSOLE_HOST_FRESH_MS: 15_000,
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
    humanCooldownMin: 1,  // 人为冷却(分钟, 0–10): 关注循环 429/88 且有 reset 头时, 在重置时刻上再叠加 max(5s, 该值); 0=不加
    autoFetchMin: 30,     // 自动拉取认证粉丝间隔(分钟, 手动拉取后重新计时)
    tags: [],             // 互关标签列表(Options 页维护; 打开对应标签页才启用主动关注抓取)
  },
  // 主动关注(蓝V互关)业务参数——产品决策全部写死为常量, 不进配置页(ADR-0001 语境)
  AF: {
    SEARCH_MAX_PAGES: 1,     // 搜索阶段每轮翻页数(决策链: 2026-10-10 用户拍板 10→4; 2026-10-11 再拍 4→1——
                             // 一页 20 帖已足够, 帖内评论者由扫描阶段抽取, 单轮更快且少烧限流桶)
    SEARCH_PAGE_SIZE: 20,    // 搜索每页条数——必须是 20: SearchTimeline 实测 count≠20 直接 404(2026-10-10 对照实验: 21/40/100 均 404)
    PENDING_TARGET: 20,      // 主动关注队列水位线(决策链: 2026-10-11 用户拍板 50; 2026-10-12 再拍 50→20):
                             // 待关注低于此值时扫描提权+触发断供补池(需求侧缺人信号)
    MANUAL_SCAN_TARGET: 300, // 控制台「扫描帖子」连扫目标: 待关注补到此数或池内无到期帖即停(与 PENDING_TARGET 独立)
    QUEUE_CAP: 10000,        // 主动关注队列容量上限(满了暂停入队)
    RATIO_MAX: 1.2,          // 求粉特征阈值: 粉丝数/关注数 < 1.2 才入队
    SCAN_MAX: 3,             // 每帖最多扫描次数(帖子生命周期短, 三次后不再有新回复者)
    SCAN_INTERVAL_MS: 2 * 24 * 60 * 60 * 1000, // 重扫间隔: 隔两天
    SCAN_MAX_PAGES: 100,     // 单帖单次扫描回复的最大翻页数(首扫把回复跑完)
    SCAN_RETRY_MS: 30 * 60 * 1000, // 扫描被限流中断后, 该帖隔半小时重试(不消耗扫描次数)
    SCAN_ERR_RETRY_MS: 3 * 60 * 1000, // 扫描传输失败(tid 冷却/无模板/404)后推后重试——
                             // 不推后会每轮关注循环硬撞同一帖, 打穿 tid 池与限流桶
    // 同一 x-client-transaction-id 的成功有约60秒冷却(2026-10-10 实测: 成功后1秒重放→404, 68秒后→200;
    // 冷却期内同tid任何请求都被拒, 字节相同也一样; 失败不延长冷却; cursor可复用/键序无关)。
    // tid 收割池(ADR-0004)让连发成为可能, 但限流桶不变: 两次 SearchTimeline 发射至少隔 SEARCH_MIN_GAP_MS。
    TID_COOLDOWN_MS: 70 * 1000,
    SEARCH_MIN_GAP_MS: 30 * 1000, // 搜索/扫描发射节奏兼底: 50次/15分钟桶 ≈ 18s/发, 30s/发给页面自己的搜索留余量
    AUTO_SEARCH_COOLDOWN_MS: 60 * 60 * 1000, // 池子断供自动补池的冷却(2026-10-12): 抓过一轮后至少隔1小时再补——
                             // 搜索常只回旧帖(0 新帖), 无冷却会每 tick(30s)空烧限流桶
    POOL_MIN: 10,            // 池子存活帖(未扫完 scanCount<SCAN_MAX)低于此数即视为断供: 自动补池不等"无到期帖"——
                             // 供给即将枯竭, 哪怕存活帖都还在两天重扫冷却里也直接抓
  },
};
globalThis.RF = RF;
