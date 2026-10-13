# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

掘金(juejin.cn)自动签到浏览器扩展，使用 Chrome Extension Manifest V3 标准开发。

**技术栈**: JavaScript (ES6+), Chrome Extension APIs, DOM 操作

**版本**: v1.0.1（manifest.json 与 package.json 已统一）

## 快速开始

详细的安装和使用说明请查看：
- **用户指南**: [docs/QUICKSTART.md](docs/QUICKSTART.md)
- **文档索引**: [docs/README.md](docs/README.md)

**没有 lint / typecheck / build 步骤**。验证手段只有下面几种：

- `npm test` —— 跑 [tests/simulate-checkin-timing.js](tests/simulate-checkin-timing.js)（约 6 秒，无第三方依赖）。用 Node `vm` 沙箱 + 假 DOM/fetch 执行 `content.js`，7 个场景**并发**跑完整签到验证链，断言各自预算与「单场景最坏耗时 ≤ 8000ms」红线。改 `content.js` 的等待/轮询逻辑后必须跑。
- `npm run test:ab` —— 额外 `git show HEAD:content.js` 取旧版做 A/B 对比，仅供观察，不影响退出码。
- `npm run test:lottery` —— 跑 [tests/simulate-lottery.js](tests/simulate-lottery.js)（约 1 秒）。以 vm 沙箱 + 假 chrome API/fetch 加载 `background.js`，断言抽奖门禁（无免费次数不抽、也不发 draw 请求）、奖品名取自 `lottery_name`、`err_no:400` 归为跳过、当天已有中奖记录不被后续 skipped 覆盖。改抽奖逻辑后必须跑。
- `node e2e-checkin.js` —— 真机端到端（需先 `npm install` + `npx playwright install chromium`）。Playwright 用命令行 `--load-extension` 把插件装进独立临时 profile，跑 `manualCheckIn` 并断言 popup 文案。**必须用 Playwright 自带的 Chromium**：本机 Chrome 152+ 已彻底禁用命令行 `--load-extension`。首次运行需在弹出的窗口里登录掘金，登录态持久化在 `$TMPDIR/juejin-qiandao-e2e-profile`。
- 真机手动验证：`chrome://extensions` 开发者模式 → Load unpacked 加载本目录。

### 验证环境的已知陷阱

- **Playwright 复用的 profile 会缓存 background.js**：Chrome 会缓存扩展的 service worker 脚本，改完 `background.js` 重启仍跑旧代码；而 `content.js` 会正常更新，极易误判「改了没用」。`e2e-checkin.js` 已在启动前删掉 `Default/Service Worker`、`Default/Extension Scripts`（登录态不受影响）。手动调试时若 background 行为诡异，先怀疑这里。
- **`chrome://extensions` 手动重载同理**：改 `background.js` 后必须 terminate 并重载 service worker，否则跑的还是旧逻辑。
- **`.gitignore` 里有 `docs/`**，但现有文档都是当初 `git add -f` 强塞进去的。新增/修改 `docs/` 下的文件必须用 `git add -f`，否则静默被忽略。
- **`tests/` 目前未被 git 跟踪**（`git status` 显示 `?? tests/`），本地可跑但尚未提交。

## 项目架构

### 三层架构

```
┌─────────────────────────────────┐
│  用户界面层 (UI Layer)           │
│  - popup.html/js/css            │  快速操作界面
│  - options.html/js/css          │  设置页面
├─────────────────────────────────┤
│  后台服务层 (Background Layer)   │
│  - background.js                │  Service Worker
│  * 定时任务管理                 │
│  * 数据存储管理                 │
│  * 消息通信中枢                 │
├─────────────────────────────────┤
│  内容脚本层 (Content Layer)       │
│  - content.js                   │  注入到掘金页面
│  * 执行签到操作                 │
│  * 状态检测                     │
└─────────────────────────────────┘
```

### 共享脚本层 (Shared Layer)

```
shared/
  ├── config.js        # DEFAULT_CONFIG, CONFIG_KEYS
  ├── messaging.js     # sendMessage
  └── notification.js  # showPageNotification(+便捷方法 showSuccess/showError/showInfo)
```

无模块化、无 bundle，靠 manifest `content_scripts`、HTML `<script>` 标签、以及 service worker 的 `importScripts` 三种方式加载，用全局变量通信。**各脚本的可用范围不同**：

- `shared/config.js`：注入 content_scripts（manifest.json）、被 popup/options 的 HTML 引入，并由 **background.js 通过 `importScripts('shared/config.js')` 加载**（MV3 的 service worker 支持同步 importScripts）。
- `shared/messaging.js`、`shared/notification.js`：**仅** popup/options 的 HTML 引入。
- 全仓库**只有一份** `DEFAULT_CONFIG` 定义（在 `shared/config.js`）。新增配置字段只改这一处，并同步 `CONFIG_KEYS` 与所有读写点。
- `CONFIG_KEYS` 目前无调用方，但它是配置字段的键名清单，改字段时仍需同步维护。

### 文件职责

| 文件 | 职责 | 关键功能 |
|------|------|----------|
| **manifest.json** | 插件配置文件 | 声明权限、配置脚本注入、定义基本信息 |
| **background.js** | Service Worker 后台服务 | 定时任务(Alarms API)、消息通信、存储管理、标签页操作、API 降级签到 |
| **content.js** | 页面注入脚本 | 查找签到按钮、执行点击、检测签到状态、API 降级签到 |
| **popup.html/js/css** | 弹出窗口 | 快速签到、状态展示、统计信息、快速设置 |
| **options.html/js/css** | 设置页面 | 详细配置、签到日历、签到历史、高级设置、通知配置 |

## 核心技术实现

### 1. 定时签到机制

使用 Chrome Alarms API 实现每日定时签到（[background.js](background.js)）：
- `setupDailyAlarm()` - 按 config.checkInTime 计算下次触发时间，创建 `dailyCheckIn` 闹钟（周期 24h）。
- `chrome.alarms.onAlarm` 监听 `dailyCheckIn` 触发签到、`checkInRetry` 触发重试。
- `chrome.runtime.onStartup` 兜底 - 闹钟持久化官方「不保证」（重启可能被清），重复闹钟错过多次后周期还会漂移。故浏览器启动时补两件事：今日已过签到点且未签则立即补签；无条件 `setupDailyAlarm()` 把周期拉回设定的 wall-clock 时间（同名覆盖）。
- **注意**: Chrome 必须在运行状态才能触发定时任务。

### 2. 签到策略（多重选择器）

**签到入口已迁到沸点页 `/pins`**：background 直接打开 `https://juejin.cn/pins`（不再是旧的 checkin 页）。`background.js` 和 `content.js` **各有一份** `isCheckInPageUrl()`，都把 `pins|task|signin|checkin|lottery` 视为可签到页——改判定标准时两处必须同步。`/pins` 是 SPA，加载中会客户端跳转导致执行上下文销毁，e2e 脚本自带重试。

content.js 使用多重策略确保找到签到按钮：
- `findCheckInButton()` - 多组 CSS 选择器 + 全量可点击元素按文本优先级兜底。
- `findGoToCheckInButton()` - 首页"去签到"按钮。
- `isAlreadyCheckedIn()` - 按钮文本严格判断（"已签到/已打卡/明日再来"才算已签）。
- `findClaimButton()` - 签到后"领取矿石"按钮。

**按钮找不到时走 API 兜底，不要死磕 DOM 选择器**（掘金页面结构变化频繁，DOM 路径先失效但 API 通常仍可用）。

### 3. 消息通信机制

完整的 action 清单（改动作名时需同步所有引用处）：

```javascript
// background → content：就绪检测
chrome.tabs.sendMessage(tabId, { action: 'ping' })            // 返回 { action: 'pong' }
// background → content：执行签到
chrome.tabs.sendMessage(tabId, { action: 'checkIn' })         // 返回 result 对象
// background → content：抽奖 DOM 兜底（仅 API 抽奖失败且有免费次数时）
chrome.tabs.sendMessage(tabId, { action: 'lotteryDraw' })     // 返回 { status, prizeName?, message }

// popup/options → background（经 shared/messaging.js 的 sendMessage）
sendMessage({ action: 'getConfig' })
sendMessage({ action: 'updateConfig', config })
sendMessage({ action: 'manualCheckIn' })
sendMessage({ action: 'syncCheckInStatus' })   // popup 打开时与服务端核对今日签到状态
sendMessage({ action: 'getMonthCheckIn' })     // 设置页签到日历：本月逐日明细（数据以服务端 get_by_month 为准）
sendMessage({ action: 'getCurrentPoint' })     // popup 显示当前矿石总数（实时查 get_cur_point）
sendMessage({ action: 'getLotteryLog' })       // 设置页抽奖日志：本机流水 + 其他设备同步记录，按天聚合

// background → popup：签到完成后广播，popup 收到后重新 loadConfig 刷新 UI
chrome.runtime.sendMessage({ action: 'checkInCompleted', result })
```

**needRedirect 协议**：content.js 在首页发现"去签到"链接且无法在当前页完成时，返回 `{ success: false, needRedirect: true, redirectUrl }`，由 background 用 `chrome.tabs.update` 跳转后重试，而不是 content 自己跳转（避免页面上下文销毁）。

**manualCheckIn 返回协议**：background 回传真实签到结果，不再无条件返回 `{ success: true }`：

```javascript
{ success: true, alreadyCheckedIn: true, message: '今天已经签到过了' }  // 今日已签到
{ success: true, pending: true, message: '...' }                       // 已转入重试，结果待定
{ success: true, skipped: true, message: '自动签到已关闭' }              // 定时触发但开关关闭
{ success: false, message: '...' }                                     // 明确失败
```

`pending` 表示后台已把签到转入 alarms 重试，popup 需保持"签到中..."并等待 `checkInCompleted` 广播（带 90 秒超时兜底）。**失败同样会广播** `checkInCompleted`，所以 UI 以广播为准刷新状态，而不是以 `manualCheckIn` 的单次响应定生死。

**popup 的状态可能"假阴性"**：popup 判断今日是否已签只看本地 `config.lastCheckInDate`（`popup.js` 的 `updateCheckInStatus` 只比 `=== 今天`）。因此网页签到 / 多设备 / 重装后本地无记录时会误显示"未签到"。为此 popup 打开时调 `syncCheckInStatus`，由 background 直接 `fetch` 服务端核对（SW 里带 cookie 是通的），已签到则用 `updateCheckInHistory` 补写本地再刷新 UI；本地已有记录则直接返回，不重复写历史。

**updateConfig 合并语义**：background 收到 `updateConfig` 时先读取已存配置再合并（`{ ...DEFAULT_CONFIG, ...已存配置, ...传入字段 }`），因此调用方可以只提交部分字段。这点很关键——options.js 的 `saveConfig()` 只提交表单里的 6 项，若整体覆盖会抹掉 `lastCheckInDate` / `checkInHistory` / `consecutiveDays`。

### 4. 重复签到检测

针对多设备场景，使用多重检测机制：

1. **API 查询**（最准确）：调用掘金 API 查询今日签到状态
2. **页面文字检测**：查找"今日已签到"、"已经打卡"等文字
3. **按钮状态检测**：检查按钮文本和 disabled 属性
4. **服务端验证**：点击后检查返回的错误码（err_no: 10001 表示重复签到）

**重要**: 重复签到应返回 `{ success: true, alreadyCheckedIn: true }`，而不是错误。

### 5. API 降级与重试机制

签到链路包含两条相互独立的 API 降级路径（都要登录态，靠 `credentials: 'include'` 携带 cookie）：

- **content.js 侧**：验证预算（`VERIFY_BUDGET_MS`）内未确认签到后，调用 `attemptAPICheckIn()` 直接 POST 签到。
- **background.js 侧**（[background.js](background.js)）：content script 消息通道因页面跳转/刷新关闭时（`sendMessage` 抛错），先 `verifyCheckInViaApi()` 查询今日状态确认，未确认再 `attemptCheckInViaApi()` 直接签到——两者都通过 `chrome.scripting.executeScript` 注入 fetch。**消息通道关闭不等于失败**，一律先 API 验证。

**跨域 POST 必须用 `world:'MAIN'`（关键）**：内容脚本所在的隔离世界对 `api.juejin.cn` 的 **GET 能过、POST 被 CORS 拦**（报 `TypeError: Failed to fetch`）。所以 background 里 `verifyCheckInViaApi` / `attemptCheckInViaApi` 的 `chrome.scripting.executeScript` 必须带 `world:'MAIN'`，否则兜底直签永远不会成功。相应地，content.js 自带的 `attemptAPICheckIn()` 在隔离世界里发 POST 注定失败，属历史遗留，真正的兜底在 background。

**content.js 报失败 ≠ 签到失败**：`runCheckInAttempt` 收到 `success:false` 时，仍会再走一遍「API 验证 → API 直签」，两次都失败才判失败。

**重试机制跨 service worker 生命周期**：MV3 下 service worker 可能被随时终止，因此 `scheduleCheckInRetry()` 把 state（tabId/config/重试计数）持久化到 `chrome.storage.session`，再创建 `checkInRetry` 闹钟；闹钟触发时从 session 恢复 state 继续，用完即删。重试上限由 `config.retryCount` 驱动（options 可选 0-3 次）：`maxRetries = retryCount + 1`（含首次尝试），字段缺失或非法时回退默认 1 次重试。

**掘金 API 端点**：

| 端点 | 用途与判据 |
|---|---|
| `GET growth_api/v2/get_today_status` | 今日签到状态。**当前字段是 `check_in_done`**；`today_status` / `has_check_in` 已从响应中消失，代码保留兼容，新增判据以 `check_in_done` 为主 |
| `POST growth_api/v1/check_in` | `err_no === 0` 成功；`err_no === 10001` 或 `err_msg` 含"重复"/"已经"为重复签到 |
| `GET growth_api/v1/get_counts` | 服务端统计：`cont_count`=连续签到天数，`sum_count`=累计天数 |
| `GET growth_api/v1/get_by_month` | 本月逐日明细 `{date, status, point}` |
| `GET growth_api/v1/get_cur_point` | **当前矿石总数**（`data` 直接是数字）；**同时用它判登录态**：未登录返回 `err_no:403 must login` |
| `GET growth_api/v1/lottery_config/get` | 剩余免费抽奖次数：`data.free_count`（`free_time` / `lottery_free_count` 为兼容兜底） |
| `POST growth_api/v1/lottery/draw?aid=2608` | 抽奖：`err_no===0` 成功，奖品名在 `data.lottery_name`。**必须带 `?aid=2608`**（掘金 Web 端固定 app id），否则服务端返回无 CORS 头的响应，表现为 `Failed to fetch`。**`free_count=0` 时会改扣 200 矿石/次**，调用前务必先查免费次数 |

注意 `get_today_status` **未登录时也返回 `err_no:0`**，不能用它判断登录态。

`get_by_month` 的 `status`：**3=已签到**、2=漏签、4=未来；**今天的记录是独立 status（线上为 1）**，故今天是否算已签要用 `get_today_status` 的 `check_in_done` 判定，不能只看 `status===3`。

**签到后自动抽奖**：签到成功后 `finalizeCheckInSuccess` 调 `runLottery(tabId)`——先查 `free_count`，>0 才 `lottery/draw`，否则跳过。**两个接口都必须走页面主世界**（`chrome.scripting.executeScript` + `world:'MAIN'`）：`lottery_config/get` 在 SW 里直接 fetch 会拿到**空响应体**（`response.json()` 抛 "Unexpected end of JSON input"）；`lottery/draw` 还**必须带 `?aid=2608`**，否则同样表现为 `Failed to fetch`。免费次数字段确认为 `data.free_count`（已真机验证）。**`free_count = 0` 时 draw 会改扣 200 矿石/次**，所以 `runLottery` 在无免费次数时直接返回 `skipped`、绝不调 draw——这条由 `npm run test:lottery` 与 `scripts/verify-lottery.js` 双向守住。仅在「有次数但 API 抽奖失败」时才走 content.js 的 `lotteryDraw` DOM 兜底。抽奖 best-effort，任何异常都不影响签到结果；结果写入 `config.lotteryResult` / `lotteryHistory`，popup 只显示当天抽中的奖品。`autoLottery: false` 可关闭。

**签到终态先于抽奖播报**：`finalizeCheckInSuccess` 先 `notifySuccess` + 广播一次签到结果，再 await 抽奖，抽到奖品或失败时补第二次广播——避免抽奖的网络耗时压在签到关键路径上。

**popup 的「当前矿石」**：走 `getCurrentPoint` 消息实时查 `get_cur_point`，不落库。popup 打开时查一次；收到 `checkInCompleted` 广播后再查一次（签到、抽奖都可能改变点数，服务端已计入，无需本地累加）。未登录或查询失败时显示 `-`。

**抽奖记录的留存与同步**：本机流水存 `config.lotteryHistory`（最近90条，含 skipped / failed）。开启 `syncLottery` 时，抽奖后额外写 `chrome.storage.sync` 的 `lottery:YYYY-MM-DD`——**按天一个 key**，规避 sync 单项 8KB 限制（未登录 Chrome 账号时 sync 退化为本地存储，不报错）。设置页通过 `getLotteryLog` 取「本机流水 ∪ 已同步记录」，按天聚合（同一天优先 `won`），再由 `renderLotteryCalendar` 按选中年月铺成月历（默认当前月，可翻月）。

**签到日历做不到跨月（别再白试）**：掘金 `get_by_month` **不接受任何月份参数**——实测 `?month=2026-09`、`?year=2026&month=9`、`?date=`、`?query=` 等 7 种写法返回的是同一段数据（约 31 天）。服务端只提供这一段，插件本地也只有近 30 条 `checkInHistory`，所以签到日历只能显示服务端给的当前区间。抽奖日历不受此限，因为数据存在本机与 `chrome.storage.sync`。

**已知限制（重要）**：掘金**没有可用的个人抽奖记录接口**——`lottery_history/*` 前缀确实存在（打开 `juejin.cn/user/center/lottery` 时页面真实请求了 `global_small` / `global_big` / `lottery_lucky/my_lucky`），但它们走 `msToken` + `a_bogus` 风控签名，手动构造请求一律返回 `err_no:2 请求路由不存在`。因此**网页手动抽的奖无法被记录或同步**；跨设备同步的只是本插件抽的奖，且依赖用户在 Chrome 登录同一账号并开启同步。

**抽奖的幂等性靠 `free_count` 保证**：当天抽过后归零，再跑只会得到 `skipped`。因此不需要额外的「今天是否已抽」标志。注意「本地已记录今天签到」时 `performCheckIn` 会提前返回、不建标签页，也就不会抽奖——每天只抽一次。

### 6. 验证链的时间预算（关键约束）

MV3 的 service worker 空闲约 30 秒就会被浏览器终止，而 content script 的响应依赖 background 的消息通道。验证链一旦逼近这条红线，通道常被中途销毁，迫使 background 走那条复杂的 API 降级路径 —— 也就是说，**验证链过长才是那堆降级逻辑的真正病根**。

因此 content.js 顶部集中声明了时间预算常量，所有等待都受其约束（改等待时间请改常量，不要在函数里塞魔数）：

| 常量 | 值 | 作用 |
|---|---|---|
| `PAGE_READY_SETTLE_MS` | 500 | readyState 完成后的额外渲染等待 |
| `PAGE_READY_TIMEOUT_MS` | 3000 | 等待 load 事件的兜底上限（防永久挂起） |
| `CLICK_SETTLE_MS` | 600 | 点击后给签到请求发起的时间 |
| `CLAIM_BUTTON_BUDGET_MS` | 1200 | 等待"领取矿石"按钮的预算（可选步骤） |
| `VERIFY_BUDGET_MS` | 4500 | 签到结果验证总预算 |
| `VERIFY_INTERVAL_MS` | 700 | 每轮验证间隔 |
| `VERIFY_API_EVERY` | 2 | 每 N 轮才调一次状态 API |

验证流程为 `pollCheckInResult()` 轮询：每轮先做零成本的 `checkDomCheckInSignals()`（按钮文本 / 页面 toast / 重复签到文案），每隔 N 轮才调一次较慢的状态 API；**任一信号确认成功立即返回**。预算耗尽后再用 API 做最后一次确认，仍失败才交给 `attemptAPICheckIn()` 兜底。

实测（假 DOM/fetch 沙箱跑 `performActualCheckIn` 的端到端耗时，与 git HEAD 旧版对比）：

| 场景 | 改前 | 改后 |
|---|---|---|
| 快速成功（按钮立刻变"已签到"） | 8510ms | 2309ms |
| 慢速成功（API 2.5 秒后确认） | 10509ms | 3709ms |
| UI 未确认 + API 兜底成功 | 25267ms | 6113ms |
| 最坏情况（UI 未确认 + 兜底也失败） | 25268ms | 6107ms |
| 网络很慢（API 往返 1.5 秒） | 13010ms | 3304ms |
| 极晚确认（API 6 秒后才反映） | 10509ms | 6106ms |
| 重复签到（页面提示已签到） | 8508ms | 2307ms |

最坏耗时从 **25.3 秒压到 6.1 秒（-76%）**，成功路径普遍落在 2-4 秒。成功率未回退：即使 API 在验证预算之外才反映签到，兜底的 `attemptAPICheckIn()` 仍会命中 `err_no: 10001`（重复签到）并返回成功。

**调预算时不要只图快**：`VERIFY_BUDGET_MS` 调小会更快，但可能把慢签到误判为失败；兜底虽能救，却多一次写请求。改完请实测最坏耗时。

### 7. 数据存储结构

`chrome.storage.local` 存 `config` 对象（唯一定义见 [shared/config.js](shared/config.js)，background.js 通过 `importScripts` 复用同一份）：

```javascript
{
    config: {
        enabled: true,              // 自动签到开关（只拦截定时触发，手动签到始终放行）
        checkInTime: '09:00',       // 签到时间（变更时重设 dailyCheckIn 闹钟）
        lastCheckInDate: null,      // 最后签到日期（用于判断今日是否已签到）
        checkInHistory: [],         // 签到历史记录（最近30天）
        consecutiveDays: 0,         // 连续签到天数（以服务端 get_counts 的 cont_count 为准）
        monthCheckInCount: 0,       // 本月签到天数（以服务端 get_by_month 统计为准）
        monthCheckInMonth: null,    // 上面的统计所属月份（'YYYY-MM'，跨月需重新拉取）
        successNotification: true,  // 成功桌面通知开关（background notifySuccess 消费）
        failureNotification: true,  // 失败桌面通知开关（background notifyFailure 消费）
        retryCount: 1,              // 重试次数（maxRetries = retryCount + 1）
        loadTimeout: 30,            // 页面加载超时（秒，waitForTabLoaded 消费）
        autoLottery: true,          // 自动抽奖开关（仅签到成功后生效）
        lotteryResult: null,        // 最近一次抽奖结果（供 popup 渲染）
        lotteryHistory: [],         // 抽奖历史记录（最近90条，本机流水）
        syncLottery: true           // 抽奖记录同步到其他设备（chrome.storage.sync）
    }
}
```

`consecutiveDays` / `monthCheckInCount` **以服务端为准**，本地推算只是兜底：`syncConsecutiveDaysFromServer()` 用 `cont_count` 覆盖本地值（断签由服务端自行重置）；`syncMonthCountFromServer()` 用 `get_by_month` 统计。**调用顺序有讲究**：服务端同步必须排在 `updateCheckInHistory` **之后**，否则本地推算出的 0 会把服务端值冲掉（见 `finalizeCheckInSuccess` / `syncCheckInStatusFromServer`）。popup 侧用 `monthCheckInMonth === 'YYYY-MM'` 判断该统计是否可用于当前月，不符则回退本地历史推算。

另用 `chrome.storage.session` 存 `checkInRetry`（重试恢复状态，见上节）。

## 关键开发注意事项

### Manifest V3 特性
- 使用 `service_worker` 替代 `background page`（无持久化后台）
- 必须使用 Alarms API 实现定时任务（不能用 setInterval）
- Content Security Policy 更严格

### 签到流程

```
1. 触发签到（定时或手动）
   ↓
2. background.js 创建隐藏标签页并导航到 juejin.cn
   ↓
3. 等待页面加载完成（waitForTabLoaded，使用事件监听而非轮询）
   ↓
4. ping 检测 content script 就绪，未就绪则按 maxRetries 重试
   ↓
5. 发送 checkIn 消息给 content.js 执行签到
   ↓
6. content.js 查找并点击签到按钮，在时间预算内轮询验证结果（见「验证链的时间预算」）
   ↓
7. 通道关闭/失败时走 API 降级（先验证后直签）
   ↓
8. 更新签到历史和统计信息（传递 config 避免重复读取存储）
   ↓
9. 显示桌面通知，广播 checkInCompleted 给 popup
   ↓
10. 延迟3秒后关闭标签页
```

### 错误处理

1. **用户未登录**: 检测页面是否有登录按钮 / API 401，提示用户先登录
2. **网络错误**: 捕获 fetch 异常，显示具体错误信息
3. **按钮未找到**: 尝试 API 方式签到作为降级方案
4. **重复签到**: 优雅处理，显示"今天已经签到过了"

### 多设备场景处理

当用户在多台电脑上使用时：
- 每台设备的 `chrome.storage.local` 是独立的
- 点击签到前应先通过 API 或页面元素检测是否已签到
- 重复签到不应被视为错误，而是成功状态

## 性能优化

### 已实施的优化

1. **合并存储读取** - 传递 config 参数避免重复读取（`performCheckIn`、`loadConfig` 均返回/下发 config）
2. **事件监听替代轮询** - `waitForTabLoaded` 使用 chrome.tabs.onUpdated 而非轮询
3. **缓存 DOM 查询** - `checkDomCheckInSignals` 接收已找到的按钮元素避免重复查找（元素失效时按 `isConnected` 判定并重新查找）
4. **配置写入改为合并** - `updateConfig` 先读取已存配置再合并，调用方可只提交部分字段，避免每次保存设置都抹除签到历史
5. **验证链改为时间预算轮询** - `pollCheckInResult` 在固定预算内轮询，确认成功立即返回，取代原先「3 轮固定等待 2s/4s/6s」的串行结构；DOM 信号零成本每轮都采，较慢的状态 API 按 `VERIFY_API_EVERY` 节流
6. **复用上游状态查询** - `performActualCheckIn(statusKnown)` 接收调用方刚查到的签到状态，非 null 时跳过自身的重复 API 查询

### 性能提升数据

- 签到操作存储读取：3 次 → 1 次 (-67%)
- waitForTabLoaded 轮询：0-60 次 → 0 次 (-100%)
- DOM 查询次数：2 次 → 1 次 (-50%)
- 签到响应时间：~3.5s → ~2.5s (-29%)
- CPU 使用率：高 → 低 (-80%)

详细报告: [docs/代码审查优化报告.md](docs/代码审查优化报告.md)

## 常见修改场景

### 更新签到选择器

当掘金页面结构变化时，修改 [content.js](content.js) 中 `findCheckInButton()` / `findGoToCheckInButton()` 的选择器列表。若改动涉及「哪些 URL 算签到页」，记得 `background.js` 与 `content.js` 两份 `isCheckInPageUrl()` 同步。

### 修改定时任务逻辑

修改 [background.js](background.js) 中的 `setupDailyAlarm()` 函数。

### 调整通知设置

- 桌面通知底层实现: [background.js](background.js) - `showNotification()`（不检查开关）
- 受开关控制的通知入口: [background.js](background.js) - `notifySuccess()` / `notifyFailure()`，分别读 `config.successNotification` / `config.failureNotification`
- 页面通知: [shared/notification.js](shared/notification.js) - `showPageNotification()`

### 更新 UI 样式

- Popup 界面: [popup.css](popup.css)
- 设置界面: [options.css](options.css)

## 调试技巧

### 查看详细日志
所有脚本都包含详细的 console.log，可在开发者工具中查看执行流程（background 日志在 chrome://extensions 的 Service Worker 处）。

### 反查掘金页面 DOM
改选择器前可运行 `node analyze-juejin.js`（playwright 无头浏览器反查真实 DOM，输出到 `analysis-output/`）。注意页面结构/登录态变化会影响结果。

### 真机验证抽奖与接口字段

`scripts/` 下是需要真实登录态的手动验证脚本（与 `tests/` 的自动化测试区分）：

- `node scripts/verify-lottery.js` —— 有头浏览器实测「签到后自动抽奖」：复用 e2e profile（首次需在弹出窗口登录），查 `free_count`，有免费次数则由扩展的 service worker 真实调用 `runLottery`，并把 popup 截图到 `analysis-output/`。加 `MOCK=1` 可在无免费次数时注入模拟中奖记录，仅验证展示效果（不消耗真实次数）。
- `node scripts/check-lottery-config.js` —— 只读版，仅查 `lottery_config/get` 与 `get_cur_point` 的原始响应，用于核对字段名与登录态。

两者共用 `%TEMP%\juejin-qiandao-e2e-profile`，登录一次即可长期复用。

### 强制触发签到
```javascript
// 在浏览器控制台执行
chrome.runtime.sendMessage({ action: 'manualCheckIn' })
```

### 清空签到历史
在设置页面点击"清空历史记录"按钮。

### 测试重复签到
1. 在一台设备上手动签到
2. 在另一台设备上点击"立即签到"
3. 预期显示"今天已经签到过了"

## 浏览器兼容性

- 支持 Chrome（推荐）、Edge、Brave（均基于 Chromium）
- 不支持 Firefox（Manifest V3 支持有限）

## 权限说明

插件需要以下权限（在 manifest.json 中声明）：
- `storage`: 存储配置和历史记录（含 `chrome.storage.session`）
- `alarms`: 定时任务与重试
- `notifications`: 桌面通知
- `tabs`: 创建和操作标签页
- `scripting`: API 降级时向页面注入脚本执行 fetch
- `https://juejin.cn/*`, `https://*.juejin.cn/*`: 访问掘金网站及 API

## 项目依赖

扩展运行时无外部依赖（纯原生 JavaScript）。`package.json` 中的唯一依赖 `playwright` 仅用于开发调试：`analyze-juejin.js`、`e2e-checkin.js` 与 `scripts/` 下的验证脚本。

## 相关文档

### 用户文档
- [README.md](README.md) - 项目说明文档
- [docs/QUICKSTART.md](docs/QUICKSTART.md) - 快速开始指南
- [docs/README.md](docs/README.md) - 文档索引

### 开发文档
- [docs/SESSION_SUMMARY.md](docs/SESSION_SUMMARY.md) - 开发会话总结
- [docs/代码审查优化报告.md](docs/代码审查优化报告.md) - 性能优化报告

### 问题修复文档
- [docs/重复签到问题修复说明.md](docs/重复签到问题修复说明.md)
- [docs/签到检测逻辑修复说明.md](docs/签到检测逻辑修复说明.md)
- [docs/UI状态同步问题修复说明.md](docs/UI状态同步问题修复说明.md)
