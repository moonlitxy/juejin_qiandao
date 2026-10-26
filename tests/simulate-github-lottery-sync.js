// tests/simulate-github-lottery-sync.js
// 本机抽奖回传 GitHub 的测试：
//   1. 开关关闭 / 未配置 Token 时不发请求
//   2. 只合并中奖记录，保留云端已有记录
//   3. 同一奖品不重复写入
//   4. SHA 冲突时重新读取并重试一次
//
// 用法：node tests/simulate-github-lottery-sync.js
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
let requests = [];
let getResponses = [];
let putResponses = [];

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

function encode(text) {
    return Buffer.from(text, 'utf8').toString('base64');
}

function decode(text) {
    return Buffer.from(text, 'base64').toString('utf8');
}

const fetchMock = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (!options.method || options.method === 'GET') {
        return getResponses.shift() || response(500, {});
    }
    return putResponses.shift() || response(500, {});
};

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
                Object.assign(store, values);
            },
            async remove(key) {
                delete store[key];
            },
        },
        sync: {
            async get() { return {}; },
            async set() {},
            async remove() {},
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

function createContext() {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        fetch: fetchMock,
        chrome: chromeMock,
        importScripts() {},
        btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
        atob: (text) => Buffer.from(text, 'base64').toString('binary'),
        TextEncoder,
        TextDecoder,
        Uint8Array,
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

function fileBody(records) {
    const payload = {
        version: 1,
        updatedAt: '2026-10-26T00:00:00.000Z',
        latestCheckIn: { date: new Date().toISOString(), status: 'checked' },
        records,
    };
    return { sha: 'sha-1', content: encode(JSON.stringify(payload)) };
}

async function main() {
    console.log('掘金扩展 - 本机抽奖回传 GitHub 测试');
    console.log('');

    const record = {
        date: new Date().toISOString(),
        status: 'won',
        prizeName: '本机66矿石',
        message: '抽中 本机66矿石',
        freeCount: 1,
    };

    // 场景 1：开关关闭，不访问 GitHub
    store = {
        config: { githubLotterySync: false, githubRepo: 'moonlitxy/juejin_qiandao' },
        githubLotteryToken: 'github_pat_test',
    };
    requests = [];
    await runInSandbox(`await syncLotteryResultToGitHub(${JSON.stringify(record)});`);
    assert('开关关闭时不发请求', requests.length === 0, JSON.stringify(requests));

    // 场景 2：未配置 Token，不访问 GitHub
    store = {
        config: { githubLotterySync: true, githubRepo: 'moonlitxy/juejin_qiandao' },
    };
    requests = [];
    await runInSandbox(`await syncLotteryResultToGitHub(${JSON.stringify(record)});`);
    assert('未配置 Token 时不发请求', requests.length === 0, JSON.stringify(requests));

    // 场景 3：合并中奖记录并保留云端已有记录
    store = {
        config: { githubLotterySync: true, githubRepo: 'moonlitxy/juejin_qiandao' },
        githubLotteryToken: 'github_pat_test',
    };
    requests = [];
    const existing = {
        date: new Date().toISOString(),
        status: 'skipped',
        prizeName: null,
        message: '今日无免费抽奖机会',
    };
    getResponses = [response(200, fileBody([existing]))];
    putResponses = [response(200, { content: {} })];
    let out = await runInSandbox(`__out.result = await syncLotteryResultToGitHub(${JSON.stringify(record)});`);
    assert('回传成功返回 true', out.result === true, String(out.result));
    assert('使用 Bearer Token', requests[0].options.headers.Authorization === 'Bearer github_pat_test',
        JSON.stringify(requests[0].options.headers));

    const putBody = JSON.parse(requests[1].options.body);
    const uploaded = JSON.parse(decode(putBody.content));
    assert('保留云端已有记录', uploaded.records.some(item => item.status === 'skipped'),
        JSON.stringify(uploaded.records));
    assert('新增本机中奖记录', uploaded.records.some(item => item.prizeName === '本机66矿石'),
        JSON.stringify(uploaded.records));
    assert('记录标记来源为 extension',
        uploaded.records.find(item => item.prizeName === '本机66矿石').source === 'extension',
        JSON.stringify(uploaded.records));
    assert('提交时带文件 SHA', putBody.sha === 'sha-1', String(putBody.sha));

    // 场景 4：同一奖品不重复写入
    const alreadySynced = {
        ...record,
        runId: 'extension-1',
        source: 'extension',
    };
    getResponses = [response(200, fileBody([alreadySynced]))];
    putResponses = [];
    requests = [];
    out = await runInSandbox(`__out.result = await syncLotteryResultToGitHub(${JSON.stringify(record)});`);
    assert('重复奖品不写入', out.result === false && requests.length === 1,
        `result=${out.result}, requests=${requests.length}`);

    // 场景 5：SHA 冲突后重新读取并重试成功
    store = {
        config: { githubLotterySync: true, githubRepo: 'moonlitxy/juejin_qiandao' },
        githubLotteryToken: 'github_pat_test',
    };
    requests = [];
    getResponses = [
        response(200, { sha: 'old-sha', content: encode(JSON.stringify({ records: [] })) }),
        response(200, { sha: 'new-sha', content: encode(JSON.stringify({ records: [] })) }),
    ];
    putResponses = [
        response(409, { message: 'sha conflict' }),
        response(200, { content: {} }),
    ];
    out = await runInSandbox(`__out.result = await syncLotteryResultToGitHub(${JSON.stringify(record)});`);
    const secondPut = JSON.parse(requests[3].options.body);
    assert('冲突后重试成功', out.result === true, String(out.result));
    assert('重试使用最新 SHA', secondPut.sha === 'new-sha', String(secondPut.sha));

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
