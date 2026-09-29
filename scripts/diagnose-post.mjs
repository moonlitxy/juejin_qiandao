#!/usr/bin/env node
/**
 * 诊断脚本（临时）：用 Playwright 注入 Cookie 加载真实掘金页面，
 * 抓取真实浏览器发出的 check_in POST 请求，对比纯 curl 的差异。
 *
 * 目的：确认云端签到到底缺什么（msToken / ttwid 等风控参数）。
 * 安全：只打印 header 键名与脱敏后的长度，Cookie 原文绝不回显。
 *
 * 用法：JUEJIN_COOKIE='...' node scripts/diagnose-post.mjs
 */
import { chromium } from 'playwright';

const COOKIE = process.env.JUEJIN_COOKIE || '';
if (!COOKIE) {
    console.error('❌ 未设置 JUEJIN_COOKIE');
    process.exit(1);
}

// 把 cookie 串转成 Playwright cookie 数组，统一挂到 .juejin.cn
const cookies = COOKIE.split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
        const i = s.indexOf('=');
        return { name: s.slice(0, i), value: s.slice(i + 1), domain: '.juejin.cn', path: '/' };
    });
console.log(`ℹ️ 注入 ${cookies.length} 个 cookie（原文不打印）`);

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addCookies(cookies);
const page = await context.newPage();

// 只在页面上下文执行 fetch，模拟扩展 MAIN world 的行为
page.on('request', (req) => {
    if (req.url().includes('/check_in')) {
        const h = req.headers();
        console.log('\n=== 真实浏览器发出的 check_in 请求 ===');
        console.log('METHOD:', req.method());
        console.log('HEADER 键名与长度（值脱敏）:');
        for (const [k, v] of Object.entries(h)) {
            const sensitive = /cookie|token|auth/i.test(k);
            console.log(`  ${k}: ${sensitive ? `<隐藏, ${String(v).length} 字符>` : v}`);
        }
    }
});
// 记录未完成的响应读取，避免 browser.close() 提前导致 res.text() 竞态
const pending = [];
page.on('response', (res) => {
    if (!res.url().includes('/check_in')) return;
    pending.push((async () => {
        console.log('STATUS:', res.status());
        console.log('RESP HEADERS（脱敏）:');
        for (const [k, v] of Object.entries(await res.allHeaders())) {
            const sensitive = /cookie|token|auth/i.test(k);
            console.log(`  ${k}: ${sensitive ? `<隐藏, ${String(v).length} 字符>` : v}`);
        }
        console.log('BODY:', await res.text());
    })());
});

await page.goto('https://juejin.cn/pins', { waitUntil: 'domcontentloaded', timeout: 60000 });
// 等页面脚本把 ttwid / msToken 等风控 cookie 种下
await page.waitForTimeout(5000);

// 查看页面实际拿到的 cookie 键名（只看键名）
const cookieKeys = await page.evaluate(() => document.cookie.split(';').map((s) => s.trim().split('=')[0]).filter(Boolean));
console.log('\n=== 页面 document.cookie 键名 ===');
console.log(cookieKeys.join(' '));
const missing = ['msToken', 'ttwid', 's_v_web_id'].filter((k) => !cookieKeys.includes(k));
console.log('纯 curl 缺失的风控 cookie:', missing.length ? missing.join(' ') : '（无）');

// 触发真实签到
console.log('\n=== 在页面上下文执行签到 fetch ===');
const result = await page.evaluate(async () => {
    try {
        const r = await fetch('https://api.juejin.cn/growth_api/v1/check_in', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });
        return { status: r.status, text: await r.text() };
    } catch (e) {
        return { error: e.message };
    }
});
console.log('RESULT:', JSON.stringify(result));

// 等所有响应读取完成再关浏览器
await Promise.all(pending);
await browser.close();
