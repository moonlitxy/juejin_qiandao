// tests/simulate-storage-sync.js
// 签到记录跨设备同步（background.js）测试
//
// 目标：
//   1. 签到成功后写入 chrome.storage.sync 的 checkin:YYYY-MM-DD
//   2. 本机不写 GitHub；回传相关函数已移除
//   3. 其他设备同步来的签到记录能合并进 checkInHistory
//   4. 同一天只保留一条，且不覆盖本机已有记录
//   5. 其他设备今天已签 → 本机补写 lastCheckInDate
//
// 用法：node tests/simulate-storage-sync.js
// 无第三方依赖。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const results = [];

function assert(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail != null && !cond ? '  ← ' + detail : ''}`);
}

const source = [
    fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'shared', 'date.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'),
].join('\n');

let store = {};
let syncStore = {};
let setCalls = [];
let fetchCalls = [];

const noopListener = { addListener() {} };
const chromeMock = {
    runtime: {
        onInstalled: noopListener,
        onStartup: noopListener,
        onMessage: noopListener,
        lastError: null,
    },
    alarms: {
        onAlarm: noopListener,
        create() {},
        clear() {},
    },
    storage: {
        local: {
            async get(keys) {
                if (typeof keys === 'string') {
                    return { [keys]: store[keys] };
                }
                const out = {};
                for (const key of Array.isArray(keys) ? keys : Object.keys(store)) {
                    out[key] = store[key];
                }
                return out;
            },
            async set(values) {
                setCalls.push(values);
                Object.assign(store, values);
            },
            async remove(key) {
                delete store[key];
            },
        },
        sync: {
            async get(keys) {
                if (keys == null) {
                    return syncStore;
                }
                const out = {};
                for (const key of Array.isArray(keys) ? keys : [keys]) {
                    out[key] = syncStore[key];
                }
                return out;
            },
            async set(values) {
                Object.assign(syncStore, values);
            },
            async remove(keys) {
                for (const key of Array.isArray(keys) ? keys : [keys]) {
                    delete syncStore[key];
                }
            },
        },
        session: {
            async get() { return {}; },
            async set() {},
            async remove() {},
        },
        onChanged: noopListener,
    },
    notifications: { create() {} },
    tabs: {
        async sendMessage() { throw new Error('not available'); },
        async remove() {},
    },
    scripting: {
        async executeScript() { return []; },
    },
};

async function runInSandbox(code) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        fetch: async (...args) => {
            fetchCalls.push(args);
            throw new Error('不应发起网络请求');
        },
        chrome: chromeMock,
        importScripts() {},
        TextEncoder,
        TextDecoder,
        Uint8Array,
        __out: {},
    };
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    await vm.runInContext(`${source}\n;(async () => { ${code} })()`, context);
    return sandbox.__out;
}

function dayKey(iso) {
    const date = new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
}

async function main() {
    console.log('掘金签到扩展 - 签到记录跨设备同步测试');
    console.log('');

    const todayIso = new Date().toISOString();
    const yesterdayIso = new Date(Date.now() - 86400000).toISOString();

    // 场景 1：签到成功写入 sync
    store = {
        config: {
            lastCheckInDate: null,
            checkInHistory: [],
            syncCheckIn: true,
        },
    };
    syncStore = {};
    await runInSandbox(`
        await updateCheckInHistory(
            { success: true, message: '签到成功' },
            (await chrome.storage.local.get('config')).config
        );
    `);
    const todaySyncKey = 'checkin:' + dayKey(todayIso);
    assert('签到成功后写入 checkin:YYYY-MM-DD',
        !!syncStore[todaySyncKey],
        JSON.stringify(syncStore));
    assert('同步记录 status=success',
        syncStore[todaySyncKey] && syncStore[todaySyncKey].status === 'success',
        JSON.stringify(syncStore[todaySyncKey]));

    // 场景 2：关闭 syncCheckIn 后不写
    store = {
        config: {
            lastCheckInDate: null,
            checkInHistory: [],
            syncCheckIn: false,
        },
    };
    syncStore = {};
    await runInSandbox(`
        await updateCheckInHistory(
            { success: true, message: '签到成功' },
            (await chrome.storage.local.get('config')).config
        );
    `);
    assert('关闭签到同步时不写 chrome.storage.sync',
        Object.keys(syncStore).length === 0,
        JSON.stringify(syncStore));

    // 场景 3：其他设备同步来的记录合并进历史
    store = {
        config: {
            lastCheckInDate: null,
            checkInHistory: [],
            syncCheckIn: true,
        },
    };
    syncStore = {
        ['checkin:' + dayKey(yesterdayIso)]: {
            date: yesterdayIso,
            status: 'success',
            message: '其他设备签到',
        },
    };
    let out = await runInSandbox(
        '__out.result = await syncCheckInRecordsFromStorage();');
    assert('合并其他设备记录返回 true', out.result === true, String(out.result));
    assert('其他设备记录进入 checkInHistory',
        store.config.checkInHistory.some(item => dayKey(item.date) === dayKey(yesterdayIso)),
        JSON.stringify(store.config.checkInHistory));
    assert('历史记录标记来源为 sync',
        store.config.checkInHistory.some(item => item.source === 'sync'),
        JSON.stringify(store.config.checkInHistory));

    // 场景 4：其他设备今天已签 → 补写 lastCheckInDate
    store = {
        config: {
            lastCheckInDate: null,
            checkInHistory: [],
            syncCheckIn: true,
        },
    };
    syncStore = {
        ['checkin:' + dayKey(todayIso)]: {
            date: todayIso,
            status: 'success',
            message: '其他设备签到',
        },
    };
    await runInSandbox('await syncCheckInRecordsFromStorage();');
    assert('其他设备今天已签时补写 lastCheckInDate',
        store.config.lastCheckInDate === new Date().toDateString(),
        String(store.config.lastCheckInDate));

    // 场景 5：同一天同步多次只保留一条
    store = {
        config: {
            lastCheckInDate: null,
            checkInHistory: [],
            syncCheckIn: true,
        },
    };
    syncStore = {
        ['checkin:' + dayKey(todayIso)]: {
            date: todayIso,
            status: 'success',
            message: '其他设备签到',
        },
    };
    await runInSandbox('await syncCheckInRecordsFromStorage();');
    await runInSandbox('await syncCheckInRecordsFromStorage();');
    assert('同一天同步多次只保留一条',
        store.config.checkInHistory.filter(item => dayKey(item.date) === dayKey(todayIso)).length === 1,
        JSON.stringify(store.config.checkInHistory));

    // 场景 6：不再包含本机写 GitHub 的函数，且 manifest 不再申请写权限
    out = await runInSandbox(`
        __out.hasLotteryPush = typeof syncLotteryResultToGitHub !== 'undefined';
        __out.hasCheckInPush = typeof syncCheckInResultToGitHub !== 'undefined';
    `);
    assert('本机抽奖回传函数已移除', out.hasLotteryPush === false, String(out.hasLotteryPush));
    assert('本机签到回传函数已移除', out.hasCheckInPush === false, String(out.hasCheckInPush));
    assert('同步签到不发起网络请求', fetchCalls.length === 0, `fetchCalls=${fetchCalls.length}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    assert('manifest 不再授予 GitHub 写接口权限',
        !manifest.host_permissions.includes('https://api.github.com/*'),
        JSON.stringify(manifest.host_permissions));

    console.log('');
    const failures = results.filter((item) => !item.pass);
    if (failures.length > 0) {
        console.error(`✗ 失败 ${failures.length} 项：`);
        for (const failure of failures) {
            console.error(`  - ${failure.name}: ${failure.detail}`);
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
