# AGENTS.md

掘金(juejin.cn)自动签到 Chrome 扩展，Manifest V3，纯原生 JS（无框架、无构建、无打包）。**没有 lint / typecheck / build 步骤**。深层设计见 [CLAUDE.md](CLAUDE.md)。

## 如何运行/验证

- **测试**：`npm test`（约 6 秒，无第三方依赖）。用 vm 沙箱 + 假 DOM/fetch 跑 `content.js` 的 `performActualCheckIn()`，断言**最坏耗时 ≤ 8 秒**（MV3 service worker 空闲约 30 秒被终止，验证链过长会销毁 background 消息通道）。`npm run test:ab` 额外对比 git HEAD 旧版本。改动 `content.js` 等待/轮询逻辑后**必须跑**。
- 真机验证仍需 `chrome://extensions` 开开发者模式后 **Load unpacked** 加载本目录；沙箱测试不能替代。
- `playwright`（唯一的依赖）仅供 `node analyze-juejin.js` 反查掘金真实 DOM（输出到 `analysis-output/`，受页面结构/登录态影响），运行时无外部依赖。改选择器前可先跑它。
- 调试：浏览器控制台执行 `chrome.runtime.sendMessage({ action: 'manualCheckIn' })` 强制触发一次签到。

## 架构与协议（易踩坑点）

- 三层：`background.js`（service worker，无持久后台，靠 `importScripts('shared/config.js')` 复用配置）↔ `content.js`（注入掘金页，执行点击）。定时只能用 **Alarms API**（`dailyCheckIn` / `checkInRetry`），禁止 `setInterval`。
- `shared/` 无模块化、无 bundle，靠 manifest `content_scripts` 顺序（先 `shared/config.js` 后 `content.js`）、popup/options 的 HTML `<script>` 顺序、service worker 的 `importScripts` 加载，全局变量通信。新增 shared 脚本必须同步加进对应引入处。注意 `messaging.js` / `notification.js` 仅 popup/options 可用，content/background 用不了。
- action 清单（改名时三处同步）：background→content 为 `ping`/`checkIn`；popup/options→background 经 `sendMessage` 发 `getConfig` / `updateConfig` / `manualCheckIn`；background→popup 广播 `{action:'checkInCompleted', result}`。
- `manualCheckIn` 返回 `{success, alreadyCheckedIn?, pending?, skipped?, message}`。`pending` 表示已转入 alarms 重试，popup 须保持"签到中"并等 `checkInCompleted` 广播（成功失败都会广播，UI 以广播为准，不以单次响应定生死）。`enabled:false` 只拦截定时触发，手动签到始终放行。
- `updateConfig` 是**合并语义**（`{...DEFAULT_CONFIG, ...已存, ...传入}`），调用方可只传部分字段；不要改成整体覆盖，否则会抹掉 `lastCheckInDate` / `checkInHistory` / `consecutiveDays`。
- 重试状态存 `chrome.storage.session`（`checkInRetry`），闹钟触发时恢复、用完即删——因为 SW 随时会被终止，不能放内存变量。
- `needRedirect` 归 background 处理：content 只返回 `{success:false, needRedirect:true, redirectUrl}`，由 background `chrome.tabs.update` 跳转后重试，content 不自己跳转。
- **重复签到不是错误**：签到前按 API 查询 > 页面文字 > 按钮状态顺序检测，必须返回 `{success:true, alreadyCheckedIn:true}`。掘金端点：`GET growth_api/v2/get_today_status`（`today_status===1` 或 `has_check_in`），`POST growth_api/v1/check_in`（`err_no===10001` 或文案含"重复"/"已经"即重复签到，需登录态 `credentials:'include'`）。
- `content.js` 顶部时间预算常量（`VERIFY_BUDGET_MS=4500` 等）是唯一调参点，函数里禁止塞魔数；通道关闭/超时一律先 API 验证再直签，不要直接判失败。

## 保存约定

- `chrome.storage.local` 存 `config` 对象，唯一定义在 `shared/config.js` 的 `DEFAULT_CONFIG`；加字段只改这一处并同步 `CONFIG_KEYS`（目前无调用方，仅作键名清单保留）与所有读写点。
- 注释多为中文，保持现有命名与注释习惯。
