// tests/simulate-checkin-stats.js
// 签到统计同步（background.js 的 syncConsecutiveDaysFromServer）测试
//
// 目标：锁定「连续签到天数 + 累计签到天数」都取自服务端 get_counts 的同一个响应：
//   - cont_count → config.consecutiveDays（断签由服务端重置）
//   - sum_count  → config.totalCheckInDays（累计总数，弹窗「累计签到天数」用它）
//   - 不额外多发请求：两项统计共用一次 get_counts
//   - 服务端失败时保留本地值，不清零
//   - 值没变化时不重复写存储（避免无谓的 storage 写入与闹钟重建）
//
// 用法：node tests/simulate-checkin-stats.js
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
let scenario = {};
let store = {};
let countsCalls = 0;
let setCalls = 0;

function jsonResponse(body, status = 200) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => body };
}

const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes('get_counts')) {
        countsCalls += 1;
        if (scenario.countsError) {
            return jsonResponse({ err_no: 500, err_msg: 'counts unavailable' });
        }
        return jsonResponse({
            err_no: 0,
            data: { cont_count: scenario.contCount, sum_count: scenario.sumCount },
        });
    }
    return jsonResponse({ err_no: 404 }, 404);
};

const noopListener = { addListener() {} };
const chromeMock = {
    runtime: { onInstalled: noopListener, onStartup: noopListener, onMessage: noopListener },
    alarms: { onAlarm: noopListener, create() {}, clear() {} },
    storage: {
        local: {
            async get(keys) {
                const pick = (k) => JSON.parse(JSON.stringify({ v: store[k] })).v;
                const out = {};
                for (const k of Array.isArray(keys) ? keys : [keys]) {
                    out[k] = pick(k);
                }
                return out;
            },
            async set(obj) {
                setCalls += 1;
                Object.assign(store, JSON.parse(JSON.stringify(obj)));
            },
        },
        sync: { async get() { return {}; }, async set() {} },
        session: { async get() { return {}; }, async set() {}, async remove() {} },
        onChanged: noopListener,
    },
    notifications: { create() {} },
    tabs: { async create() { return { id: 1 }; }, async get() { return {}; }, async remove() {}, sendMessage: noopListener },
    scripting: { async executeScript() { return []; } },
};

const source = [
    fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'shared', 'date.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'),
].join('\n');

async function runInSandbox(code) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout,
        fetch: fetchImpl,
        chrome: chromeMock,
        importScripts() {},
        __out: {},
    };
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    await vm.runInContext(`${source}\n;(async () => { ${code} })()`, context);
    return sandbox.__out;
}

function reset(setup) {
    store = { config: { consecutiveDays: 0, totalCheckInDays: 0, checkInHistory: [], ...setup } };
    countsCalls = 0;
    setCalls = 0;
}

async function main() {
    console.log('掘金签到扩展 - 签到统计同步测试');
    console.log('');

    // 场景 1：两项统计都按服务端写入
    reset({});
    scenario = { contCount: 3, sumCount: 372 };
    await runInSandbox('__out.r = await syncConsecutiveDaysFromServer();');
    assert('连续签到天数取自 cont_count', store.config.consecutiveDays === 3,
        `consecutiveDays=${store.config.consecutiveDays}`);
    assert('累计签到天数取自 sum_count', store.config.totalCheckInDays === 372,
        `totalCheckInDays=${store.config.totalCheckInDays}`);
    assert('两项统计只查一次 get_counts', countsCalls === 1, `calls=${countsCalls}`);

    // 场景 2：值没变时不写存储
    reset({ consecutiveDays: 3, totalCheckInDays: 372 });
    scenario = { contCount: 3, sumCount: 372 };
    const out2 = await runInSandbox('__out.r = await syncConsecutiveDaysFromServer();');
    assert('统计无变化时返回 false', out2.r === false, `r=${out2.r}`);
    assert('统计无变化时不写存储', setCalls === 0, `setCalls=${setCalls}`);

    // 场景 3：只有累计天数变化也要写入（不能只比较连续天数）
    reset({ consecutiveDays: 3, totalCheckInDays: 372 });
    scenario = { contCount: 3, sumCount: 373 };
    const out3 = await runInSandbox('__out.r = await syncConsecutiveDaysFromServer();');
    assert('仅累计天数变化时返回 true', out3.r === true, `r=${out3.r}`);
    assert('仅累计天数变化时写入存储', store.config.totalCheckInDays === 373,
        `totalCheckInDays=${store.config.totalCheckInDays}`);

    // 场景 4：服务端失败时保留本地值，不清零
    reset({ consecutiveDays: 5, totalCheckInDays: 400 });
    scenario = { countsError: true };
    const out4 = await runInSandbox('__out.r = await syncConsecutiveDaysFromServer();');
    assert('服务端失败时返回 false', out4.r === false, `r=${out4.r}`);
    assert('服务端失败时保留连续天数', store.config.consecutiveDays === 5,
        `consecutiveDays=${store.config.consecutiveDays}`);
    assert('服务端失败时保留累计天数', store.config.totalCheckInDays === 400,
        `totalCheckInDays=${store.config.totalCheckInDays}`);

    // 场景 5：sum_count 缺失时不动累计天数（只更新连续天数）
    reset({ consecutiveDays: 1, totalCheckInDays: 400 });
    scenario = { contCount: 6, sumCount: undefined };
    await runInSandbox('__out.r = await syncConsecutiveDaysFromServer();');
    assert('sum_count 缺失时仍更新连续天数', store.config.consecutiveDays === 6,
        `consecutiveDays=${store.config.consecutiveDays}`);
    assert('sum_count 缺失时保留累计天数', store.config.totalCheckInDays === 400,
        `totalCheckInDays=${store.config.totalCheckInDays}`);

    // 场景 6：传 baseConfig（签到成功路径）时同样写入两项
    reset({});
    scenario = { contCount: 9, sumCount: 500 };
    const out6 = await runInSandbox(`
        const base = { consecutiveDays: 0, totalCheckInDays: 0 };
        const r = await syncConsecutiveDaysFromServer(base);
        __out.r = r; __out.cont = base.consecutiveDays; __out.sum = base.totalCheckInDays;
    `);
    assert('baseConfig 路径更新连续天数', out6.cont === 9, `cont=${out6.cont}`);
    assert('baseConfig 路径更新累计天数', out6.sum === 500, `sum=${out6.sum}`);

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
