// probe-lottery-api.js - 探测掘金是否提供「抽奖记录 / 我的奖品」接口
//
// 只读：不抽奖、不改任何状态。做两件事：
//   1. 打开掘金页面并点击「去抽奖」，监听真实网络请求，发现抽奖相关的接口
//   2. 直接探测一批候选端点，看哪个能返回奖品记录
//
// 用法：node scripts/probe-lottery-api.js

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const PROFILE = process.env.E2E_PROFILE || path.join(os.tmpdir(), 'juejin-qiandao-e2e-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// 候选端点：基于掘金 growth_api 的命名习惯推测
// 已知页面真实请求过：lottery_history/global_small、global_big、lottery_lucky/my_lucky
// 页面请求一律带 aid/uuid/spider 等参数，这里照带，观察是否有个人记录接口
const PARAMS = '?aid=2608&uuid=7696173763818456627&spider=0';
const CANDIDATES = [
    '/growth_api/v1/lottery_history/global_small',
    '/growth_api/v1/lottery_history/global_big',
    '/growth_api/v1/lottery_history/my',
    '/growth_api/v1/lottery_history/my_history',
    '/growth_api/v1/lottery_history/user_history',
    '/growth_api/v1/lottery_history/personal',
    '/growth_api/v1/lottery_history/list',
    '/growth_api/v1/lottery/my_history',
    '/growth_api/v1/user_lottery_history',
    '/growth_api/v1/lottery_lucky/my_lucky',
].map((p) => 'https://api.juejin.cn' + p + PARAMS);

(async () => {
    const context = await chromium.launchPersistentContext(PROFILE, {
        headless: true,
        args: ['--no-first-run', '--no-default-browser-check'],
    });

    const page = await context.newPage();

    // 收集页面上真实发生的掘金接口请求
    const seen = new Set();
    page.on('response', (res) => {
        const url = res.url();
        if (url.includes('juejin.cn') && (url.includes('growth_api') || url.includes('lottery'))) {
            const key = res.status() + ' ' + url;
            if (!seen.has(key)) {
                seen.add(key);
                log('  [net]', res.status(), url);
            }
        }
    });

    log('=== 第一步：访问 /pins 并尝试打开抽奖界面，观察真实请求 ===');
    await page.goto('https://juejin.cn/pins', { waitUntil: 'domcontentloaded' });
    await sleep(3000);

    const clickTargets = ['去抽奖', '抽奖', '立即抽奖', '中奖记录', '我的奖品', '抽奖记录', '记录'];
    for (const text of clickTargets) {
        try {
            const el = page.locator(`text=${text}`).first();
            if (await el.count() > 0) {
                await el.click({ timeout: 3000 });
                log(`  已点击「${text}」`);
                await sleep(3000);
            }
        } catch (e) {
            log(`  点击「${text}」失败: ${e.message.split('\n')[0]}`);
        }
    }
    await sleep(3000);

    // 再访问几个可能挂载「我的奖品 / 中奖记录」的页面，继续收集请求
    const extraPages = [
        'https://juejin.cn/user/center',
        'https://juejin.cn/user/center/lottery',
        'https://juejin.cn/lottery',
    ];
    for (const url of extraPages) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await sleep(2500);
            log(`  已访问 ${url}`);
        } catch (e) {
            log(`  访问 ${url} 失败: ${e.message.split('\n')[0]}`);
        }
    }

    log('\n=== 第二步：直接探测候选端点 ===');
    const probe = await page.evaluate(async (urls) => {
        const out = [];
        for (const url of urls) {
            try {
                const res = await fetch(url, { credentials: 'include' });
                const text = await res.text();
                out.push({ url, status: res.status, body: text.slice(0, 260) });
            } catch (e) {
                out.push({ url, status: -1, body: 'ERR ' + e.message });
            }
        }
        return out;
    }, CANDIDATES);

    for (const r of probe) {
        log(`${r.status}  ${r.url}`);
        log(`      ${r.body}`);
    }

    await context.close();
})().catch((e) => {
    console.error('探测脚本异常:', e);
    process.exitCode = 1;
});
