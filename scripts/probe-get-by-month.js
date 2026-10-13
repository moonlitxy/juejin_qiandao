// probe-get-by-month.js - 探测掘金 get_by_month 是否支持指定月份
//
// 插件目前固定查「当前月」。若要支持跨月查看签到日历，需要该接口能接受月份参数。
// 本脚本在掘金页面上下文依次尝试几种参数写法，对比返回，判断支持哪种。
// 只读，不改任何状态。

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const PROFILE = process.env.E2E_PROFILE || path.join(os.tmpdir(), 'juejin-qiandao-e2e-profile');
const BASE = 'https://api.juejin.cn/growth_api/v1/get_by_month';

(async () => {
    const context = await chromium.launchPersistentContext(PROFILE, {
        headless: true,
        args: ['--no-first-run', '--no-default-browser-check'],
    });
    const page = await context.newPage();
    await page.goto('https://juejin.cn/pins', { waitUntil: 'domcontentloaded' });

    // 参数写法候选：月为 0 基还是 1 基、字符串还是数字，都要试
    const variants = [
        { label: '无参数（基准）', url: BASE },
        { label: '?month=2026-09', url: BASE + '?month=2026-09' },
        { label: '?month=2026-08', url: BASE + '?month=2026-08' },
        { label: '?year=2026&month=9', url: BASE + '?year=2026&month=9' },
        { label: '?year=2026&month=8', url: BASE + '?year=2026&month=8' },
        { label: '?date=2026-09', url: BASE + '?date=2026-09' },
        { label: '?query=2026-09', url: BASE + '?query=2026-09' },
    ];

    const results = await page.evaluate(async (items) => {
        const out = [];
        const toIso = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
        for (const item of items) {
            try {
                const res = await fetch(item.url, { credentials: 'include' });
                const json = await res.json();
                // 注意：该接口的 data 字段本身就是数组，不是 { days: [...] }
                const days = Array.isArray(json.data) ? json.data : [];
                out.push({
                    label: item.label,
                    errNo: json.err_no,
                    count: days.length,
                    first: days[0] ? toIso(days[0].date) : null,
                    last: days.length ? toIso(days[days.length - 1].date) : null,
                    statuses: days.slice(0, 4).map((d) => d.status).join(','),
                });
            } catch (e) {
                out.push({ label: item.label, error: e.message });
            }
        }
        return out;
    }, variants);

    for (const r of results) {
        console.log(r.label, '->', JSON.stringify(r));
    }

    // 再确认掘金网页本身的签到日历有没有翻月控件（有则说明另有接口）
    console.log('\n=== 检查掘金个人中心的日历控件 ===');
    const seen = new Set();
    page.on('response', (res) => {
        const url = res.url();
        if (url.includes('growth_api') && !seen.has(url)) {
            seen.add(url);
            console.log('  [net]', res.status(), url.split('?')[0]);
        }
    });

    await page.goto('https://juejin.cn/user/center', { waitUntil: 'domcontentloaded' });
    await sleep(5000);

    const monthTexts = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('*').forEach((el) => {
            if (el.children.length === 0) {
                const t = (el.textContent || '').trim();
                if (t && t.length <= 12 && (t.includes('月') || t.includes('年'))) {
                    out.push(t);
                }
            }
        });
        return [...new Set(out)].slice(0, 20);
    });
    console.log('页面上含"月/年"的文本:', JSON.stringify(monthTexts));

    for (const label of ['上个月', '下个月', '上月', '下月']) {
        const loc = page.locator(`text=${label}`).first();
        if (await loc.count() > 0) {
            console.log(`找到并点击「${label}」`);
            await loc.click({ timeout: 3000 }).catch((e) => console.log('  点击失败:', e.message.split('\n')[0]));
            await sleep(2500);
        }
    }

    await context.close();
})().catch((e) => {
    console.error('探测异常:', e);
    process.exitCode = 1;
});
