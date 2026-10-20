// tests/simulate-date-key.js
// 抽奖日期归属（shared/date.js）的跨时区一致性测试
//
// 目标：锁定「抽奖属于哪一天」只由 UTC+8 决定，与设备本地时区无关。
// 这是跨设备同步按天聚合（lottery:YYYY-MM-DD）的基础：
// 若按本机时区算，北京时间 10-21 00:30 抽的奖在 UTC-7 设备上会被归到 10-20。
//
// 用法：node tests/simulate-date-key.js
// 无第三方依赖。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATE_SOURCE = fs.readFileSync(path.join(ROOT, 'shared', 'date.js'), 'utf8');

// ===== 断言 =====
const results = [];
function assert(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail != null && !cond ? '  ← ' + detail : ''}`);
}

// 在沙箱里执行，取得 toLotteryDateKey
const context = vm.createContext({});
vm.runInContext(DATE_SOURCE + '\n;globalThis.__toKey = toLotteryDateKey;', context);
const toKey = (input) => context.__toKey(input);

// ===== 边界用例（均为 UTC 时间，标注对应的北京时间）=====
const cases = [
    // 北京时间 10-21 00:30 —— 最容易跨设备归错的一天
    ['2026-10-20T16:30:00.000Z', '2026-10-21', '北京时间 00:30 应归到 21 日'],
    // 北京时间 10-20 23:59:59
    ['2026-10-20T15:59:59.000Z', '2026-10-20', '北京时间 23:59:59 仍属 20 日'],
    // 北京时间 10-21 00:00:00 整
    ['2026-10-20T16:00:00.000Z', '2026-10-21', '北京时间整点进入 21 日'],
    // 跨年边界：北京时间 2027-01-01 00:00
    ['2026-12-31T16:00:00.000Z', '2027-01-01', '跨年边界'],
    // 跨月边界：北京时间 2026-11-01 00:00
    ['2026-10-31T16:00:00.000Z', '2026-11-01', '跨月边界'],
];

console.log('掘金签到扩展 - 抽奖日期归属测试');
console.log('');

for (const [input, expected, label] of cases) {
    const actual = toKey(input);
    assert(label, actual === expected, `输入 ${input} → ${actual}，期望 ${expected}`);
}

// Date 对象与毫秒时间戳也要支持
const ts = new Date('2026-10-20T16:30:00.000Z').getTime();
assert('接受 Date 对象', toKey(new Date(ts)) === '2026-10-21', String(toKey(new Date(ts))));
assert('接受毫秒时间戳', toKey(ts) === '2026-10-21', String(toKey(ts)));
assert('非法输入返回 null', toKey('not-a-date') === null, String(toKey('not-a-date')));

// ===== 关键：同一时刻在不同设备时区下必须得到同一个 key =====
// 用子进程切换 TZ 验证，覆盖西半球（UTC-7）、东半球（UTC+9）、UTC
const timezones = ['America/Los_Angeles', 'Asia/Shanghai', 'Asia/Tokyo', 'UTC'];
const probe = `
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(${JSON.stringify(path.join(ROOT, 'shared', 'date.js'))}, 'utf8');
const ctx = vm.createContext({});
vm.runInContext(src + ';globalThis.k = toLotteryDateKey;', ctx);
process.stdout.write(JSON.stringify([
  ctx.k('2026-10-20T16:30:00.000Z'),
  ctx.k('2026-10-20T15:59:59.000Z'),
  ctx.k('2026-12-31T16:00:00.000Z'),
]));
`;
for (const tz of timezones) {
    const out = execFileSync(process.execPath, ['-e', probe], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
    });
    const [k1, k2, k3] = JSON.parse(out);
    assert(`设备时区 ${tz}：归属日一致`,
        k1 === '2026-10-21' && k2 === '2026-10-20' && k3 === '2027-01-01',
        `${k1} / ${k2} / ${k3}`);
}

// ===== 汇总 =====
console.log('');
const failures = results.filter((r) => !r.pass);
if (failures.length > 0) {
    console.error(`✗ 失败 ${failures.length} 项`);
    for (const f of failures) {
        console.error(`  - ${f.name}: ${f.detail}`);
    }
    process.exitCode = 1;
} else {
    console.log(`✓ 全部通过（${results.length} 项）`);
}
