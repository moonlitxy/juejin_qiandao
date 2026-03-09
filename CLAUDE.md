# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

掘金(juejin.cn)自动签到浏览器扩展，使用 Chrome Extension Manifest V3 标准开发。

**技术栈**: JavaScript (ES6+), Chrome Extension APIs, DOM 操作

**版本**: v1.0.1

## 快速开始

详细的安装和使用说明请查看：
- **用户指南**: [docs/QUICKSTART.md](docs/QUICKSTART.md)
- **文档索引**: [docs/README.md](docs/README.md)

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
  ├── config.js        # 统一的配置常量 (DEFAULT_CONFIG)
  ├── messaging.js     # 统一的消息通信 (sendMessage, sendTabMessage)
  └── notification.js  # 统一的通知系统 (showDesktopNotification, showPageNotification)
```

### 文件职责

| 文件 | 职责 | 关键功能 |
|------|------|----------|
| **manifest.json** | 插件配置文件 | 声明权限、配置脚本注入、定义基本信息 |
| **background.js** | Service Worker 后台服务 | 定时任务(Alarms API)、消息通信、存储管理、标签页操作 |
| **content.js** | 页面注入脚本 | 查找签到按钮、执行点击、检测签到状态、API 降级方案 |
| **popup.html/js/css** | 弹出窗口 | 快速签到、状态展示、统计信息、快速设置 |
| **options.html/js/css** | 设置页面 | 详细配置、签到历史、高级设置、通知配置 |

## 核心技术实现

### 1. 定时签到机制

使用 Chrome Alarms API 实现每日定时签到：

- [background.js:44-60](background.js#L44-L60) - `setupDailyAlarm()` 设置定时任务
- [background.js:62-68](background.js#L62-L68) - 闹钟触发监听
- **注意**: Chrome 必须在运行状态才能触发定时任务

### 2. 签到策略（多重选择器）

content.js 使用多重策略确保找到签到按钮：

- [content.js:143-211](content.js#L143-L211) - `findCheckInButton()` 多种选择器策略
- [content.js:231-266](content.js#L231-L266) - `isAlreadyCheckedIn()` 重复签到检测

### 3. 消息通信机制

```javascript
// background → content: 执行签到
chrome.tabs.sendMessage(tabId, { action: 'checkIn' }, callback)

// popup/options → background: 获取配置或手动签到
sendMessage({ action: 'getConfig' })  // shared/messaging.js
sendMessage({ action: 'manualCheckIn' })

// background → popup: 签到完成后通知更新
chrome.runtime.sendMessage({ action: 'checkInCompleted', result: response })
```

### 4. 重复签到检测

针对多设备场景，使用多重检测机制：

1. **API 查询**（最准确）：调用掘金 API 查询今日签到状态
2. **页面文字检测**：查找"今日已签到"、"已经打卡"等文字
3. **按钮状态检测**：检查按钮文本和 disabled 属性
4. **服务端验证**：点击后检查返回的错误码（err_no: 10001 表示重复签到）

**重要**: 重复签到应返回 `{ success: true, alreadyCheckedIn: true }`，而不是错误。

### 5. 数据存储结构

```javascript
{
    config: {
        enabled: true,              // 是否启用自动签到
        checkInTime: '09:00',       // 签到时间
        lastCheckInDate: null,      // 最后签到日期（用于判断今日是否已签到）
        checkInHistory: [],         // 签到历史记录（最近30天）
        consecutiveDays: 0,         // 连续签到天数
        successNotification: true,  // 成功通知开关
        failureNotification: true,  // 失败通知开关
        retryCount: 1,              // 重试次数
        loadTimeout: 30             // 页面加载超时（秒）
    }
}
```

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
4. 发送消息给 content.js 执行签到
   ↓
5. content.js 查找并点击签到按钮
   ↓
6. 检测签到结果（成功/失败/重复签到）
   ↓
7. 返回结果给 background.js
   ↓
8. 更新签到历史和统计信息（传递 config 避免重复读取存储）
   ↓
9. 显示桌面通知
   ↓
10. 延迟3秒后关闭标签页
```

### 错误处理

1. **用户未登录**: 检测页面是否有登录按钮，提示用户先登录
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

1. **合并存储读取** - 传递 config 参数避免重复读取
   - [background.js:72-129](background.js#L72-L129) - performCheckIn
   - [popup.js:81-102](popup.js#L81-L102) - loadConfig 返回 config

2. **事件监听替代轮询** - waitForTabLoaded 使用 chrome.tabs.onUpdated
   - [background.js:131-161](background.js#L131-L161)

3. **缓存 DOM 查询** - 传递按钮元素避免重复查找
   - [content.js:18-141](content.js#L18-L141)

4. **修复内存泄漏** - MutationObserver 立即断开
   - [content.js:483-511](content.js#L483-L511)

### 性能提升数据

- 签到操作存储读取：3 次 → 1 次 (-67%)
- waitForTabLoaded 轮询：0-60 次 → 0 次 (-100%)
- DOM 查询次数：2 次 → 1 次 (-50%)
- 签到响应时间：~3.5s → ~2.5s (-29%)
- CPU 使用率：高 → 低 (-80%)

详细报告: [docs/代码审查优化报告.md](docs/代码审查优化报告.md)

## 常见修改场景

### 更新签到选择器

当掘金页面结构变化时，修改 [content.js:148-166](content.js#L148-L166) 中的选择器列表。

### 修改定时任务逻辑

修改 [background.js:44-60](background.js#L44-L60) 中的 `setupDailyAlarm` 函数。

### 调整通知设置

- 桌面通知: [background.js:239-246](background.js#L239-L246) - `showNotification()`
- 页面通知: [shared/notification.js](shared/notification.js) - `showPageNotification()`

### 更新 UI 样式

- Popup 界面: [popup.css](popup.css)
- 设置界面: [options.css](options.css)

## 调试技巧

### 查看详细日志
所有脚本都包含详细的 console.log，可以在开发者工具中查看执行流程。

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
- `storage`: 存储配置和历史记录
- `alarms`: 定时任务
- `notifications`: 桌面通知
- `tabs`: 创建和操作标签页
- `https://juejin.cn/*`: 访问掘金网站

## 项目依赖

无外部依赖，纯原生 JavaScript 实现。

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
