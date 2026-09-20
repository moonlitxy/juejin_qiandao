/**
 * e2e-checkin.js - 真机端到端验证脚本
 *
 * 目的：用 Playwright 以命令行 --load-extension 加载本插件（不经过 chrome://extensions
 * 的"开发者模式"开关），在独立的临时 profile 中触发 manualCheckIn，断言 popup 显示：
 *   - 服务端/本地已签到  → 状态区"今日已签到"、按钮"已完成"
 *   - 首次签到成功        → 同样落到"今日已签到"
 *
 * 用法：
 *   node e2e-checkin.js            # 用独立临时 profile（首次需在窗口里登录掘金）
 *   E2E_PROFILE=/path node e2e-checkin.js
 *
 * 注意：首次运行会弹出 Chrome 窗口并要求登录掘金（最多等 5 分钟）。登录态会被
 * 持久化到 E2E_PROFILE，之后重复运行无需再登录。此 profile 与用户日常 Chrome 完全隔离。
 */

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT = __dirname;
const PROFILE = process.env.E2E_PROFILE || path.join(os.tmpdir(), 'juejin-qiandao-e2e-profile');
const OUT = path.join(__dirname, 'analysis-output');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN')}]`, ...a);

const results = [];
function assert(name, cond, detail) {
    results.push({ name, pass: !!cond, detail: detail == null ? null : String(detail) });
    log(`${cond ? '✅' : '❌'} ${name}${detail != null ? ' :: ' + detail : ''}`);
}

(async () => {
    log('启动 Chrome（独立 profile）:', PROFILE);

    // 复用已登录 profile 时，Chrome 会缓存上一次的扩展 service worker 脚本，导致
    // background.js 改动不生效（而 content.js 会更新，极易误判为"改了没用"）。
    // 启动前清掉脚本缓存即可；登录态（Cookies / Local Extension Settings）不受影响。
    for (const sub of ['Service Worker', 'Extension Scripts']) {
        fs.rmSync(path.join(PROFILE, 'Default', sub), { recursive: true, force: true });
    }

    const context = await chromium.launchPersistentContext(PROFILE, {
        // 必须用 Playwright 自带的 Chromium：本机 Chrome 152+ 已彻底禁用命令行
        // --load-extension（chrome://extensions 里看不到任何扩展）
        headless: false,
        viewport: { width: 1280, height: 900 },
        args: [
            `--disable-extensions-except=${EXT}`,
            `--load-extension=${EXT}`,
            // Chrome 137+ 默认禁用命令行 --load-extension，需显式关掉该特性开关
            '--disable-features=DisableLoadExtensionCommandLineSwitch',
            '--no-first-run',
            '--no-default-browser-check',
        ],
    });

    // 等插件的 service worker 注册成功（证明扩展被加载）
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30000 }).catch(() => null);
    if (!sw) throw new Error('未检测到扩展 service worker —— --load-extension 没生效');
    const extId = new URL(sw.url()).host;
    log('插件已加载, extension id =', extId);
    // 收集 background 日志，用于断言走的是哪条判定路径
    const swLogs = [];
    sw.on('console', (m) => {
        swLogs.push(m.text());
        log('[SW]', m.text());
    });

    const page = await context.newPage();
    page.on('console', (m) => log('[page]', m.text()));
    page.on('response', async (res) => {
        const u = res.url();
        if (u.includes('growth_api')) log('📡', res.request().method(), res.status(), u);
    });
    await page.goto('https://juejin.cn/pins', { waitUntil: 'domcontentloaded' });

    // 在页面上下文里调掘金 API（带登录 cookie）
    // 掘金 /pins 是 SPA，加载中会客户端跳转导致执行上下文被销毁，故自带重试
    const apiGet = async (url) => {
        for (let i = 0; i < 6; i++) {
            try {
                const r = await page.evaluate(async (u) => {
                    try {
                        const res = await fetch(u, { credentials: 'include' });
                        return { httpStatus: res.status, json: await res.json().catch(() => null) };
                    } catch (e) {
                        return { httpStatus: 0, error: String(e) };
                    }
                }, url);
                if (r.json || r.error) return r;
            } catch (e) {
                // 执行上下文被导航销毁，等页面稳定后重试
            }
            await sleep(1500);
        }
        return { httpStatus: 0, error: 'evaluate 重试耗尽' };
    };

    // 登录判据：get_today_status 未登录时也返回 err_no:0（误导），
    // 而 get_cur_point 未登录明确返回 err_no:403 must login，用它判定。
    const isLoggedIn = async () => {
        const r = await apiGet('https://api.juejin.cn/growth_api/v1/get_cur_point');
        return !!(r.json && r.json.err_no === 0);
    };

    log('请在打开的窗口里登录掘金（最多等 5 分钟）...');
    let loggedIn = false;
    const loginDeadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < loginDeadline) {
        if (await isLoggedIn()) { loggedIn = true; break; }
        await sleep(3000);
    }
    assert('已登录掘金（get_cur_point err_no=0）', loggedIn);
    if (!loggedIn) {
        log('❌ 超时未检测到登录，退出');
        await context.close();
        process.exit(1);
    }
    log('✅ 登录态已确认');

    const stRes = await apiGet('https://api.juejin.cn/growth_api/v2/get_today_status');
    const st = stRes.json;
    log('GET get_today_status =', JSON.stringify(st));

    // 打印真实字段名，核对插件判据 today_status / has_check_in 是否还与线上一致
    const fields = st && st.data ? Object.keys(st.data) : [];
    log('data 字段:', JSON.stringify(fields));
    const serverCheckedIn = !!(st && st.data &&
        (st.data.today_status === 1 || st.data.has_check_in === true || st.data.check_in_done === true));
    log('服务端今日已签到 =', serverCheckedIn);
    assert('服务端签到状态可读', st && st.data != null, JSON.stringify(st));
    assert('线上返回 check_in_done 字段（当前判据）',
        fields.includes('check_in_done'),
        '实际字段: ' + JSON.stringify(fields));

    // 打开 popup 页面（扩展页，可正常使用 chrome.runtime）
    const popup = await context.newPage();
    popup.on('console', (m) => log('[popup]', m.text()));
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await sleep(1000);

    // 清空本地 lastCheckInDate，模拟"网页签到 / 多设备 / 重装"：本地没有任何记录
    const resetLocal = () => popup.evaluate(async () => {
        const { config } = await chrome.storage.local.get('config');
        await chrome.storage.local.set({
            config: { ...(config || {}), lastCheckInDate: null, checkInHistory: [], consecutiveDays: 0 },
        });
    });

    const readUI = () => popup.evaluate(() => {
        const btn = document.getElementById('manualCheckInBtn');
        return {
            title: document.getElementById('statusTitle').textContent.trim(),
            desc: document.getElementById('statusDesc').textContent.trim(),
            btn: btn.textContent.replace(/\s+/g, ''),
            disabled: btn.disabled,
            last: document.getElementById('lastCheckInTime').textContent.trim(),
            toast: (document.getElementById('notification-container') || {}).innerText || '',
        };
    });

    // ===== 场景 A：本地无记录 + 不点任何按钮 → 打开插件应自动与服务端同步为"今日已签到" =====
    await resetLocal();
    await popup.reload();
    await sleep(6000);
    const syncedUI = await readUI();
    log('场景A（本地无记录、未点击）popup 状态 =', JSON.stringify(syncedUI, null, 2));
    assert('场景A：打开插件即自动显示"今日已签到"（服务端同步）',
        syncedUI.title.includes('今日已签到'), syncedUI.title + ' / ' + syncedUI.btn);
    await popup.screenshot({ path: path.join(OUT, 'e2e-popup-synced.png') });

    // ===== 场景 B：本地无记录 + 触发 manualCheckIn → 已签到判据走服务端 API =====
    await resetLocal(); // 只改存储、不 reload，避免 popup 的自动同步抢先补齐
    const before = await readUI();
    log('场景B 触发前 popup 状态 =', JSON.stringify(before, null, 2));

    log('触发 manualCheckIn...');
    const resp = await popup.evaluate(() => new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'manualCheckIn' }, resolve);
    }));
    log('manualCheckIn 响应 =', JSON.stringify(resp));
    assert('场景B：manualCheckIn 经服务端 API 判定为"已签到"',
        !!(resp && resp.alreadyCheckedIn), JSON.stringify(resp));

    await sleep(3000);
    const after = await readUI();
    log('场景B 触发后 popup 状态 =', JSON.stringify(after, null, 2));

    await popup.screenshot({ path: path.join(OUT, 'e2e-popup-after.png') });
    await page.screenshot({ path: path.join(OUT, 'e2e-pins.png'), fullPage: true }).catch(() => {});

    assert('popup 状态区显示"今日已签到"', after.title.includes('今日已签到'), after.title);
    assert('popup 按钮显示"已完成"', after.btn.includes('已完成'), after.btn);
    assert('已签到判据确实走了服务端 API（check_in_done 修复回归）',
        swLogs.some((l) => l.includes('已经签到过了')),
        swLogs.filter((l) => l.includes('签到')).slice(-2).join(' | '));

    fs.writeFileSync(
        path.join(OUT, 'e2e-result.json'),
        JSON.stringify({ extId, serverCheckedIn, status: st, syncedUI, before, after, results }, null, 2)
    );

    const failed = results.filter((r) => !r.pass);
    log(`\n===== 汇总: ${results.length - failed.length}/${results.length} 通过 =====`);
    await sleep(3000);
    await context.close();
    process.exit(failed.length ? 1 : 0);
})().catch((e) => {
    console.error('E2E 出错:', e);
    process.exit(2);
});
