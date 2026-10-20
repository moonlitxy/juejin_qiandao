// shared/date.js - 抽奖日期归属的统一口径
//
// 掘金按北京时间（UTC+8）结算每日免费抽奖次数，所以「这条抽奖属于哪一天」
// 也必须以 UTC+8 为准，而不是设备本地时区。否则同一台设备在 UTC-7 打开时，
// 同一条记录会被归到前一天，sync 的按天 key 也对不上。
//
// 注意：不能用 getFullYear() / getDate() 判断日期——它们读的是设备本地时区。
// 这里统一平移到 UTC+8 后取 UTC 部分，结果与设备时区无关。

const LOTTERY_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 把 Date / ISO 字符串 / 毫秒时间戳换算成 UTC+8 下的日期键 'YYYY-MM-DD'
 * @param {Date|string|number} input
 * @returns {string|null} 非法输入返回 null
 */
function toLotteryDateKey(input) {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    return new Date(date.getTime() + LOTTERY_TZ_OFFSET_MS).toISOString().slice(0, 10);
}
