// tests/simulate-cloud-lottery.mjs
// 云端抽奖门禁测试：锁定「没有免费次数绝不调用 draw」。
//
// 用法：node tests/simulate-cloud-lottery.mjs
// 无第三方依赖。

'use strict';

import { runLottery } from '../scripts/cloud-lottery.mjs';

const results = [];
function assert(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail != null && !cond ? '  ← ' + detail : ''}`);
}

function response(body) {
    const text = JSON.stringify(body);
    return {
        ok: true,
        status: 200,
        text: async () => text
    };
}

function makeSession(config, draw) {
    const calls = [];
    return {
        calls,
        async run(fn, path) {
            calls.push(path);
            if (path.includes('lottery_config/get')) {
                return config;
            }
            if (path.includes('lottery/draw')) {
                return draw;
            }
            throw new Error(`未知请求: ${path}`);
        }
    };
}

async function main() {
    console.log('掘金云端抽奖 - 免费次数门禁测试');
    console.log('');

    // 场景 1：free_count=0 → skipped，且完全不调用 draw
    let session = makeSession(
        { err_no: 0, data: { free_count: 0 } },
        { err_no: 0, data: { lottery_name: '不应出现' } }
    );
    let result = await runLottery(session);
    assert('无免费次数时返回 skipped', result.status === 'skipped', JSON.stringify(result));
    assert('无免费次数时不调用 draw',
        !session.calls.some(path => path.includes('lottery/draw')),
        JSON.stringify(session.calls));

    // 场景 2：有免费次数且中奖
    session = makeSession(
        { err_no: 0, data: { free_count: 1 } },
        { err_no: 0, data: { lottery_name: '66矿石', lottery_image: 'https://x/y.png', lottery_type: 2 } }
    );
    result = await runLottery(session);
    assert('有免费次数时抽奖成功', result.status === 'won', JSON.stringify(result));
    assert('奖品名取自 lottery_name', result.prizeName === '66矿石', String(result.prizeName));
    assert('draw 带 aid=2608',
        session.calls.some(path => path.includes('lottery/draw?aid=2608')),
        JSON.stringify(session.calls));

    // 场景 3：查询配置失败 → failed，不调用 draw
    session = makeSession({ err_no: 500, err_msg: '服务异常' }, {});
    result = await runLottery(session);
    assert('查询次数失败时返回 failed', result.status === 'failed', JSON.stringify(result));
    assert('查询次数失败时不调用 draw',
        !session.calls.some(path => path.includes('lottery/draw')),
        JSON.stringify(session.calls));

    // 场景 4：配置接口空响应 → failed，不调用 draw
    session = makeSession({ empty: true }, {});
    result = await runLottery(session);
    assert('配置空响应时返回 failed', result.status === 'failed', JSON.stringify(result));
    assert('配置空响应时不调用 draw',
        !session.calls.some(path => path.includes('lottery/draw')),
        JSON.stringify(session.calls));

    // 场景 5：免费次数已用完（400）→ skipped
    session = makeSession(
        { err_no: 0, data: { free_count: 1 } },
        { err_no: 400, err_msg: '免费次数已用完' }
    );
    result = await runLottery(session);
    assert('err_no=400 归为 skipped', result.status === 'skipped', JSON.stringify(result));

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
