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
    totalCheckInDays: 0,        // 累计签到天数（服务端 get_counts 的 sum_count）
    monthCheckInCount: 0,       // 本月签到天数（服务端 get_by_month 统计）
    monthCheckInMonth: null,    // 上面的统计所属月份（'YYYY-MM'，跨月需重新拉取）
    successNotification: true,  // 成功通知开关
    failureNotification: true,  // 失败通知开关
    retryCount: 1,              // 重试次数
    loadTimeout: 30,            // 页面加载超时（秒）
    autoLottery: true,          // 自动抽奖开关（仅签到成功后生效）
    lotteryResult: null,        // 最近一次抽奖结果（供 popup 渲染）
    lotteryHistory: [],         // 抽奖历史记录（最近90条）
    syncLottery: true,          // 抽奖记录同步到其他设备（chrome.storage.sync）
    cloudLotterySync: false,    // 拉取 GitHub Actions 的云端抽奖结果
    githubLotterySync: false,   // 本机抽中免费奖品后回传 GitHub
    githubRepo: '',             // 云端结果仓库（owner/repo），空表示不连接
    cloudRepoConfirmed: false   // 用户是否在设置页确认过自己的仓库
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
    TOTAL_CHECK_IN_DAYS: 'totalCheckInDays',
    MONTH_CHECK_IN_COUNT: 'monthCheckInCount',
    MONTH_CHECK_IN_MONTH: 'monthCheckInMonth',
    SUCCESS_NOTIFICATION: 'successNotification',
    FAILURE_NOTIFICATION: 'failureNotification',
    RETRY_COUNT: 'retryCount',
    LOAD_TIMEOUT: 'loadTimeout',
    AUTO_LOTTERY: 'autoLottery',
    LOTTERY_RESULT: 'lotteryResult',
    LOTTERY_HISTORY: 'lotteryHistory',
    SYNC_LOTTERY: 'syncLottery',
    CLOUD_LOTTERY_SYNC: 'cloudLotterySync',
    GITHUB_LOTTERY_SYNC: 'githubLotterySync',
    GITHUB_REPO: 'githubRepo',
    CLOUD_REPO_CONFIRMED: 'cloudRepoConfirmed'
};
