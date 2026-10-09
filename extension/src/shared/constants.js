// 全局常量: content script 与 options 页共用(manifest 中先后加载)
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
