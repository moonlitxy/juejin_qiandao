// tests/simulate-lottery.js
// 掘金签到扩展 background.js「签到后自动抽奖」逻辑测试
//
// 目标：不依赖真实浏览器，用 Node 的 vm 沙箱 + 假 chrome API / 假 fetch 跑
// background.js 的抽奖链路，锁定核心契约：
//   1. free_count = 0 时跳过抽奖（不发 draw 请求）—— 「没有免费就不抽」
//   2. free_count > 0 且抽奖成功 → won，奖品名取自 lottery_name
//   3. 后端返回 err_no:400 → skipped（免费次数已用完）
//   4. 有次数但抽奖报错、DOM 兜底也不可用 → failed
//   5. 同一天已有 won 记录时，后续 skipped 不覆盖它（但历史仍记录）
//
// 用法：node tests/simulate-lottery.js
// 无第三方依赖。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// ===== 断言 =====
const results = [];
function assert(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail != null && !cond ? '  ← ' + detail : ''}`);
}

// ===== 可控的假环境 =====
// 每个场景通过 setScenario 调整：免费次数、draw 响应、DOM 兜底是否可用
let scenario = {};

function jsonResponse(body, status = 200) {
    const text = JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
        json: async () => body,
    };
}

// 假 fetch：只服务 lottery_config/get 与 lottery/draw（draw 由注入函数调用）
const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes('lottery_config/get')) {
        if (scenario.configError) {
            return jsonResponse({ err_no: 500, err_msg: 'config unavailable' });
        }
        return jsonResponse({ err_no: 0, data: { free_count: scenario.freeCount } });
    }
    if (target.includes('lottery/draw')) {
        scenario.drawCalls = (scenario.drawCalls || 0) + 1;
        return jsonResponse(scenario.drawResponse || { err_no: 0, data: {} });
    }
    return jsonResponse({ err_no: 404, err_msg: `未知请求: ${target}` }, 404);
};

// 内存版 chrome.storage.local
let store = {};
const storageLocal = {
    async get(keys) {
        if (typeof keys === 'string') {
            return { [keys]: store[keys] };
        }
        if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) {
                out[k] = store[k];
            }
            return out;
        }
        return { ...store };
    },
    async set(obj) {
        Object.assign(store, obj);
    },
};

const noopListener = { addListener() {} };

const chromeMock = {
    runtime: {
        onInstalled: noopListener,
        onStartup: noopListener,
        onMessage: noopListener,
    },
    alarms: {
        onAlarm: noopListener,
        create() {},
    },
    storage: {
        local: storageLocal,
        session: { async get() { return {}; }, async set() {}, async remove() {} },
        onChanged: noopListener,
    },
    notifications: { create() {} },
    tabs: {
        // DOM 兜底通道：默认不可用（抛错），模拟无 content script
        async sendMessage() {
            if (scenario.domFallback) {
                return scenario.domFallback;
            }
            throw new Error('Could not establish connection. Receiving end does not exist.');
        },
    },
    scripting: {
        // 直接执行被注入的函数体；其内部的 fetch 走上面的假 fetch
        async executeScript(opts) {
            const result = await opts.func();
            return [{ result }];
        },
    },
};

// 拼接 shared/config.js 与 background.js，保证顶层 const/function 同处一个作用域
// （importScripts 在真实 MV3 里同步加载 config.js，这里已在源码层面拼好）
const source = [
    fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'),
].join('\n');

function createContext() {
    const sandbox = {
        console: {
            log() {},
            warn() {},
            error() {},
        },
        setTimeout,
        clearTimeout,
        fetch: fetchImpl,
        chrome: chromeMock,
        importScripts() {}, // config.js 已拼接，无需真实加载
        __out: {},
    };
    sandbox.globalThis = sandbox;
    return vm.createContext(sandbox);
}

// 在沙箱内执行一段代码并取回 __out 的结果
// 源码与测试代码必须拼在同一个 script 里，顶层函数声明才可见
async function runInSandbox(code) {
    const context = createContext();
    await vm.runInContext(`${source}\n;(async () => { ${code} })()`, context);
    return context.__out;
}

// 今天（与 background.js 的 new Date().toDateString() 同口径）
const todayIso = new Date().toISOString();

async function main() {
    console.log('掘金签到扩展 - 自动抽奖逻辑测试');
    console.log('');

    // 场景 1：没有免费次数 → 跳过，且不发 draw 请求
    scenario = { freeCount: 0 };
    let out = await runInSandbox('__out.result = await runLottery(1);');
    assert('无免费次数时返回 skipped', out.result.status === 'skipped',
        JSON.stringify(out.result));
    assert('无免费次数时不发起抽奖请求', (scenario.drawCalls || 0) === 0,
        `drawCalls=${scenario.drawCalls}`);

    // 场景 2：有免费次数且抽中
    scenario = { freeCount: 1, drawResponse: { err_no: 0, data: { lottery_name: '66矿石', lottery_type: 2, lottery_image: 'https://x/y.png' } } };
    out = await runInSandbox('__out.result = await runLottery(1);');
    assert('抽中时返回 won', out.result.status === 'won', JSON.stringify(out.result));
    assert('奖品名取自 lottery_name', out.result.prizeName === '66矿石',
        `prizeName=${out.result.prizeName}`);

    // 场景 3：后端报 err_no:400（免费次数已用完）→ skipped
    scenario = { freeCount: 1, drawResponse: { err_no: 400, err_msg: '免费次数已用完' } };
    out = await runInSandbox('__out.result = await runLottery(1);');
    assert('err_no:400 归为 skipped', out.result.status === 'skipped', JSON.stringify(out.result));

    // 场景 4：有次数但抽奖报错，且 DOM 兜底不可用 → failed
    scenario = { freeCount: 1, drawResponse: { err_no: 500, err_msg: '服务异常' } };
    out = await runInSandbox('__out.result = await runLottery(1);');
    assert('抽奖报错且无兜底时返回 failed', out.result.status === 'failed',
        JSON.stringify(out.result));

    // 场景 5：同一天已有 won，后续 skipped 不覆盖 lotteryResult，但历史仍记录
    store = {
        config: {
            lotteryResult: { date: todayIso, status: 'won', prizeName: '徽章', message: '抽中 徽章' },
            lotteryHistory: [],
        },
    };
    await runInSandbox(`
        __out.result = await saveLotteryResult({
            status: 'skipped',
            prizeName: null,
            message: '今日无免费抽奖机会',
            freeCount: 0
        });
    `);
    const saved = store.config;
    assert('当天已有中奖时不被 skipped 覆盖', saved.lotteryResult.status === 'won',
        `status=${saved.lotteryResult.status}`);
    assert('中奖奖品名保留', saved.lotteryResult.prizeName === '徽章',
        `prizeName=${saved.lotteryResult.prizeName}`);
    assert('历史仍记录本次 skipped', saved.lotteryHistory[0].status === 'skipped',
        `history[0]=${JSON.stringify(saved.lotteryHistory[0])}`);

    // 汇总
    console.log('');
    const failures = results.filter((r) => !r.pass);
    if (failures.length > 0) {
        console.error(`✗ 失败 ${failures.length} 项：`);
        for (const f of failures) {
            console.error(`  - ${f.name}: ${f.detail}`);
        }
        process.exitCode = 1;
    } else {
        console.log(`✓ 全部通过（${results.length} 项）`);
    }
}

main().catch((error) => {
    console.error('测试运行异常:', error);
    process.exitCode = 1;
});
