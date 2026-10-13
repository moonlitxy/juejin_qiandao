// verify-lottery.js - 有头浏览器实测「签到后自动抽奖」链路
//
// 流程：启动独立 Chromium（加载本插件）→ 打开掘金沸点页 → 等你登录 →
//       查 lottery_config/get 的 free_count → 有免费次数则由扩展的 service worker
//       真实调用 runLottery + saveLotteryResult → 打开 popup 截图。
//
// 用法：node verify-lottery.js
// 登录态持久化在同目录的 e2e profile，下次无需再登录。
// 注意：会真实消耗当天的免费抽奖机会。

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const EXT = ROOT;
const PROFILE = process.env.E2E_PROFILE || path.join(os.tmpdir(), 'juejin-qiandao-e2e-profile');
const OUT = path.join(ROOT, 'analysis-output');
const LOGIN_WAIT_MS = 180000;

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN')}]`, ...a);

// 打开 popup 并截图，用于查看抽奖行的展示效果
async function shootPopup(context, extId, filename) {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await sleep(2000);
    await popup.screenshot({ path: path.join(OUT, filename) });
    log('popup 截图已保存: analysis-output/' + filename);
}

// 打开设置页并截图；clickSelector 非空时先点它（例如翻到上个月）
async function shootOptions(context, extId, filename, clickSelector = null) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await sleep(2500);
    if (clickSelector) {
        await page.click(clickSelector);
        await sleep(800);
    }
    await page.screenshot({ path: path.join(OUT, filename), fullPage: true });
    log('设置页截图已保存: analysis-output/' + filename);
    await page.close();
}

(async () => {
    // 复用 profile 时 Chrome 会缓存扩展 service worker 脚本，启动前清掉（登录态不受影响）
    for (const sub of ['Service Worker', 'Extension Scripts']) {
        fs.rmSync(path.join(PROFILE, 'Default', sub), { recursive: true, force: true });
    }

    const context = await chromium.launchPersistentContext(PROFILE, {
        headless: false,
        viewport: { width: 1280, height: 900 },
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
    if (!sw) throw new Error('未检测到扩展 service worker —— --load-extension 没生效');
    const extId = new URL(sw.url()).host;
    log('插件已加载, extension id =', extId);

    // 收集 service worker 日志，便于查看抽奖各步的实际返回
    const swLogs = [];
    sw.on('console', (m) => swLogs.push(m.text()));

    const page = await context.newPage();
    await page.goto('https://juejin.cn/pins', { waitUntil: 'domcontentloaded' });
    log('已打开掘金沸点页。若未登录，请在弹出的窗口里登录（最多等 3 分钟）...');

    // 轮询登录态：get_cur_point 未登录返回 err_no:403
    let loggedIn = false;
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
        const r = await page.evaluate(async () => {
            try {
                const res = await fetch('https://api.juejin.cn/growth_api/v1/get_cur_point', { credentials: 'include' });
                return await res.json();
            } catch (e) {
                return { err_no: -1, err_msg: e.message };
            }
        });
        if (r && r.err_no !== 403 && r.err_no !== -1) {
            loggedIn = true;
            break;
        }
        await sleep(3000);
    }
    if (!loggedIn) {
        log('等待登录超时，退出');
        await context.close();
        return;
    }
    log('已登录');

    // 查免费次数（只读）
    const cfg = await page.evaluate(async () => {
        const res = await fetch('https://api.juejin.cn/growth_api/v1/lottery_config/get', { credentials: 'include' });
        return await res.json();
    });
    const freeCount = cfg && cfg.data ? cfg.data.free_count : undefined;
    log('free_count =', freeCount);

    // 关键验证：走插件自己的查询路径（页面主世界 executeScript），
    // 确认 SW 里不再拿到空响应体（曾报 "Unexpected end of JSON input"）
    const cfgViaExtension = await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: 'https://juejin.cn/*' });
        const tab = tabs.find((t) => t.url && t.url.includes('juejin.cn/pins')) || tabs[0];
        if (!tab) {
            return { ok: false, message: '找不到掘金标签页' };
        }
        return await fetchLotteryConfigViaApi(tab.id);
    });
    log('插件内查询免费次数:', JSON.stringify(cfgViaExtension));

    if (!(freeCount > 0)) {
        log('今日无免费抽奖机会 —— 插件的正确行为就是跳过抽奖，维持签到成功');

        // MOCK=1：写入三条样例记录（中奖/未抽/失败），仅用于查看展示效果
        if (process.env.MOCK === '1') {
            log('MOCK 模式：写入三条样例抽奖记录');
            await sw.evaluate(async () => {
                const storage = await chrome.storage.local.get(['config']);
                const config = storage.config || {};
                const now = Date.now();
                const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
                config.lotteryHistory = [
                    { date: iso(0), status: 'won', prizeName: '66矿石', message: '抽中 66矿石', freeCount: 1 },
                    { date: iso(1), status: 'skipped', prizeName: null, message: '今日无免费抽奖机会', freeCount: 0 },
                    { date: iso(2), status: 'failed', prizeName: null, message: '抽奖失败：服务异常', freeCount: 1 },
                    { date: iso(20), status: 'won', prizeName: '随机盲盒', message: '抽中 随机盲盒', freeCount: 1 },
                ];
                config.lotteryResult = config.lotteryHistory[0];
                await chrome.storage.local.set({ config });
            });
            await shootPopup(context, extId, 'popup-lottery-mock.png');
            await shootOptions(context, extId, 'options-lottery-calendar.png');
            await shootOptions(context, extId, 'options-lottery-calendar-prev.png', '#lotteryPrevMonth');
        } else {
            // 无免费次数时也截一张，便于查看 popup 各区块（含矿石总数）
            await shootPopup(context, extId, 'popup-no-chance.png');
        }

        // 关键验证：无免费次数时 runLottery 必须直接跳过，绝不能调 draw（会扣 200 矿石/次）
        const skipCheck = await sw.evaluate(async () => {
            const tabs = await chrome.tabs.query({ url: 'https://juejin.cn/*' });
            const tab = tabs.find((t) => t.url && t.url.includes('juejin.cn/pins')) || tabs[0];
            return tab ? await runLottery(tab.id) : { error: '找不到掘金标签页' };
        });
        log('runLottery（free_count=0）:', JSON.stringify(skipCheck));

        if (swLogs.length > 0) {
            console.log('--- service worker 日志（应无"尝试使用 API 抽奖"）---');
            for (const line of swLogs) {
                console.log(line);
            }
        }

        await context.close();
        return;
    }

    // 由扩展的 service worker 真实调用插件代码
    log('调用扩展的 runLottery(tabId)...');
    const result = await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: 'https://juejin.cn/*' });
        const tab = tabs.find((t) => t.url && t.url.includes('juejin.cn/pins')) || tabs[0];
        if (!tab) return { error: '找不到掘金标签页' };
        const r = await runLottery(tab.id);
        await saveLotteryResult(r);
        return r;
    });
    log('runLottery 结果:', JSON.stringify(result));

    // 打开 popup 看展示效果
    await shootPopup(context, extId, 'popup-lottery.png');

    log('完成，即将关闭浏览器');

    if (swLogs.length > 0) {
        console.log('\n=== service worker 日志 ===');
        for (const line of swLogs) {
            console.log(line);
        }
    }

    await context.close();
})().catch((e) => {
    console.error('验证脚本异常:', e);
    process.exitCode = 1;
});
