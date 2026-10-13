// tests/simulate-checkin-timing.js
// 掘金签到扩展 content.js「签到验证链」耗时仿真测试
//
// 目标：不依赖真实浏览器，用 Node 的 vm 沙箱 + 假 DOM / 假 fetch 跑 content.js
// 的完整签到链路，覆盖速度不同的多种场景，断言：
//   1. 每个场景结果符合预期（成功 / 重复签到 / 明确失败）
//   2. 每个场景耗时不超过各自预算
//   3. 最坏耗时不超过 8 秒（历史红线：改前 25.3s → 改后 6.1s）
//
// 用法：
//   npm test            # 只跑当前工作区 content.js
//   npm run test:ab     # 额外取 git HEAD 版本做 A/B 对比（仅供观察，不影响退出码）
//   VERBOSE=1 npm test  # 额外打印 content.js 内部的 console 日志
//
// 无第三方依赖，直接 node 运行。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// 默认测工作区的 content.js；CONTENT_FILE 可指向别的文件，便于做回归/负向验证
const CONTENT_PATH = process.env.CONTENT_FILE
    ? path.resolve(ROOT, process.env.CONTENT_FILE)
    : path.join(ROOT, 'content.js');

const VERBOSE = !!process.env.VERBOSE;
// AB 对比：兼容 --ab 参数与 AB 环境变量（后者在 Windows npm 下不可用，保留向后兼容）
const AB = process.argv.includes('--ab') || !!process.env.AB;

// 硬性红线：任何单个场景耗时都不得超过该值（毫秒）
const WORST_CASE_BUDGET_MS = 8000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 伪造一个 content.js 能识别的 fetch Response
function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

// content.js 采集 toast / modal 文案时用到的选择器
const MESSAGE_SELECTORS = [
    '.message', '.toast', '.notification', '.alert', '.modal', '.popup',
    '[class*="message"]', '[class*="toast"]', '[role="alert"]', '[role="status"]',
];

// 极简假元素：只实现 content.js 真正读写的属性与方法
class FakeElement {
    constructor(opts = {}) {
        this.tagName = opts.tagName || 'BUTTON';
        this.className = opts.className || '';
        this.id = opts.id || '';
        this.href = opts.href || undefined;
        this.disabled = opts.disabled || false;
        this.isConnected = opts.isConnected !== false;
        this.offsetParent = {}; // 非 null 表示"可见"
        this._text = opts.text || '';
    }
    get textContent() { return this._text; }
    set textContent(value) { this._text = value; }
    get innerText() { return this._text; }
    getAttribute() { return null; }
    click() { /* 默认无副作用，场景可覆盖 */ }
    dispatchEvent() { this.click(); return true; }
}

// ===== 场景定义 =====
// 每个场景通过 configure(env) 调整假环境：
//   env.buttonText     —— 签到按钮文本（点击后可改，用于模拟 DOM 状态变化）
//   env.buttonGone     —— 点击后按钮从页面消失（用于模拟页面重渲染）
//   env.pageText       —— document.body 文本
//   env.onClickButton  —— 点击签到按钮时的副作用
//   env.isCheckedIn()  —— get_today_status 返回的今日签到状态
//   env.postResult()   —— POST check_in 的响应体
//   env.apiLatencyMs   —— 每次 API 往返耗时（模拟慢网络）
const SCENARIOS = [
    {
        name: '快速成功（点击后按钮立刻变已签到）',
        budgetMs: 4000,
        verify: (r) => !!r && r.success === true,
        configure(env) {
            env.onClickButton = () => { env.buttonText = '已签到'; };
            env.isCheckedIn = () => false;
            env.postResult = () => ({ err_no: 0 });
        },
    },
    {
        name: '慢速成功（API 2.5 秒后才确认）',
        budgetMs: 7000,
        verify: (r) => !!r && r.success === true,
        configure(env) {
            env.isCheckedIn = () => env.clickedAt > 0 && Date.now() - env.clickedAt >= 2500;
            env.postResult = () => ({ err_no: 0 });
        },
    },
    {
        name: 'UI 未确认 + API 直签兜底成功',
        budgetMs: 8000,
        verify: (r) => !!r && r.success === true,
        configure(env) {
            env.isCheckedIn = () => false;
            env.postResult = () => ({ err_no: 0 });
        },
    },
    {
        name: '最坏情况（UI 未确认 + 兜底也失败）',
        budgetMs: 8000,
        verify: (r) => !!r && r.success === false,
        configure(env) {
            env.isCheckedIn = () => false;
            env.postResult = () => ({ err_no: 500, err_msg: '服务异常' });
        },
    },
    {
        name: '网络很慢（每次 API 往返 1.5 秒）',
        budgetMs: 8000,
        verify: (r) => !!r && r.success === true,
        configure(env) {
            env.apiLatencyMs = 1500;
            env.isCheckedIn = () => env.clickedAt > 0 && Date.now() - env.clickedAt >= 1500;
            env.postResult = () => ({ err_no: 0 });
        },
    },
    {
        name: '极晚确认（API 6 秒后才反映，超出验证预算）',
        budgetMs: 8000,
        verify: (r) => !!r && r.success === true,
        configure(env) {
            // 验证预算（VERIFY_BUDGET_MS=4500）内始终查不到，最终靠 POST 兜底
            env.isCheckedIn = () => env.clickedAt > 0 && Date.now() - env.clickedAt >= 6000;
            env.postResult = () => ({ err_no: 0 });
        },
    },
    {
        name: '重复签到（页面提示今日已签到）',
        budgetMs: 4000,
        verify: (r) => !!r && r.success === true && r.alreadyCheckedIn === true,
        configure(env) {
            // 点击后按钮消失、页面出现"今日已签到"文案 → 走页面文字判定
            env.onClickButton = () => { env.buttonGone = true; env.pageText = '今日已签到'; };
            env.isCheckedIn = () => false;
            env.postResult = () => ({ err_no: 10001, err_msg: '重复签到' });
        },
    },
];

// 创建隔离的沙箱：每个场景一份，避免共享 DOM / fetch 互相污染
function createSandbox(source, scenario) {
    const env = {
        buttonText: '立即签到',
        buttonGone: false,
        pageText: '',
        messages: [],
        statusQueries: 0,
        clickedAt: 0,
        apiLatencyMs: 0,
        onClickButton: null,
        // 默认接口行为，场景通过 configure 覆盖
        isCheckedIn: () => false,
        postResult: () => ({ err_no: 500, err_msg: '未配置的默认失败' }),
    };
    scenario.configure(env);

    // 签到按钮：文本与 isConnected 都随场景状态变化
    const checkInButton = new FakeElement({ className: 'signin-btn' });
    Object.defineProperty(checkInButton, 'textContent', {
        get: () => env.buttonText,
        configurable: true,
    });
    Object.defineProperty(checkInButton, 'isConnected', {
        get: () => !env.buttonGone,
        configurable: true,
    });
    checkInButton.click = () => {
        env.clickedAt = Date.now();
        if (env.onClickButton) {
            env.onClickButton();
        }
    };

    // 领取矿石按钮始终存在 → waitForClaimButton 立即返回，不空耗预算
    const claimButton = new FakeElement({ className: 'claim-btn', text: '领取矿石' });

    const bodyEl = {};
    Object.defineProperty(bodyEl, 'textContent', {
        get: () => env.pageText,
        configurable: true,
    });

    const signinNodes = () => (env.buttonGone ? [] : [checkInButton]);

    const document = {
        readyState: 'complete',
        body: bodyEl,
        head: { appendChild() {} },
        addEventListener() {},
        createElement(tag) { return new FakeElement({ tagName: String(tag).toUpperCase() }); },
        querySelector(sel) {
            // 仅用于登录态检测：返回一个用户头像元素即视为已登录
            if (sel === '.user-avatar') return new FakeElement();
            return null;
        },
        querySelectorAll(sel) {
            if (sel === '.signin-btn') return signinNodes();
            if (sel === 'button, .btn, a, [onclick], [class*="button"]') {
                return env.buttonGone ? [claimButton] : [checkInButton, claimButton];
            }
            if (sel === 'button, .btn, [class*="button"]') return [claimButton];
            if (sel === 'a, button, .btn') return signinNodes();
            if (MESSAGE_SELECTORS.includes(sel)) {
                return env.messages.map((text) => new FakeElement({ text }));
            }
            return [];
        },
    };

    // 假 fetch：get_today_status 走 env.isCheckedIn()，check_in 走 env.postResult()
    const fetchImpl = async (url) => {
        const target = String(url);
        if (target.includes('get_today_status')) {
            env.statusQueries++;
            if (env.apiLatencyMs > 0) await sleep(env.apiLatencyMs);
            return jsonResponse({ err_no: 0, data: { check_in_done: env.isCheckedIn() } });
        }
        if (target.includes('/check_in')) {
            if (env.apiLatencyMs > 0) await sleep(env.apiLatencyMs);
            return jsonResponse(env.postResult());
        }
        return jsonResponse({ err_no: 404, err_msg: `未知请求: ${target}` }, 404);
    };

    const sandbox = {
        console: {
            log(...args) { if (VERBOSE) console.log('[content]', ...args); },
            warn(...args) { if (VERBOSE) console.warn('[content]', ...args); },
            error(...args) { if (VERBOSE) console.error('[content]', ...args); },
        },
        setTimeout,
        clearTimeout,
        fetch: fetchImpl,
        document,
        location: { href: 'https://juejin.cn/checkin' },
        MouseEvent: class MouseEvent {
            constructor(type, init) { this.type = type; Object.assign(this, init || {}); }
        },
        chrome: {
            runtime: {
                onMessage: {
                    addListener(fn) { env.listener = fn; },
                },
            },
        },
    };
    sandbox.window = sandbox;

    const context = vm.createContext(sandbox);
    vm.runInContext(source, context, { filename: 'content.js' });
    return { env };
}

// 跑一个场景：通过 content.js 注册的 onMessage 监听器触发 checkIn，并计时
async function runScenario(source, scenario) {
    const { env } = createSandbox(source, scenario);
    if (typeof env.listener !== 'function') {
        throw new Error('content.js 未注册 onMessage 监听器，无法触发签到');
    }

    const startedAt = Date.now();
    let result = null;
    let error = null;
    try {
        result = await new Promise((resolve) => {
            env.listener({ action: 'checkIn' }, {}, resolve);
        });
    } catch (e) {
        error = e;
    }
    return { scenario, result, error, elapsed: Date.now() - startedAt };
}

// 并发跑完一套场景（总耗时 ≈ 最慢场景，而非累加）
async function runSuite(source) {
    return Promise.all(SCENARIOS.map((scenario) => runScenario(source, scenario)));
}

// 单行结果格式化
function formatRow(r) {
    const reason = judge(r);
    const status = reason ? 'FAIL' : 'PASS';
    const line = `  [${status}] ${String(r.elapsed).padStart(5)}ms / ${String(r.scenario.budgetMs).padStart(4)}ms  ${r.scenario.name}`;
    return reason ? `${line}  ← ${reason}` : line;
}

// 判定单个场景是否通过；通过返回 null，否则返回原因
function judge(r) {
    if (r.error) return `异常: ${r.error.message}`;
    if (!r.scenario.verify(r.result)) return `结果不符: ${JSON.stringify(r.result)}`;
    if (r.elapsed > r.scenario.budgetMs) return `超预算 ${r.elapsed}ms > ${r.scenario.budgetMs}ms`;
    return null;
}

// 读取 git HEAD 版本的 content.js（供 A/B 对比）
function readHeadContent() {
    try {
        return execFileSync('git', ['show', 'HEAD:content.js'], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
        return null;
    }
}

async function main() {
    const source = fs.readFileSync(CONTENT_PATH, 'utf8');

    console.log('掘金签到 content.js 验证链耗时仿真');
    console.log(`红线：单场景最坏耗时 ≤ ${WORST_CASE_BUDGET_MS}ms；共 ${SCENARIOS.length} 个场景并发执行`);
    console.log('');

    const results = await runSuite(source);

    const failures = [];
    for (const r of results) {
        const reason = judge(r);
        if (reason) failures.push({ name: r.scenario.name, reason });
        console.log(formatRow(r));
    }

    const worst = results.reduce((max, r) => Math.max(max, r.elapsed), 0);
    console.log('');
    console.log(`最坏耗时：${worst}ms`);

    if (worst > WORST_CASE_BUDGET_MS) {
        failures.push({
            name: '全局红线',
            reason: `最坏耗时 ${worst}ms 超过 ${WORST_CASE_BUDGET_MS}ms`,
        });
    }

    // A/B 对比：仅作观察，不影响退出码
    if (AB) {
        console.log('');
        const head = readHeadContent();
        // Windows 检出为 CRLF、git show 输出 LF，比较前统一换行符，避免误报差异
        const normalize = (text) => text.replace(/\r\n/g, '\n');
        if (!head) {
            console.log('[AB] 无法读取 git HEAD 版本 content.js，跳过对比');
        } else if (normalize(head) === normalize(source)) {
            console.log('[AB] 工作区与 git HEAD 的 content.js 相同，无对比差异');
        } else {
            console.log('[AB] 对比 git HEAD 旧版本：');
            const headResults = await runSuite(head);
            for (const r of headResults) {
                console.log(formatRow(r));
            }
            const headWorst = headResults.reduce((max, r) => Math.max(max, r.elapsed), 0);
            console.log(`[AB] HEAD 最坏耗时：${headWorst}ms（仅供参考）`);
        }
    }

    console.log('');
    if (failures.length > 0) {
        console.error(`✗ 失败 ${failures.length} 项：`);
        for (const f of failures) {
            console.error(`  - ${f.name}: ${f.reason}`);
        }
        process.exitCode = 1;
    } else {
        console.log('✓ 全部通过');
    }
}

main().catch((error) => {
    console.error('测试运行异常:', error);
    process.exitCode = 1;
});
