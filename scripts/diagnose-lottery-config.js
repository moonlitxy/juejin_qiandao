// diagnose-lottery-config.js - 对比 service worker 与页面上下文请求 lottery_config/get 的结果
//
// 背景：插件在 SW 里调该接口时报 "Unexpected end of JSON input"（响应体为空）。
// 页面上下文调用正常。本脚本同时跑两处，定位差异。
//
// 用法：node scripts/diagnose-lottery-config.js

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const EXT = path.resolve(__dirname, '..');
const PROFILE = process.env.E2E_PROFILE || path.join(os.tmpdir(), 'juejin-qiandao-e2e-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const context = await chromium.launchPersistentContext(PROFILE, {
        headless: true,
        args: [
            `--disable-extensions-except=${EXT}`,
            `--load-extension=${EXT}`,
            '--disable-features=DisableLoadExtensionCommandLineSwitch',
            '--no-first-run',
            '--no-default-browser-check',
        ],
    });

    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30000 }).catch(() => null);
    if (!sw) throw new Error('未检测到扩展 service worker');

    const page = await context.newPage();
    await page.goto('https://juejin.cn/pins', { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // 1) service worker 上下文
    const swResult = await sw.evaluate(async () => {
        try {
            const res = await fetch('https://api.juejin.cn/growth_api/v1/lottery_config/get', {
                method: 'GET',
                credentials: 'include',
            });
            const text = await res.text();
            return { status: res.status, ok: res.ok, len: text.length, head: text.slice(0, 200) };
        } catch (e) {
            return { error: e.message };
        }
    });
    console.log('SW 上下文   :', JSON.stringify(swResult));

    // 2) 页面上下文
    const pageResult = await page.evaluate(async () => {
        try {
            const res = await fetch('https://api.juejin.cn/growth_api/v1/lottery_config/get', {
                method: 'GET',
                credentials: 'include',
            });
            const text = await res.text();
            return { status: res.status, ok: res.ok, len: text.length, head: text.slice(0, 200) };
        } catch (e) {
            return { error: e.message };
        }
    });
    console.log('页面上下文 :', JSON.stringify(pageResult));

    // 3) SW 里换一个已知可用的接口做对照
    const swOther = await sw.evaluate(async () => {
        try {
            const res = await fetch('https://api.juejin.cn/growth_api/v1/get_cur_point', {
                method: 'GET',
                credentials: 'include',
            });
            const text = await res.text();
            return { status: res.status, ok: res.ok, len: text.length, head: text.slice(0, 120) };
        } catch (e) {
            return { error: e.message };
        }
    });
    console.log('SW 对照接口 :', JSON.stringify(swOther));

    await context.close();
})().catch((e) => {
    console.error('诊断异常:', e);
    process.exitCode = 1;
});
