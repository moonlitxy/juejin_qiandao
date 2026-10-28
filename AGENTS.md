# AGENTS.md

掘金(juejin.cn)自动签到 Chrome 扩展，Manifest V3，纯原生 JS（无框架、无构建、无打包）。**没有 lint / typecheck / build 步骤**。用法见 [README.md](README.md)，深层设计与历史数据见 [CLAUDE.md](CLAUDE.md)。

## 如何运行/验证

- `npm test`：跑 `tests/simulate-checkin-timing.js`（约 6 秒，无第三方依赖），用 vm 沙箱 + 假 DOM/fetch 跑 `content.js`，7 个场景**并发**断言各自预算及「单场景最坏耗时 ≤ 8000ms」。改 `content.js` 等待/轮询逻辑后必须跑。
- `npm run test:ab`：额外用 `git show HEAD:content.js` 的旧版做 A/B 对比，仅供观察，不影响退出码。
- `npm run test:lottery`：约 1 秒。校验抽奖门禁（`free_count=0` 绝不调 draw）、奖品名取值、当天已有中奖不被 skipped 覆盖、跨设备同步中奖的展示优先级。改抽奖逻辑后必须跑。
- `npm run test:cloud-lottery`：约 1 秒。校验云端抽奖同样遵守 `free_count=0` 绝不调 draw、draw 必须带 `?aid=2608`、配置异常不抽奖、只读配置接口超时自动重试。改 `scripts/cloud-lottery.mjs` 后必须跑。
- `npm run test:sync`：约 1 秒。校验签到记录跨设备同步：签到成功写 `chrome.storage.sync`、关闭开关不写、其他设备记录合并去重、今日已签补写 `lastCheckInDate`、插件不再写 GitHub。改签到同步逻辑后必须跑。
- `npm run test:missed`：约 1 秒。校验过点未签巡查：过点且未签才补、已签/未到点/开关关闭不补、已有进行中签到让路、落库后清巡查闹钟。改巡查或 `updateCheckInHistory` 后必须跑。
- `npm run test:date`：约 1 秒。校验抽奖日期归属只由 UTC+8 决定（子进程切换 TZ 覆盖 UTC-7 / UTC+8 / UTC+9 / UTC），含跨天/跨月/跨年边界。改 `shared/date.js` 或同步 key 后必须跑。
- `npm run test:stats`：约 1 秒。校验连续天数（`cont_count`）与累计天数（`sum_count`）取自同一次 `get_counts`、无变化不写存储、失败/缺字段保留本地值。改统计同步逻辑后必须跑。
- `tests/` 已纳入 git 跟踪；`.gitignore` 忽略的是单数 `test/`（本地草稿目录）。
- 真机端到端：`node e2e-checkin.js`。Playwright 用命令行 `--load-extension` 加载插件到**独立临时 profile**，跑 `manualCheckIn` 并断言 popup 文案。前置：`npm install` + `npx playwright install chromium`。**必须用 Playwright 自带 Chromium**：本机 Chrome 152+ 已彻底禁用命令行 `--load-extension`（`chrome://extensions` 里看不到扩展，加 `--disable-features=DisableLoadExtensionCommandLineSwitch` 也无效）。首次运行需在弹出窗口登录掘金，登录态持久化在 `$TMPDIR/juejin-qiandao-e2e-profile`。
- **复用 Playwright profile 的 hidden 坑**：Chrome 会缓存扩展的 service worker 脚本，改完 `background.js` 重启仍是旧代码；而 `content.js` 会正常更新，极易误判"改了没用"。脚本已在启动前删掉 `Default/Service Worker`、`Default/Extension Scripts`（登录态不受影响）。手动调试时若 background 行为诡异，先怀疑这里。
- 真机验证：`chrome://extensions` 开开发者模式 → **Load unpacked** 加载仓库根目录。改代码后必须点刷新；改 `background.js` 还要在扩展页 terminate 并重载 service worker，否则跑的还是旧逻辑。
- 反查掘金真实 DOM：`node analyze-juejin.js`（先 `npm install`；`playwright` 是本仓唯一依赖，仅脚本使用，扩展运行时无依赖）。输出到 `analysis-output/`，结果受页面结构/登录态影响。
- 强制触发签到：浏览器控制台执行 `chrome.runtime.sendMessage({ action: 'manualCheckIn' })`（background 日志在 `chrome://extensions` 的 Service Worker 处看）。
- 版本号以 `manifest.json` 为准（1.0.1），`package.json` 已同步。

## 架构与协议（易踩坑点）

- 三层：`background.js`（service worker，无持久后台，靠 `importScripts('shared/config.js')`、`importScripts('shared/date.js')` 复用）↔ `content.js`（注入掘金页，执行点击/读 DOM）↔ `popup/options`（UI）。定时只能用 **Alarms API**，禁止 `setInterval`。
- `shared/` 无模块化、无 bundle，靠全局变量通信：`content_scripts` 顺序（先 `shared/config.js` 后 `content.js`）、popup/options 的 HTML `<script>` 顺序（`date.js` → `config.js` → `messaging.js` → `notification.js`）、service worker 的 `importScripts`。新增 shared 脚本必须同步加进对应引入处。注意 `date.js` 只被 background 与 UI 引用，**不在 content_scripts 里**；`messaging.js` / `notification.js` **仅 popup/options 可用**。
- 三个闹钟：`dailyCheckIn`（每天 `checkInTime`）、`checkInRetry`（重试，状态存 `chrome.storage.session`）、`missedCheckInWatch`（过点未签巡查，30 分钟周期）。`setupDailyAlarm()` 同时创建前两者和巡查；`enabled:false` 时清巡查。`onStartup` 会清理残留签到标签页、补一次过点签到、重建闹钟（Chrome 对闹钟持久化"不保证"，且周期会漂移）。
- `pendingCheckInTrigger` 只在 SW 存活期内有效，用于让巡查避开正在重试的签到；签到转入 alarms 重试后，巡查靠它让路。
- **签到入口已迁到沸点页 `/pins`**：background 直接打开 `https://juejin.cn/pins`。`background.js` 和 `content.js` **各有一份** `isCheckInPageUrl()`（`checkin|lottery|pins|task|signin`），改判定标准时两处必须同步。按钮找不到时走 API 兜底，别再死磕 DOM 选择器。
- action 清单（改名时所有发送/接收点同步）：background→content 为 `ping` / `checkIn` / `lotteryDraw`（后者仅 API 抽奖失败且有免费次数时触发）；popup/options→background 为 `getConfig` / `updateConfig` / `manualCheckIn` / `manualLottery` / `syncCheckInStatus` / `getMonthCheckIn` / `getCurrentPoint` / `getLotteryLog` / `getTodayLottery`；background→popup 广播 `{action:'checkInCompleted', result}`（手动抽奖也复用该广播刷新 UI）。
- popup 的签到状态**以本地 `config.lastCheckInDate` 为准**（`updateCheckInStatus` 只比 `=== 今天`），所以网页签到 / 多设备 / 重装后本地无记录会误显示"未签到"。为此 popup 打开时会调 `syncCheckInStatus`，由 background 直接 `fetch` 服务端（SW 里带 cookie 是通的），已签到则用 `updateCheckInHistory` 补写本地再刷新 UI；本地已有记录则直接返回。
- `manualCheckIn` 返回 `{success, alreadyCheckedIn?, pending?, skipped?, message}`。`pending` 表示已转入 alarms 重试，popup 须保持"签到中"并等 `checkInCompleted` 广播（成功失败都会广播，UI 以广播为准，不以单次响应定生死）。`enabled:false` 只拦截定时/巡查触发，手动签到始终放行。
- `updateConfig` 是**合并语义**（`{...DEFAULT_CONFIG, ...已存, ...传入}`），调用方可只传部分字段；不要改成整体覆盖，否则会抹掉 `lastCheckInDate` / `checkInHistory` / `consecutiveDays` / `totalCheckInDays`。
- `needRedirect` 归 background 处理：content 只返回 `{success:false, needRedirect:true, redirectUrl}`，由 background `chrome.tabs.update` 跳转后重试，content 不自己跳转。
- **重复签到不是错误**：签到前按 API 查询 > 页面文字 > 按钮状态顺序检测，必须返回 `{success:true, alreadyCheckedIn:true}`。端点：`GET growth_api/v2/get_today_status`（**当前字段是 `check_in_done`**；`today_status`/`has_check_in` 已消失，代码保留兼容），`POST growth_api/v1/check_in`（**线上 `err_no===15001`** 即"您今日已完成签到"；原代码写 `10001` 且从未命中，现保留兼容。需 `credentials:'include'`）。该 GET **未登录也返回 `err_no:0`**，不能判登录态；判登录用 `GET growth_api/v1/get_cur_point`（未登录 `err_no:403`）。
- `content.js` 顶部时间预算常量（`VERIFY_BUDGET_MS=4500` 等）是唯一调参点，函数里禁止塞魔数；通道关闭/超时一律先 API 验证再直签，不要直接判失败（消息通道关闭 ≠ 签到失败）。
- **跨域 API 签到必须用 `world:'MAIN'`**：内容脚本（隔离世界）对 `api.juejin.cn` 的 **GET 能过、POST 被 CORS 拦**（`TypeError: Failed to fetch`）。所以 background 里 `verifyCheckInViaApi` / `attemptCheckInViaApi` 的 `chrome.scripting.executeScript` 必须带 `world:'MAIN'`。content.js 自带的 `attemptAPICheckIn()` 在隔离世界发 POST 注定失败，只是历史遗留，真正兜底在 background。
- 签到标签页关闭：`closeTabQuietly` 延迟关闭并把 tabId 记在 `chrome.storage.session.orphanTabId`，SW 休眠丢定时器时由下次 `onStartup` 的 `cleanupOrphanTab()` 兜底（只关仍是掘金页的 tab，防 id 复用误关）。

## 云端签到（GitHub Actions）

扩展的 `chrome.alarms` 依赖本机浏览器常驻，**电脑关机/休眠/断网就漏签**（已实测断过签）。所以另有一套云端签到，两边**天然幂等不冲突**（重复签到返回 `15001`，都判 `alreadyCheckedIn`）。扩展的连续/累计/本月天数以服务端为准，popup 打开时会自动同步云端结果。

- 入口：`.github/workflows/checkin.yml`（workflow 名「掘金签到」），核心逻辑 `scripts/checkin.mjs`。**`schedule` 已启用**：`cron: '0 20 * * *'` → 北京时间每天 4:00；另有 `workflow_dispatch`（可勾 `dry_run` 只查状态）。改签到时间只改这一行，注意 cron 是 UTC。
- `.github/workflows/schedule-probe.yml` 是临时诊断 workflow（每 5 分钟），用于确认仓库级 schedule 是否触发；查清后应删除。
- 本地跑：`JUEJIN_COOKIE='...' node scripts/checkin.mjs`，`--dry-run` 只查询不签到，`--headed` 显示浏览器。Cookie 只从环境变量读，日志只回显长度。
- **云端签到必须用 Playwright，不能用纯 fetch/curl**：`POST growth_api/v1/check_in` 依赖 `x-secsdk-csrf-token`（字节 X-Ware-Csrf-Token）+ `msToken` / `ttwid` 风控 cookie。**缺失时接口返回 HTTP 200 + 空 body**（不是报错，极易误判成功），必须加载真实页面让 JS 种出参数，再在页面上下文（MAIN world）发请求。详见 `scripts/diagnose-post.mjs`。
- 登录探针必须用 `get_cur_point`（未登录 `err_no:403`）。`get_today_status` 未登录也返 `err_no:0`。
- 配置 Secret：`Settings → Secrets and variables → Actions → JUEJIN_COOKIE`（必须是**仓库**设置）。或 `gh secret set JUEJIN_COOKIE --repo moonlitxy/juejin_qiandao`。⚠️ 等同账号钥匙，绝不能进仓库。
- GitHub cron **是 UTC**，且有 5~15 分钟随机延迟，**避开整点**；连续两个月无活动会自动禁用定时任务，手动触发一次即可恢复。
- `package-lock.json` 必须提交：workflow 用 `npm ci`，否则每次装到不同的 playwright。

## 保存约定

- `chrome.storage.local` 存 `config` 对象，唯一定义在 `shared/config.js` 的 `DEFAULT_CONFIG`；加字段只改这一处并同步 `CONFIG_KEYS`（目前无调用方，仅作键名清单）与所有读写点。现有统计字段：`consecutiveDays` / `totalCheckInDays` / `monthCheckInCount` / `monthCheckInMonth`。
- `consecutiveDays` / `totalCheckInDays` / `monthCheckInCount` **以服务端为准**，本地推算只是兜底：
  - 连续/累计：`GET growth_api/v1/get_counts` 的 `cont_count`（连续，断签由服务端重置）与 `sum_count`（累计）；`syncConsecutiveDaysFromServer()` 一次请求同时覆盖两项，值没变就不写存储。
  - 本月：`GET growth_api/v1/get_by_month`（整月 `{date, status, point}`）。`status`: **3=已签到**、2=漏签、4=未来；**今天记录是独立 status（线上为 1）**，是否算已签要用 `get_today_status` 的 `check_in_done` 判定，不能只看 `status===3`。
  - **调用顺序**：服务端同步必须排在 `updateCheckInHistory` **之后**，否则会被本地推算的 0 冲掉（见 `finalizeCheckInSuccess` / `syncCheckInStatusFromServer`）。popup 用 `monthCheckInMonth==='YYYY-MM'` 判断本月统计是否可用。
- **签到成功后自动抽奖**：`finalizeCheckInSuccess` 先播报签到终态（通知 + 广播），再 `runLottery(tabId)`——查 `free_count`，>0 才抽，否则 `skipped`。**两个抽奖接口都必须 `world:'MAIN'`**：`lottery_config/get` 在 SW 里直接 fetch 只拿到空 body；`lottery/draw` 还必须带 **`?aid=2608`**，否则表现为 `Failed to fetch`。**`free_count=0` 时 draw 会改扣 200 矿石/次**，无免费次数绝不调 draw。抽奖全程 best-effort，不影响签到结果；`autoLottery:false` 可关闭。
- **云端签到后免费抽奖**：`scripts/checkin.mjs` 签到后调用 `scripts/cloud-lottery.mjs`，同样先查 `free_count`，>0 才 draw，一次运行最多抽一次、失败不重试（避免响应丢失后重复消耗）。结果写入 `.cloud/checkin-lottery.json` 并提交回 `main`；扩展通过 raw.githubusercontent.com 拉取，合并进 `lotteryResult` / `lotteryHistory` 并复用 `chrome.storage.sync`。`cloudLotterySync` 与 `githubRepo` **默认关闭/为空**，避免别人安装后连到原作者的公开记录；只有两者都配置完整时本机才让位给云端抽奖，否则继续本机抽奖。
- **云端结果单向只读**：云端结果文件同时保存 `checkIns`（最近 90 条，字段 `date/status/contCount/sumCount/source`）。Actions 每次运行都会把本次签到写进去；扩展只通过 raw.githubusercontent.com 拉取，按 UTC+8 日期去重合并进 `config.checkInHistory`，**插件不再使用 PAT、不再写 GitHub**。`cloudLotterySync` / `cloudRepoConfirmed` / `githubRepo` 三者都满足才请求云端；仓库留空时完全不发请求。
- **跨设备同步走 chrome.storage.sync**：签到记录按天写 `checkin:YYYY-MM-DD`（`syncCheckIn` 默认开启），抽奖记录按天写 `lottery:YYYY-MM-DD`（`syncLottery` 默认开启），依靠用户登录 Chrome / Edge 同步账号在设备间同步，不经过 GitHub。读取端按 UTC+8 日期去重；其他设备今天已签时本机补写 `lastCheckInDate`，避免重复签到。同步记录保留 90 天，`onStartup` 清理过期 key。
- **无免费次数也落历史**：云端 `skipped` 会写入 `lotteryHistory` 并成为当天 `lotteryResult`，popup 显示“今日无免费抽奖机会”，设置页抽奖日历显示“未抽奖”。
- **Action 重试**：签到步骤使用 `nick-fields/retry@v3`，最多 3 次、间隔 60 秒；只重跑整个脚本，`lottery/draw` 本身仍是一次调用，不会因超时重试重复抽奖。只读的 `lottery_config/get` 另有 3 次内部重试。
- **插件内手动抽奖**：popup / 设置页“立即抽奖”走 `manualLottery`，同样先查 `free_count`；结果（含 skipped）写入本地历史。掘金网页里手动点的抽奖仍无法捕获，因为官方没有可用的个人抽奖记录接口。
- **抽奖记录留存与同步**：本机流水存 `config.lotteryHistory`（最近 90 条，含 skipped/failed）。开启 `syncLottery` 时额外写 `chrome.storage.sync` 的 `lottery:YYYY-MM-DD`（按天一个 key，绕开单项 8KB 限制；未登录 Chrome 账号时退化为本地）。设置页用 `getLotteryLog` 取「本机 ∪ 同步」按天聚合（同一天优先 `won`），渲染成可翻月的抽奖日历。**签到日历无法跨月**——`get_by_month` 不接受月份参数，历史月份服务端不提供。
- **抽奖日期归属统一按 UTC+8**：`shared/date.js` 的 `toLotteryDateKey()` 是唯一口径（平移到 UTC+8 后取 UTC 日期），不要用 `getFullYear()` / `getDate()`，否则跨时区设备会把同一记录归到不同天、sync key 对不上。background 里的 `toDateKey()` 只是薄封装。
- **掘金没有个人抽奖记录接口**：`lottery_history/*` 走 `msToken`/`a_bogus` 签名，手动请求一律 `err_no:2 请求路由不存在`，所以网页手动抽的奖拿不到、也同步不了。
- **`.gitignore` 里有 `docs/`**，但现有文档都是当初 `git add -f` 强塞进去的。新增/修改 `docs/` 下的文件必须用 `git add -f`，否则静默被忽略。
- 注释多为中文，保持现有命名与注释习惯。
