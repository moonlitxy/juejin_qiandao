// tests/simulate-tab-close.js
// 掘金签到扩展「签到标签页自动关闭」回归测试
//
// 用 Node 的 vm 沙箱 + 假 chrome API 跑 background.js，锁定：
//   1. closeTabQuietly 会记 orphanTabId 并挂 closeCheckInTab 闹钟
//   2. 计时器到点真正关闭标签页，并清掉兜底记录/闹钟
//   3. cleanupOrphanTab 只关仍是掘金页的 tab（防 id 复用误关）
//   4. 成功路径（content 响应 / API 兜底验证）都会安排关闭标签页
//   5. 失败路径立即关闭标签页
//
// 用法：node tests/simulate-tab-close.js
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
let session = {};
const alarms = {};
const alarmCreates = [];
const clearedAlarms = [];
const tabMap = {};
const removedTabs = [];

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
            return Promise.resolve(true);
        },
        async get(name) {
            return alarms[name] ? { name } : undefined;
        },
    },
    storage: {
        local: {
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
        session: {
            async get(key) {
                if (typeof key === 'string') {
                    return Object.prototype.hasOwnProperty.call(session, key)
                        ? { [key]: session[key] }
                        : {};
                }
                return { ...session };
            },
            async set(obj) {
                Object.assign(session, obj);
            },
            async remove(key) {
                if (typeof key === 'string') {
                    delete session[key];
                } else if (Array.isArray(key)) {
                    key.forEach(k => delete session[k]);
                }
            },
        },
        onChanged: noopListener,
    },
    notifications: { create() {} },
    tabs: {
        async create() { return { id: 1 }; },
        async get(tabId) {
            if (!tabMap[tabId]) {
                throw new Error(`No tab with id: ${tabId}`);
            }
            return tabMap[tabId];
        },
        async remove(tabId) {
            removedTabs.push(tabId);
            delete tabMap[tabId];
        },
        sendMessage: noopListener,
    },
    scripting: { async executeScript() { return []; } },
};

// 覆盖签到链路的网络/落库副作用，只观察标签页关闭行为
const source = [
    fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'shared', 'date.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'),
    'async function updateCheckInHistory() {}',
    'async function syncConsecutiveDaysFromServer() { return false; }',
    'async function syncMonthCountFromServer() { return false; }',
    'function notifySuccess() {}',
    'function broadcastCheckInResult() {}',
    'async function runLottery() { return { status: "skipped", message: "test" }; }',
    'async function saveLotteryResult() { return null; }',
].join('\n');

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

function reset() {
    store = { config: { ...DEFAULT_CONFIG, autoLottery: false } };
    session = {};
    alarmCreates.length = 0;
    clearedAlarms.length = 0;
    Object.keys(alarms).forEach(k => delete alarms[k]);
    Object.keys(tabMap).forEach(k => delete tabMap[k]);
    removedTabs.length = 0;
}

async function main() {
    console.log('掘金签到扩展 - 签到标签页关闭测试');
    console.log('');

    // 场景 1：closeTabQuietly 记录兜底信息并挂闹钟
    reset();
    tabMap[11] = { id: 11, url: 'https://juejin.cn/pins' };
    let out = await runInSandbox(`
        closeTabQuietly(11, 20);
        __out.orphan = (await chrome.storage.session.get('orphanTabId')).orphanTabId;
    `);
    assert('closeTabQuietly 写入 orphanTabId', out.orphan === 11, `orphan=${out.orphan}`);
    const closeAlarm = alarmCreates.find(a => a.name === 'closeCheckInTab');
    assert('closeTabQuietly 创建 closeCheckInTab 闹钟', !!closeAlarm,
        JSON.stringify(alarmCreates.map(a => a.name)));

    // 场景 2：计时器到点关闭标签页并清理兜底记录/闹钟
    await new Promise(resolve => setTimeout(resolve, 80));
    out = await runInSandbox('__out.orphan = (await chrome.storage.session.get("orphanTabId")).orphanTabId;');
    assert('计时器到点关闭标签页', removedTabs.includes(11), JSON.stringify(removedTabs));
    assert('关闭后清掉 orphanTabId', out.orphan === undefined, `orphan=${out.orphan}`);
    assert('关闭后清掉 closeCheckInTab 闹钟', !alarms.closeCheckInTab,
        JSON.stringify(Object.keys(alarms)));

    // 场景 3：cleanupOrphanTab 只关掘金页，不误关用户当前页面
    reset();
    session.orphanTabId = 21;
    tabMap[21] = { id: 21, url: 'https://example.com/' };
    out = await runInSandbox('await cleanupOrphanTab(); __out.orphan = (await chrome.storage.session.get("orphanTabId")).orphanTabId;');
    assert('id 被复用成非掘金页时不关闭', !removedTabs.includes(21), JSON.stringify(removedTabs));
    assert('非掘金页也清掉过期的 orphanTabId', out.orphan === undefined, `orphan=${out.orphan}`);

    reset();
    session.orphanTabId = 22;
    tabMap[22] = { id: 22, url: '', pendingUrl: 'https://juejin.cn/pins' };
    await runInSandbox('await cleanupOrphanTab();');
    assert('页面仍在加载时按 pendingUrl 关闭', removedTabs.includes(22), JSON.stringify(removedTabs));

    // 场景 4：成功路径（content 响应）安排关闭
    reset();
    out = await runInSandbox(`
        await finalizeCheckInSuccess({ success: true, message: 'ok' }, { ...DEFAULT_CONFIG, autoLottery: false }, 31);
        __out.orphan = (await chrome.storage.session.get('orphanTabId')).orphanTabId;
    `);
    assert('签到成功（content 响应）安排关闭标签页', out.orphan === 31, `orphan=${out.orphan}`);
    assert('签到成功时创建关闭闹钟', alarmCreates.some(a => a.name === 'closeCheckInTab'),
        JSON.stringify(alarmCreates.map(a => a.name)));

    // 场景 5：成功路径（API 兜底验证）同样安排关闭——本次修复的核心回归点
    reset();
    out = await runInSandbox(`
        const verified = await finalizeIfApiVerified({ success: true, message: 'ok' }, { ...DEFAULT_CONFIG, autoLottery: false }, 32);
        __out.orphan = (await chrome.storage.session.get('orphanTabId')).orphanTabId;
        __out.ok = !!(verified && verified.success);
    `);
    assert('API 兜底验证成功时返回成功结果', out.ok === true, `ok=${out.ok}`);
    assert('API 兜底验证成功也安排关闭标签页', out.orphan === 32, `orphan=${out.orphan}`);

    // 场景 6：失败路径立即关闭
    reset();
    tabMap[41] = { id: 41, url: 'https://juejin.cn/pins' };
    await runInSandbox(`finalizeCheckInFailure('boom', { ...DEFAULT_CONFIG }, 41);`);
    assert('签到失败立即关闭标签页', removedTabs.includes(41), JSON.stringify(removedTabs));

    // 清理场景 1/4/5 留下的 3 秒计时器，避免进程被拖住
    await new Promise(resolve => setTimeout(resolve, 3200));

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
