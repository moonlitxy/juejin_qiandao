# AGENTS.md

掘金(juejin.cn)自动签到 Chrome 扩展，Manifest V3，纯原生 JS（无框架、无构建、无打包）。**没有 lint / typecheck / build 步骤**。详尽设计说明见 [CLAUDE.md](CLAUDE.md)。

## 如何运行/验证

- **无测试**：`package.json` 的 `test` 脚本是空壳（`echo "暂无测试"`），`tests/` 仅含占位图片。执行签到逻辑需在 `chrome://extensions` 开启开发者模式后 **Load unpacked** 加载本目录直接验证。
- 唯一的依赖 `playwright` 用于 [analyze-juejin.js](analyze-juejin.js)：以无头浏览器反查掘金页面 DOM/选择器（可能因页面结构变化或登录态而变化），输出到 `analysis-output/`。改选择器时可先跑它确认真实 DOM。
- 调试方式：在浏览器控制台执行 `chrome.runtime.sendMessage({ action: 'manualCheckIn' })` 强制触发一次签到。
- `shared/` 下的脚本无模块化、无 bundle，通过 manifest `content_scripts` / HTML `<script>` 标签顺序注入（`manifest.json` 中 content 先加载 `shared/config.js` 再加载 `content.js`），靠全局变量（如 `DEFAULT_CONFIG`）通信。新增 shared 脚本必须同步加进对应引入处。

## 架构与协议（易踩坑点）

- 三层：`background.js`（service worker，无持久后台）↔ `content.js`（注入掘金页，执行点击）。MV3 定时任务只能用 **Alarms API**，禁止 `setInterval`。
- 消息通信：background→content 用 `chrome.tabs.sendMessage({action:'checkIn'})`；popup/options 用 `shared/messaging.js` 的 `sendMessage({action:'getConfig'|'manualCheckIn'})`；background 完成后向 popup 广播 `{action:'checkInCompleted', result}`。修改动作名时三处同步改。
- **重复签到处理**：多设备各设备 storage 独立，签到前须检测（API 查询 > 页面文字 > 按钮状态/appearance）。重复签到必须返回 `{ success: true, alreadyCheckedIn: true }`，**不能**当错误返回。
- `content.js` 用多重选择器策略找签到按钮 + MutationObserver 检测结果，用完立即 `disconnect()` 防内存泄漏。
- options.js/popup.js 用 `loadConfig()` 提前拿到 config 后传递下发，避免重复读 storage。

## 保存约定

- 配置存 `chrome.storage.local`，结构见 `shared/config.js` 的 `DEFAULT_CONFIG`；修改字段须同步 `CONFIG_KEYS` 和所有读写点。
- 代码注释多为中文，保持项目现有命名与注释习惯。