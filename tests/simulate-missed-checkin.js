// tests/simulate-missed-checkin.js
// 掘金签到扩展 background.js「过点未签巡查」逻辑测试
//
// 目标：不依赖真实浏览器，用 Node 的 vm 沙箱 + 假 chrome API 跑 background.js，
// 锁定巡查的核心契约：
//   1. 签到点已过 + 今天未签 + 自动签到开着 → 补签一次
//   2. 今天已签 → 不补
//   3. 还没到签到点 → 不补
//   4. 自动签到关闭 → 不补，且不在启动时创建巡查闹钟
//   5. 已有进行中的签到（pendingCheckInTrigger）→ 让路
//   6. 本次真正落库今日已签后，巡查闹钟被清掉（签到链路收工）
//
// 用法：node tests/simulate-missed-checkin.js
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

// ===== 假环境 =====
let store = {};
const alarms = {};
const alarmCreates = [];
const clearedAlarms = [];

// 所有"签到点"都用这个基准：当天 00:01 视为已过，23:59 视为未到（不依赖运行时刻）
function todayAt(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toTimeString().slice(0, 8);
}

const noopListener = { addListener() {} };
const chromeMock = {
    runtime: {
        onInstalled: noopListener,
        onStartup: noopListener,
        onMessage: noopListener,
    },
    alarms: {
        onAlarm: noopListener,
        create(name, info) {
            alarmCreates.push({ name, info });
            alarms[name] = info;
        },
        clear(name, cb) {
            clearedAlarms.push(name);
            delete alarms[name];
            if (cb) cb(true);
        },
        async get(name) {
            return alarms[name] ? { name } : undefined;
        },
    },
    storage: {
        local: {
            // 只把纯数据副本交给沙箱：沙箱对象与宿主对象不是同一 realm，
            // 传引用会让调用方拿到的对象在沙箱里“看起来不对”
            get(keys, cb) {
                const result = JSON.parse(JSON.stringify({ config: store.config }));
                if (cb) {
                    cb(result);
                    return undefined;
                }
                return Promise.resolve(result);
            },
            async set(obj) {
                Object.assign(store, obj);
            },
        },
        session: { async get() { return {}; }, async set() {}, async remove() {} },
        onChanged: noopListener,
    },
    notifications: { create() {} },
    tabs: { async create() { return { id: 1 }; }, async get() { return { id: 1, url: '' }; }, async remove() {}, sendMessage: noopListener },
    scripting: { async executeScript() { return []; } },
};

const source = [
    fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'shared', 'date.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'),
    // 测试里不看真实签到流程，只记录被补签了几次
    'let __performCalls = 0;',
    // 闹钟调用记录（在沙箱内记录，避免跨 realm 数组问题）
    'const __creates = []; const __clears = [];',
    'const __origCreate = chrome.alarms.create; chrome.alarms.create = (n, i) => { __creates.push({ name: n, info: i }); return __origCreate(n, i); };',
    'const __origClear = chrome.alarms.clear; chrome.alarms.clear = (...a) => { __clears.push(a[0]); return __origClear(...a); };',
    'async function performCheckIn() { __performCalls++; return { success: true }; }',
    // 测试里不调服务端，直接记录落库次数
        'async function syncConsecutiveDaysFromServer() { return false; }',
    'async function syncMonthCountFromServer() { return false; }',
].join('\n');

// 从 shared/config.js 取默认配置（与 background 用同一份定义）
const DEFAULT_CONFIG = vm.runInNewContext(
    fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf8') + '\n;DEFAULT_CONFIG;'
);

function createContext() {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
        chrome: chromeMock,
        importScripts() {},
        __out: {},
    };
    sandbox.globalThis = sandbox;
    return vm.createContext(sandbox);
}

async function runInSandbox(code) {
    const context = createContext();
    await vm.runInContext(`${source}\n;(async () => { ${code} })()`, context);
    return context.__out;
}

function reset(setup) {
    store = { config: { ...DEFAULT_CONFIG, ...setup } };
    alarmCreates.length = 0;
    clearedAlarms.length = 0;
    Object.keys(alarms).forEach(k => delete alarms[k]);
}

async function main() {
    console.log('掘金签到扩展 - 过点未签巡查测试');
    console.log('');

    // 场景 1：已过签到点、今天未签 → 补签
    reset({ checkInTime: todayAt('00:01'), lastCheckInDate: null, enabled: true });
    let out = await runInSandbox('await checkMissedCheckIn("测试"); __out.calls = __performCalls;');
    assert('已过签到点且未签到 → 补签一次', out.calls === 1, `calls=${out.calls}`);

    // 场景 2：今天已签 → 不补
    reset({ checkInTime: todayAt('00:01'), lastCheckInDate: new Date().toDateString(), enabled: true });
    out = await runInSandbox('await checkMissedCheckIn("测试"); __out.calls = __performCalls;');
    assert('今天已签到 → 不补签', out.calls === 0, `calls=${out.calls}`);

    // 场景 3：还没到签到点 → 不补
    reset({ checkInTime: todayAt('23:59'), lastCheckInDate: null, enabled: true });
    out = await runInSandbox('await checkMissedCheckIn("测试"); __out.calls = __performCalls;');
    assert('未到签到点 → 不补签', out.calls === 0, `calls=${out.calls}`);

    // 场景 4：自动签到关闭 → 不补，且启动时不清/不建巡查闹钟
    reset({ checkInTime: todayAt('00:01'), lastCheckInDate: null, enabled: false });
    out = await runInSandbox('await checkMissedCheckIn("测试"); __out.calls = __performCalls;');
    assert('自动签到关闭 → 不补签', out.calls === 0, `calls=${out.calls}`);
    out = await runInSandbox('setupDailyAlarm(); await new Promise(r => setTimeout(r, 10)); __out.creates = __creates; __out.clears = __clears;');
    assert('自动签到关闭时不创建巡查闹钟',
        !out.creates.some(a => a.name === 'missedCheckInWatch'),
        JSON.stringify(out.creates.map(a => a.name)));
    assert('自动签到关闭时清掉巡查闹钟', out.clears.includes('missedCheckInWatch'));

    // 场景 5：自动签到开启 → 创建 30 分钟周期巡查闹钟
    reset({ checkInTime: todayAt('00:01'), lastCheckInDate: null, enabled: true });
    out = await runInSandbox('setupDailyAlarm(); await new Promise(r => setTimeout(r, 10)); __out.creates = __creates;');
    const watch = out.creates.find(a => a.name === 'missedCheckInWatch');
    assert('自动签到开启时创建巡查闹钟', !!watch, JSON.stringify(out.creates));
    assert('巡查周期为 30 分钟', watch && watch.info.periodInMinutes === 30,
        watch && JSON.stringify(watch.info));

    // 场景 6：已有进行中的签到 → 让路
    reset({ checkInTime: todayAt('00:01'), lastCheckInDate: null, enabled: true });
    out = await runInSandbox('pendingCheckInTrigger = "auto"; await checkMissedCheckIn("测试"); __out.calls = __performCalls;');
    assert('已有进行中的签到 → 巡查让路', out.calls === 0, `calls=${out.calls}`);

    // 场景 7：真正落库今日已签后，巡查闹钟被清掉
    reset({ checkInTime: todayAt('00:01'), lastCheckInDate: null, enabled: true });
    out = await runInSandbox(`
        await updateCheckInHistory(
            { success: true, message: 'ok' },
            { ...DEFAULT_CONFIG, ...storeConfig, checkInHistory: [], enabled: true }
        );
        __out.last = (await chrome.storage.local.get('config')).config.lastCheckInDate; __out.clears = __clears;
    `.replace('storeConfig', JSON.stringify(store.config)));
    assert('本次签到后 lastCheckInDate 落库', out.last === new Date().toDateString(), out.last);
    assert('签到落库后清掉巡查闹钟', out.clears.includes('missedCheckInWatch'),
        JSON.stringify(out.clears));

    console.log('');
    const failed = results.filter(r => !r.pass).length;
    if (failed === 0) {
        console.log(`✓ 全部通过（${results.length} 项）`);
    } else {
        console.log(`✗ ${failed}/${results.length} 项失败`);
        process.exitCode = 1;
    }
}

main();
