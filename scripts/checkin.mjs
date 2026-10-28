#!/usr/bin/env node
/**
 * 掘金签到核心脚本（GitHub Actions / 本地通用）
 *
 * 为什么必须用 Playwright 而不是纯 fetch：
 * 掘金签到接口要求 x-secsdk-csrf-token（字节 X-Ware-Csrf-Token 机制），
 * 该 token 由页面 JS 动态生成，纯 HTTP 无法伪造，POST 会返回 HTTP 200 + 空 body。
 * 同时还依赖 msToken / ttwid 等浏览器风控 cookie。
 * 所以必须加载真实页面拿到这些参数，再在页面上下文（MAIN world）发请求。
 * 详见 scripts/diagnose-post.mjs 的抓包对比。
 *
 * 登录态靠 Cookie 注入，从环境变量 JUEJIN_COOKIE 读取（切勿提交到仓库）。
 *
 * 用法：
 *   JUEJIN_COOKIE='sessionid=xxx; sid_guard=yyy' node scripts/checkin.mjs
 *   JUEJIN_COOKIE='...' node scripts/checkin.mjs --dry-run    # 只查询不签到
 *   JUEJIN_COOKIE='...' node scripts/checkin.mjs --headed     # 本地调试时显示浏览器窗口
 *
 * 退出码：0 = 签到成功或今日已签；1 = 失败（登录失效 / 接口异常）
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { runLottery, getLotteryConfig } from './cloud-lottery.mjs';

const COOKIE = process.env.JUEJIN_COOKIE || '';
const DRY_RUN = process.argv.includes('--dry-run');
const HEADED = process.argv.includes('--headed');
// Actions 里把云端签到/抽奖结果写到仓库文件，供扩展拉取展示。
// 本地运行时默认不写，避免误改工作区。
const RESULT_FILE = process.env.CLOUD_RESULT_FILE || '';
const RUN_ID = [process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT]
    .filter(Boolean)
    .join('-');
const RESULT_HISTORY_LIMIT = 90;
const CHECK_IN_HISTORY_LIMIT = 90;
const LOTTERY_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

// 签到入口页：加载它是为了让页面 JS 种下 msToken / ttwid / x-secsdk-csrf-token
const PAGE_URL = 'https://juejin.cn/pins';
// 等页面脚本完成风控参数初始化的等待时间（毫秒）
const PAGE_WARMUP_MS = 5000;

/** 把 cookie 串转成 Playwright cookie 数组，统一挂到 .juejin.cn */
function parseCookies(cookieStr) {
    return cookieStr.split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
            const i = s.indexOf('=');
            return {
                name: s.slice(0, i),
                value: s.slice(i + 1),
                domain: '.juejin.cn',
                path: '/'
            };
        });
}

/**
 * 打开浏览器，加载签到页并注入 Cookie。
 * 与扩展的 attemptCheckInViaApi 保持一致：请求必须在页面主世界发，
 * 隔离世界的跨域 POST 会被 CORS 拦截，且拿不到页面的 csrf token。
 *
 * 浏览器只开一次并复用：msToken / ttwid / csrf token 都有时效，
 * 每个请求都重开页面既慢也可能踩到 token 过期。
 */
async function openSession(cookies) {
    const browser = await chromium.launch({ headless: !HEADED });
    try {
        const context = await browser.newContext();
        await context.addCookies(cookies);
        const page = await context.newPage();

        await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        // 等页面把 ttwid / msToken / csrf token 种好，否则 POST 会拿到空 body
        await page.waitForTimeout(PAGE_WARMUP_MS);

        return {
            run: (request, ...args) => page.evaluate(request, ...args),
            close: () => browser.close()
        };
    } catch (error) {
        await browser.close();
        throw error;
    }
}

// 注意：以下函数会被序列化后在页面上下文执行，拿不到模块作用域的变量，
// 所以端点路径一律通过参数传入，不能直接引用上面的 API 常量。

/** 探测登录态。注意：get_today_status 未登录时也返回 err_no:0，不能用来判登录 */
const probeLogin = async (path) => {
    const r = await fetch(`https://api.juejin.cn${path}`, { credentials: 'include' });
    return r.json();
};

/** 查询今日签到状态 */
const getTodayStatus = async (path) => {
    const r = await fetch(`https://api.juejin.cn${path}`, { credentials: 'include' });
    return r.json();
};

/** 执行签到：err_no 0=成功，15001=重复签到（线上实测值，10001 为旧值） */
const postCheckIn = async (path) => {
    const r = await fetch(`https://api.juejin.cn${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
    });
    const text = await r.text();
    if (!text) {
        return { httpStatus: r.status, empty: true };
    }
    return { httpStatus: r.status, ...JSON.parse(text) };
};

/** 拉取签到统计：cont_count=连续天数，sum_count=累计天数 */
const getCounts = async (path) => {
    const r = await fetch(`https://api.juejin.cn${path}`, { credentials: 'include' });
    return r.json();
};

const PATH_LOGIN = '/growth_api/v1/get_cur_point';
const PATH_TODAY = '/growth_api/v2/get_today_status';
const PATH_CHECKIN = '/growth_api/v1/check_in';
const PATH_COUNTS = '/growth_api/v1/get_counts';
const PATH_LOTTERY_CONFIG = '/growth_api/v1/lottery_config/get';

/** 抽奖日期归属与扩展保持一致：固定按 UTC+8 计算 */
function toDateKey(input) {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    return new Date(date.getTime() + LOTTERY_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 读取上一次的云端结果，保留最近 90 条，便于扩展补拉漏掉的日期 */
function readCloudResult() {
    if (!RESULT_FILE || !fs.existsSync(RESULT_FILE)) {
        return { version: 1, records: [], checkIns: [] };
    }
    try {
        const data = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
        return {
            version: 1,
            ...data,
            records: Array.isArray(data.records) ? data.records : [],
            checkIns: Array.isArray(data.checkIns) ? data.checkIns : []
        };
    } catch (error) {
        console.warn(`⚠️ 云端结果文件无法解析，将重新生成: ${error.message}`);
        return { version: 1, records: [], checkIns: [] };
    }
}

/**
 * 写入云端结果。抽奖记录按 runId 去重，失败/跳过也保留，
 * 扩展端可以据此展示“无免费次数”和异常原因。
 */
function writeCloudResult(checkIn, lottery) {
    if (!RESULT_FILE) {
        return;
    }

    const previous = readCloudResult();
    const records = previous.records.filter((record) => {
        if (!lottery || !lottery.runId) {
            return true;
        }
        return record.runId !== lottery.runId;
    });
    if (lottery) {
        records.unshift(lottery);
    }

    // 签到历史同样落盘，扩展拉取后能补齐本机看不到的云端签到。
    // 旧文件只有 latestCheckIn，先把它迁移进 checkIns 再写入本次记录。
    const seedCheckIns = previous.checkIns.length > 0
        ? previous.checkIns
        : (previous.latestCheckIn ? [previous.latestCheckIn] : []);
    const currentDay = checkIn && toDateKey(checkIn.date);
    const checkIns = seedCheckIns
        .filter((record) => record && record.date && (!currentDay || toDateKey(record.date) !== currentDay));
    if (checkIn && currentDay) {
        checkIns.unshift({
            date: checkIn.date,
            status: checkIn.status,
            contCount: checkIn.contCount ?? null,
            sumCount: checkIn.sumCount ?? null,
            source: 'cloud'
        });
    }

    // 保留旧文件里的 latestCheckIn / checkIns 等未知字段，扩展回传的签到
    // （source: extension）不能在云端下一次运行时被整个覆盖掉。
    const payload = {
        version: 1,
        ...previous,
        updatedAt: new Date().toISOString(),
        latestCheckIn: checkIn,
        checkIns: checkIns
            .filter((record) => record && record.date && record.status)
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, CHECK_IN_HISTORY_LIMIT),
        records: records
            .filter((record) => record && record.date && record.status)
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, RESULT_HISTORY_LIMIT)
    };

    fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
    fs.writeFileSync(RESULT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
    if (!COOKIE) {
        throw new Error('未设置环境变量 JUEJIN_COOKIE');
    }
    const cookies = parseCookies(COOKIE);
    // 只回显数量与长度，绝不打印原文
    console.log(`ℹ️ 已注入 ${cookies.length} 个 cookie（${COOKIE.length} 字符，原文不打印）`);

    const session = await openSession(cookies);
    try {
        const login = await session.run(probeLogin, PATH_LOGIN);
        if (login.err_no === 403) {
            throw new Error('Cookie 已失效或未登录（get_cur_point: must login），请更新 JUEJIN_COOKIE secret');
        }
        if (login.err_no !== 0) {
            throw new Error(`登录探测失败: ${login.err_msg || login.err_no}`);
        }
        console.log('✅ 登录态有效');

        const today = await session.run(getTodayStatus, PATH_TODAY);
        if (today.err_no !== 0) {
            throw new Error(`查询今日状态失败: ${today.err_msg || today.err_no}`);
        }
        const d = today.data || {};
        // 线上字段为 check_in_done；today_status / has_check_in 为旧字段，保留兼容
        const alreadyCheckedIn = d.check_in_done === true || d.today_status === 1 || d.has_check_in === true;

        const counts = await session.run(getCounts, PATH_COUNTS);
        const statOf = (counts) => counts.err_no === 0 && counts.data
            ? `连续 ${counts.data.cont_count} 天 / 累计 ${counts.data.sum_count} 天`
            : '统计获取失败';
        const stat = statOf(counts);
        const checkInRecord = {
            date: new Date().toISOString(),
            status: alreadyCheckedIn ? 'already_checked' : 'checked',
            source: 'cloud',
            contCount: counts.err_no === 0 && counts.data ? counts.data.cont_count : null,
            sumCount: counts.err_no === 0 && counts.data ? counts.data.sum_count : null
        };

        if (alreadyCheckedIn) {
            console.log('ℹ️ 今日已签到，跳过');
            console.log(`📊 ${stat}`);
        } else if (DRY_RUN) {
            console.log('🔍 --dry-run 模式：今日未签到，但不下发签到请求');
            console.log(`📊 ${stat}`);
        } else {
            const result = await session.run(postCheckIn, PATH_CHECKIN);
            if (result.empty) {
                throw new Error('签到接口返回空 body，通常意味着页面未注入 x-secsdk-csrf-token');
            }
            if (result.err_no === 0) {
                console.log('✅ 签到成功');
            } else if (result.err_no === 15001 || result.err_no === 10001 ||
                result.err_msg?.includes('重复') || result.err_msg?.includes('已经')) {
                console.log(`ℹ️ ${result.err_msg || '今天已经签到过了'}`);
                checkInRecord.status = 'already_checked';
            } else {
                throw new Error(result.err_msg || `签到失败 (err_no: ${result.err_no})`);
            }

            // 复验，避免"接口说成功但实际没签"
            const verify = await session.run(getTodayStatus, PATH_TODAY);
            const vd = verify.data || {};
            if (!(vd.check_in_done === true || vd.today_status === 1 || vd.has_check_in === true)) {
                throw new Error('签到接口返回成功，但复验仍未签到');
            }
            console.log('🔍 复验通过');
            const latestCounts = await session.run(getCounts, PATH_COUNTS);
            console.log(`📊 ${statOf(latestCounts)}`);
            if (latestCounts.err_no === 0 && latestCounts.data) {
                checkInRecord.contCount = latestCounts.data.cont_count;
                checkInRecord.sumCount = latestCounts.data.sum_count;
            }
        }

        if (DRY_RUN) {
            const cfg = await session.run(getLotteryConfig, PATH_LOTTERY_CONFIG);
            const raw = cfg.data && (cfg.data.free_count ?? cfg.data.free_time ?? cfg.data.lottery_free_count);
            console.log(`🎰 --dry-run 模式：免费抽奖次数 ${raw ?? '未知'}，不执行抽奖`);
            return;
        }

        // 抽奖 best-effort：失败只告警，不把已经成功的签到判为失败
        let lottery;
        try {
            lottery = await runLottery(session);
        } catch (error) {
            lottery = { status: 'failed', freeCount: null, message: `抽奖异常: ${error.message}` };
        }
        if (lottery.status === 'failed') {
            console.warn(`⚠️ 抽奖未完成: ${lottery.message}`);
        }

        const lotteryRecord = {
            date: new Date().toISOString(),
            runId: RUN_ID || null,
            status: lottery.status,
            prizeName: lottery.prizeName || null,
            prizeImage: lottery.prizeImage || null,
            lotteryType: lottery.lotteryType ?? null,
            message: lottery.message,
            freeCount: lottery.freeCount ?? null
        };
        writeCloudResult(checkInRecord, lotteryRecord);
    } finally {
        await session.close();
    }
}

main().catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
});
