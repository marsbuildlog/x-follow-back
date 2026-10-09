// 全局常量: options 页(<script> 标签)与 content.js(动态 import)共用。
// 挂在 globalThis 上: content.js 会用 await import() 显式加载本文件并等待挂载完成。
const RF = {
  KEY: {
    settings: 'rf_settings',
    daily: 'rf_daily',
    task: 'rf_task',
    lock: 'rf_lock',
    log: 'rf_log',
    fetchProgress: 'rf_fetch_progress',
    refreshRequest: 'rf_refresh_request',
  },
  DEFAULTS: {
    intervalMin: 15,      // 关注间隔随机区间下限(秒)
    intervalMax: 30,      // 关注间隔随机区间上限(秒)
    stallMin: 30,         // 持续失败多少分钟判定为限流并暂停
    autoResumeMin: 60,    // 暂停后每隔多少分钟自动尝试恢复
    rateLimitBackoffMin: 15, // 命中 429/88 时的单次长退避(分钟)
  },
};
globalThis.RF = RF;
