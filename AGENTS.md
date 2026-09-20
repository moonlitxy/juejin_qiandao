# AGENTS.md

掘金(juejin.cn)自动签到 Chrome 扩展，Manifest V3，纯原生 JS（无框架、无构建、无打包）。**没有 lint / typecheck / build 步骤**。用法见 [README.md](README.md)，深层设计与历史数据见 [CLAUDE.md](CLAUDE.md)。

## 如何运行/验证

- **`npm test` 现在跑不通，别慌**：`package.json` 声称执行 `node tests/simulate-checkin-timing.js`，但 `tests/` 从未被提交（git 历史里只有过 `tests/images/image.png`），执行必然 `MODULE_NOT_FOUND`。这是仓库缺测试文件，不是你改坏了代码。该文件恢复前，改 `content.js` 等待/轮询逻辑只能靠真机验证。
- 真机端到端验证：`node e2e-checkin.js`。Playwright 用命令行 `--load-extension` 把本插件加载进**独立临时 profile**（不经过 `chrome://extensions` 的开发者模式），跑 `manualCheckIn` 并断言 popup 文案。前置：`npm install` + `npx playwright install chromium`。**必须用 Playwright 自带 Chromium**：本机 Chrome 152+ 已彻底禁用命令行 `--load-extension`（`chrome://extensions` 里看不到任何扩展，加 `--disable-features=DisableLoadExtensionCommandLineSwitch` 也无效）。首次运行需在弹出窗口登录掘金，登录态持久化在 `$TMPDIR/juejin-qiandao-e2e-profile`。
- **复用 Playwright profile 的 hidden 坑**：Chrome 会缓存扩展的 service worker 脚本，改完 `background.js` 重启仍是旧代码；而 `content.js` 会正常更新，极易误判"改了没用"。脚本已在启动前删掉 `Default/Service Worker`、`Default/Extension Scripts`（登录态不受影响）。手动调试时若 background 行为诡异，先怀疑这个。
- 真机验证：`chrome://extensions` 开开发者模式 → **Load unpacked** 加载仓库根目录。改代码后必须点刷新；改 `background.js` 还要在扩展页 terminate 并重载 service worker，否则跑的还是旧逻辑。
- 反查掘金真实 DOM：`node analyze-juejin.js`（先 `npm install`；`playwright` 是本仓唯一依赖，仅此处用，扩展运行时无依赖）。输出到 `analysis-output/`，结果受页面结构/登录态影响。
- 强制触发签到：浏览器控制台执行 `chrome.runtime.sendMessage({ action: 'manualCheckIn' })`（background 日志在 `chrome://extensions` 的 Service Worker 处看）。
- 版本号以 `manifest.json`（1.0.1）为准，`package.json` 仍停在 1.0.0。

## 架构与协议（易踩坑点）

- 三层：`background.js`（service worker，无持久后台，靠 `importScripts('shared/config.js')` 复用配置）↔ `content.js`（注入掘金页，执行点击）。定时只能用 **Alarms API**（`dailyCheckIn` / `checkInRetry`），禁止 `setInterval`。
- **签到入口已迁到沸点页 `/pins`**：background 直接打开 `https://juejin.cn/pins` 而不是旧的 checkin 页。`background.js` 和 `content.js` **各有一份** `isCheckInPageUrl()`，都把 `pins|task|signin` 视为可签到页，改判定标准时两处必须同步。按钮找不到时走 API 兜底，别再死磕 DOM 选择器。
- `shared/` 无模块化、无 bundle，靠全局变量通信：`content_scripts` 顺序（先 `shared/config.js` 后 `content.js`）、popup/options 的 HTML `<script>` 顺序、service worker 的 `importScripts`。新增 shared 脚本必须同步加进对应引入处。注意 `messaging.js` / `notification.js` **仅 popup/options 可用**，content/background 用不了。
- action 清单（改名时三处同步）：background→content 为 `ping`/`checkIn`；popup/options→background 经 `sendMessage` 发 `getConfig` / `updateConfig` / `manualCheckIn` / `syncCheckInStatus`；background→popup 广播 `{action:'checkInCompleted', result}`。
- popup 的签到状态**以本地 `config.lastCheckInDate` 为准**（`popup.js` 的 `updateCheckInStatus` 只比 `=== 今天`），所以网页签到 / 多设备 / 重装后本地无记录会误显示"未签到"。为此 popup 打开时会调 `syncCheckInStatus`，由 background 直接 `fetch` 服务端（SW 里带 cookie 是通的），已签到则用 `updateCheckInHistory` 补写本地再刷新 UI；本地已有记录则直接返回，不会重复写历史。
- `manualCheckIn` 返回 `{success, alreadyCheckedIn?, pending?, skipped?, message}`。`pending` 表示已转入 alarms 重试，popup 须保持"签到中"并等 `checkInCompleted` 广播（成功失败都会广播，UI 以广播为准，不以单次响应定生死）。`enabled:false` 只拦截定时触发，手动签到始终放行。
- `updateConfig` 是**合并语义**（`{...DEFAULT_CONFIG, ...已存, ...传入}`），调用方可只传部分字段；不要改成整体覆盖，否则会抹掉 `lastCheckInDate` / `checkInHistory` / `consecutiveDays`。
- 重试状态存 `chrome.storage.session`（`checkInRetry`），闹钟触发时恢复、用完即删——因为 SW 随时会被终止，不能放内存变量。
- `needRedirect` 归 background 处理：content 只返回 `{success:false, needRedirect:true, redirectUrl}`，由 background `chrome.tabs.update` 跳转后重试，content 不自己跳转。
- **重复签到不是错误**：签到前按 API 查询 > 页面文字 > 按钮状态顺序检测，必须返回 `{success:true, alreadyCheckedIn:true}`。掘金端点：`GET growth_api/v2/get_today_status`（**当前字段是 `check_in_done`**；`today_status`/`has_check_in` 已从响应中消失，代码保留兼容，新增判据以 `check_in_done` 为主），`POST growth_api/v1/check_in`（`err_no===10001` 或文案含"重复"/"已经"即重复签到，需登录态 `credentials:'include'`）。注意该 GET 接口**未登录时也返回 `err_no:0`**，不能用来判断登录态；要判登录用 `GET growth_api/v1/get_cur_point`（未登录返回 `err_no:403 must login`）。
- `content.js` 顶部时间预算常量（`VERIFY_BUDGET_MS=4500` 等）是唯一调参点，函数里禁止塞魔数；通道关闭/超时一律先 API 验证再直签，不要直接判失败（消息通道关闭 ≠ 签到失败）。

## 保存约定

- `chrome.storage.local` 存 `config` 对象，唯一定义在 `shared/config.js` 的 `DEFAULT_CONFIG`；加字段只改这一处并同步 `CONFIG_KEYS`（目前无调用方，仅作键名清单保留）与所有读写点。
- **`.gitignore` 里有 `docs/`**，但现有文档都是当初 `git add -f` 强塞进去的。新增/修改 `docs/` 下的文件必须用 `git add -f`，否则静默被忽略。
- 注释多为中文，保持现有命名与注释习惯。
