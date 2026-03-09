// shared/config.js - 统一的配置管理
// 此文件需要在所有需要配置的脚本之前加载

/**
 * 默认配置对象
 * 所有文件应该使用这个统一的配置定义，避免重复定义导致不同步
 */
const DEFAULT_CONFIG = {
    enabled: true,              // 是否启用自动签到
    checkInTime: '09:00',       // 签到时间（24小时制）
    lastCheckInDate: null,      // 最后签到日期
    checkInHistory: [],         // 签到历史记录
    consecutiveDays: 0,         // 连续签到天数
    successNotification: true,  // 成功通知开关
    failureNotification: true,  // 失败通知开关
    retryCount: 1,              // 重试次数
    loadTimeout: 30             // 页面加载超时（秒）
};

/**
 * 配置键名常量
 * 使用常量避免字符串拼写错误
 */
const CONFIG_KEYS = {
    ENABLED: 'enabled',
    CHECK_IN_TIME: 'checkInTime',
    LAST_CHECK_IN_DATE: 'lastCheckInDate',
    CHECK_IN_HISTORY: 'checkInHistory',
    CONSECUTIVE_DAYS: 'consecutiveDays',
    SUCCESS_NOTIFICATION: 'successNotification',
    FAILURE_NOTIFICATION: 'failureNotification',
    RETRY_COUNT: 'retryCount',
    LOAD_TIMEOUT: 'loadTimeout'
};
