// 全局常量: options 页(<script> 标签)与 content.js(动态 import)共用。
// 挂在 globalThis 上: content.js 会用 await import() 显式加载本文件并等待挂载完成。
const RF = {
  KEY: {
    settings: 'rf_settings',
    daily: 'rf_daily',   // 前缀, 实际键 rf_daily:{handle}(按账号分键)
    task: 'rf_task',     // 前缀, 实际键 rf_task:{handle}(按账号分键)
    lock: 'rf_lock',
    log: 'rf_log',
    fetchProgress: 'rf_fetch_progress',
    active: 'rf_active', // 最近活跃账号(options/popup 无页面上下文时定位任务)
  },
  DEFAULTS: {
    intervalMin: 3,       // 关注间隔随机区间下限(秒)
    intervalMax: 8,       // 关注间隔随机区间上限(秒)
    stallMin: 30,         // 持续失败多少分钟判定为限流并暂停
    autoResumeMin: 60,    // 暂停后每隔多少分钟自动尝试恢复
    rateLimitBackoffMin: 15, // 命中 429/88 时的单次长退避(分钟)
    autoFetchMin: 30,     // 自动拉取认证粉丝间隔(分钟, 手动拉取后重新计时)
  },
};
globalThis.RF = RF;
