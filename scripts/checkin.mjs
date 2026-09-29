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

const COOKIE = process.env.JUEJIN_COOKIE || '';
const DRY_RUN = process.argv.includes('--dry-run');
const HEADED = process.argv.includes('--headed');

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

        const statOf = (counts) => counts.err_no === 0 && counts.data
            ? `连续 ${counts.data.cont_count} 天 / 累计 ${counts.data.sum_count} 天`
            : '统计获取失败';
        const stat = statOf(await session.run(getCounts, PATH_COUNTS));

        if (alreadyCheckedIn) {
            console.log('ℹ️ 今日已签到，跳过');
            console.log(`📊 ${stat}`);
            return;
        }

        if (DRY_RUN) {
            console.log('🔍 --dry-run 模式：今日未签到，但不下发签到请求');
            console.log(`📊 ${stat}`);
            return;
        }

        const result = await session.run(postCheckIn, PATH_CHECKIN);
        if (result.empty) {
            throw new Error('签到接口返回空 body，通常意味着页面未注入 x-secsdk-csrf-token');
        }
        if (result.err_no === 0) {
            console.log('✅ 签到成功');
        } else if (result.err_no === 15001 || result.err_no === 10001 ||
            result.err_msg?.includes('重复') || result.err_msg?.includes('已经')) {
            console.log(`ℹ️ ${result.err_msg || '今天已经签到过了'}`);
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
        console.log(`📊 ${statOf(await session.run(getCounts, PATH_COUNTS))}`);
    } finally {
        await session.close();
    }
}

main().catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
});
