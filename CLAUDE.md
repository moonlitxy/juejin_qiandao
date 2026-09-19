# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

掘金(juejin.cn)自动签到浏览器扩展，使用 Chrome Extension Manifest V3 标准开发。

**技术栈**: JavaScript (ES6+), Chrome Extension APIs, DOM 操作

**版本**: v1.0.1（以 manifest.json 为准；package.json 仍为 1.0.0）

## 快速开始

详细的安装和使用说明请查看：
- **用户指南**: [docs/QUICKSTART.md](docs/QUICKSTART.md)
- **文档索引**: [docs/README.md](docs/README.md)

**没有 lint / typecheck / build 步骤**。测试用 `npm test`（约 6 秒，无第三方依赖）：以 vm 沙箱 + 假 DOM/fetch 跑 `content.js`，断言签到验证链最坏耗时 ≤ 8 秒；`npm run test:ab` 对比 git HEAD 旧版本。改动 `content.js` 的等待/轮询逻辑后必须跑。真实验证仍需 `chrome://extensions` 开发者模式下 Load unpacked 加载本目录。

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
| **options.html/js/css** | 设置页面 | 详细配置、签到历史、高级设置、通知配置 |

## 核心技术实现

### 1. 定时签到机制

使用 Chrome Alarms API 实现每日定时签到（[background.js](background.js)）：
- `setupDailyAlarm()` - 按 config.checkInTime 计算下次触发时间，创建 `dailyCheckIn` 闹钟（周期 24h）。
- `chrome.alarms.onAlarm` 监听 `dailyCheckIn` 触发签到、`checkInRetry` 触发重试。
- **注意**: Chrome 必须在运行状态才能触发定时任务。

### 2. 签到策略（多重选择器）

content.js 使用多重策略确保找到签到按钮：
- `findCheckInButton()` - 多组 CSS 选择器 + 全量可点击元素按文本优先级兜底。
- `findGoToCheckInButton()` - 首页"去签到"按钮。
- `isAlreadyCheckedIn()` - 按钮文本严格判断（"已签到/已打卡/明日再来"才算已签）。
- `findClaimButton()` - 签到后"领取矿石"按钮。

### 3. 消息通信机制

完整的 action 清单（改动作名时需同步所有引用处）：

```javascript
// background → content：就绪检测
chrome.tabs.sendMessage(tabId, { action: 'ping' })            // 返回 { action: 'pong' }
// background → content：执行签到
chrome.tabs.sendMessage(tabId, { action: 'checkIn' })         // 返回 result 对象

// popup/options → background（经 shared/messaging.js 的 sendMessage）
sendMessage({ action: 'getConfig' })
sendMessage({ action: 'updateConfig', config })
sendMessage({ action: 'manualCheckIn' })

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

**重试机制跨 service worker 生命周期**：MV3 下 service worker 可能被随时终止，因此 `scheduleCheckInRetry()` 把 state（tabId/config/重试计数）持久化到 `chrome.storage.session`，再创建 `checkInRetry` 闹钟；闹钟触发时从 session 恢复 state 继续，用完即删。重试上限由 `config.retryCount` 驱动（options 可选 0-3 次）：`maxRetries = retryCount + 1`（含首次尝试），字段缺失或非法时回退默认 1 次重试。

**掘金 API 端点**：
- `GET https://api.juejin.cn/growth_api/v2/get_today_status` — `today_status === 1` 或 `has_check_in === true` 表示已签到
- `POST https://api.juejin.cn/growth_api/v1/check_in` — `err_no === 0` 成功；`err_no === 10001` 或 `err_msg` 含"重复"/"已经"为重复签到

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
        consecutiveDays: 0,         // 连续签到天数
        successNotification: true,  // 成功桌面通知开关（background notifySuccess 消费）
        failureNotification: true,  // 失败桌面通知开关（background notifyFailure 消费）
        retryCount: 1,              // 重试次数（maxRetries = retryCount + 1）
        loadTimeout: 30             // 页面加载超时（秒，waitForTabLoaded 消费）
    }
}
```

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

当掘金页面结构变化时，修改 [content.js](content.js) 中 `findCheckInButton()` / `findGoToCheckInButton()` 的选择器列表。

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

- ✅ Chrome (推荐)
- ✅ Edge (基于 Chromium)
- ✅ Brave (基于 Chromium)
- ❌ Firefox (Manifest V3 支持有限)

## 权限说明

插件需要以下权限（在 manifest.json 中声明）：
- `storage`: 存储配置和历史记录（含 `chrome.storage.session`）
- `alarms`: 定时任务与重试
- `notifications`: 桌面通知
- `tabs`: 创建和操作标签页
- `scripting`: API 降级时向页面注入脚本执行 fetch
- `https://juejin.cn/*`, `https://*.juejin.cn/*`: 访问掘金网站及 API

## 项目依赖

扩展运行时无外部依赖（纯原生 JavaScript）。`package.json` 中的唯一依赖 `playwright` 仅供 `analyze-juejin.js` 开发调试用。

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
