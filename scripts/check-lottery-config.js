// 临时只读脚本：确认掘金抽奖配置接口的字段名与免费次数
// 用法：node check-lottery-config.js
// 复用 e2e-checkin.js 的登录 profile；不消耗任何抽奖机会。

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PROFILE = process.env.E2E_PROFILE || path.join(os.tmpdir(), 'juejin-qiandao-e2e-profile');
const HEADLESS = process.env.HEADLESS !== '0';

(async () => {
    console.log('profile:', PROFILE, '| headless:', HEADLESS);

    if (!fs.existsSync(PROFILE)) {
        console.log('profile 不存在——尚未登录过，无法复用登录态');
    }

    const context = await chromium.launchPersistentContext(PROFILE, {
        headless: HEADLESS,
        args: ['--no-first-run', '--no-default-browser-check'],
    });

    try {
        const page = await context.newPage();
        await page.goto('https://juejin.cn/pins', { waitUntil: 'domcontentloaded' });

        const result = await page.evaluate(async () => {
            const call = async (url) => {
                try {
                    const res = await fetch(url, { credentials: 'include' });
                    return { status: res.status, body: await res.text() };
                } catch (e) {
                    return { status: -1, body: 'fetch 异常: ' + e.message };
                }
            };
            return {
                lotteryConfig: await call('https://api.juejin.cn/growth_api/v1/lottery_config/get'),
                // 兼容对照：未登录时 get_cur_point 会返回 err_no:403 must login
                loginCheck: await call('https://api.juejin.cn/growth_api/v1/get_cur_point'),
            };
        });

        console.log('\n=== lottery_config/get ===');
        console.log('HTTP', result.lotteryConfig.status);
        console.log(result.lotteryConfig.body);

        console.log('\n=== get_cur_point（判登录态）===');
        console.log('HTTP', result.loginCheck.status);
        console.log(result.loginCheck.body);
    } finally {
        await context.close();
    }
})();
