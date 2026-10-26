/**
 * 云端抽奖（GitHub Actions 专用）
 *
 * 只使用当天免费次数；free_count=0 时绝不调用 draw，
 * 因为该接口在没有免费次数时会改扣 200 矿石/次。
 */

const PATH_LOTTERY_CONFIG = '/growth_api/v1/lottery_config/get';
// ?aid=2608 是掘金 Web 端固定 app id，缺少时会表现为 Failed to fetch
const PATH_LOTTERY_DRAW = '/growth_api/v1/lottery/draw?aid=2608';

/** 查询免费抽奖次数：data.free_count 为主，其余字段为兼容兜底 */
const getLotteryConfig = async (path) => {
    const r = await fetch(`https://api.juejin.cn${path}`, { credentials: 'include' });
    const text = await r.text();
    if (!text) {
        return { httpStatus: r.status, empty: true };
    }
    return { httpStatus: r.status, ...JSON.parse(text) };
};

/** 执行抽奖：err_no 0=成功，400=免费次数已用完 */
const postLotteryDraw = async (path) => {
    const r = await fetch(`https://api.juejin.cn${path}`, {
        method: 'POST',
        credentials: 'include'
    });
    const text = await r.text();
    if (!text) {
        return { httpStatus: r.status, empty: true };
    }
    return { httpStatus: r.status, ...JSON.parse(text) };
};

/**
 * 一次运行最多抽一次，失败不重试：
 * 请求可能已经成功但响应丢失，重试会重复消耗免费次数或矿石。
 */
async function runLottery(session) {
    const cfg = await session.run(getLotteryConfig, PATH_LOTTERY_CONFIG);
    if (cfg.empty) {
        return { status: 'failed', freeCount: null, message: '抽奖配置接口返回空响应' };
    }
    if (cfg.err_no !== 0 || !cfg.data) {
        return {
            status: 'failed',
            freeCount: null,
            message: cfg.err_msg || `查询抽奖次数失败 (err_no: ${cfg.err_no})`
        };
    }

    const raw = cfg.data.free_count ?? cfg.data.free_time ?? cfg.data.lottery_free_count;
    const freeCount = Number.isFinite(Number(raw)) ? Number(raw) : 0;
    if (!(freeCount > 0)) {
        return { status: 'skipped', freeCount, message: '今日无免费抽奖机会' };
    }

    const draw = await session.run(postLotteryDraw, PATH_LOTTERY_DRAW);
    if (draw.empty) {
        return { status: 'failed', freeCount, message: '抽奖接口返回空响应' };
    }
    if (draw.err_no === 0 && draw.data) {
        const prizeName = draw.data.lottery_name || '';
        return {
            status: 'won',
            freeCount,
            prizeName: prizeName || null,
            prizeImage: draw.data.lottery_image || null,
            lotteryType: draw.data.lottery_type ?? null,
            message: prizeName ? `抽中 ${prizeName}` : '抽奖成功'
        };
    }
    if (draw.err_no === 400 || /免费次数|用完|没有.*机会/.test(draw.err_msg || '')) {
        return { status: 'skipped', freeCount, message: draw.err_msg || '免费抽奖次数已用完' };
    }

    return {
        status: 'failed',
        freeCount,
        message: draw.err_msg || `抽奖失败 (err_no: ${draw.err_no})`
    };
}

export { runLottery, getLotteryConfig };
