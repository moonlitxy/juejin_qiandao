// background.js - 后台服务脚本
// 负责处理定时任务、存储管理和消息通信

// 默认配置（应该与 shared/config.js 保持一致，但因为 Service Worker 无法直接加载 shared 脚本）
const DEFAULT_CONFIG = {
    enabled: true,              // 是否启用自动签到
    checkInTime: '09:00',       // 签到时间（24小时制）
    lastCheckInDate: null,      // 最后签到日期
    checkInHistory: [],         // 签到历史记录
    consecutiveDays: 0,         // 连续签到天数
    successNotification: true,  // 成功通知开关
    failureNotification: true,  // 失败通知开关
    retryCount: 1,              // 重试次数
    loadTimeout: 30             // 页面加载超时（秒）
};

// 插件安装或更新时初始化
chrome.runtime.onInstalled.addListener(async () => {
    console.log('掘金签到插件已安装');

    // 保存默认配置到存储
    await chrome.storage.local.get(['config'], (result) => {
        if (!result.config) {
            chrome.storage.local.set({ config: DEFAULT_CONFIG });
        }
    });

    // 创建每日定时签到闹钟
    setupDailyAlarm();
});

// 设置每日定时签到闹钟
function setupDailyAlarm() {
    chrome.storage.local.get(['config'], (result) => {
        const config = result.config || {};
        const checkInTime = config.checkInTime || '09:00';

        // 解析签到时间
        const [hours, minutes] = checkInTime.split(':').map(Number);

        // 创建闹钟，每天指定时间执行
        chrome.alarms.create('dailyCheckIn', {
            when: getNextScheduleTime(hours, minutes),
            periodInMinutes: 24 * 60  // 每24小时重复一次
        });

        console.log(`已设置每日签到时间: ${checkInTime}`);
    });
}

// 计算下一次签到时间（毫秒时间戳）
function getNextScheduleTime(hours, minutes) {
    const now = new Date();
    const target = new Date();

    // 设置目标时间为今天的小时和分钟
    target.setHours(hours, minutes, 0, 0);

    // 如果今天的时间已过，则设置为明天
    if (target <= now) {
        target.setDate(target.getDate() + 1);
    }

    return target.getTime();
}

// 监听闹钟触发
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'dailyCheckIn') {
        console.log('定时签到触发');
        await performCheckIn();
    }
});

// 执行签到操作
async function performCheckIn() {
    try {
        // 检查今天是否已经签到
        const today = new Date().toDateString();
        const { config } = await chrome.storage.local.get(['config']);

        if (config.lastCheckInDate === today) {
            console.log('今天已经签到过了');
            return;
        }

        // 打开掘金网站进行签到
        const tab = await chrome.tabs.create({ url: 'https://juejin.cn', active: false });

        // 等待页面加载完成（最多等待30秒）
        await waitForTabLoaded(tab.id, 30000);

        // 发送消息给content script执行签到
        chrome.tabs.sendMessage(tab.id, { action: 'checkIn' }, async (response) => {
            if (chrome.runtime.lastError) {
                console.error('发送签到消息失败:', chrome.runtime.lastError);
                showNotification('签到失败', '无法与页面通信，请确保已登录掘金');
                // 关闭标签页
                chrome.tabs.remove(tab.id);
                return;
            }

            // 处理签到结果（包括重复签到的情况）
            if (response && (response.success || response.alreadyCheckedIn)) {
                // 传递已读取的 config，避免重复读取存储
                await updateCheckInHistory(response, config);
                const message = response.alreadyCheckedIn ?
                    '今天已经签到过了' :
                    (response.message || '掘金签到完成！');
                showNotification('签到成功', message);

                // 通知popup更新状态
                chrome.runtime.sendMessage({
                    action: 'checkInCompleted',
                    result: response
                }).catch(() => {
                    // popup可能没有打开，忽略错误
                    console.log('通知popup更新状态失败，popup可能未打开');
                });
            } else {
                showNotification('签到失败', response?.message || '签到操作失败，请手动检查');
            }

            // 延迟关闭标签页（给用户看结果的时间）
            setTimeout(() => {
                chrome.tabs.remove(tab.id);
            }, 3000);
        });

    } catch (error) {
        console.error('签到过程出错:', error);
        showNotification('签到出错', error.message);
    }
}

// 等待标签页加载完成（使用事件监听，避免轮询）
function waitForTabLoaded(tabId, timeout) {
    return new Promise((resolve, reject) => {
        // 首先检查当前状态
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }

            // 如果已经加载完成，直接返回
            if (tab.status === 'complete') {
                resolve();
                return;
            }

            // 否则监听更新事件
            const listener = (updatedTabId, changeInfo) => {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };

            chrome.tabs.onUpdated.addListener(listener);

            // 设置超时，确保清理监听器
            setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                reject(new Error('页面加载超时'));
            }, timeout);
        });
    });
}

// 更新签到历史记录
async function updateCheckInHistory(result, config = null) {
    try {
        // 如果没有传入 config，再从存储读取（避免重复读取）
        if (!config) {
            const result = await chrome.storage.local.get(['config']);
            config = result.config;
        }

        const today = new Date().toDateString();

        console.log('更新签到历史，当前结果:', result);
        console.log('当前配置的最后签到日期:', config.lastCheckInDate);
        console.log('今天的日期:', today);

        // 获取昨天的日期（用于计算连续签到天数）
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toDateString();

        // 判断是否需要更新签到记录
        const shouldUpdate = config.lastCheckInDate !== today || result.alreadyCheckedIn;

        console.log('是否需要更新签到记录:', shouldUpdate);
        console.log('昨天的日期:', yesterdayStr);

        if (shouldUpdate) {
            // 先保存之前的lastCheckInDate用于计算连续天数
            const previousLastCheckInDate = config.lastCheckInDate;

            // 更新最后签到日期
            config.lastCheckInDate = today;

            // 添加签到记录（重复签到也记录为成功）
            const record = {
                date: new Date().toISOString(),
                status: result.success || result.alreadyCheckedIn ? 'success' : 'failed',
                message: result.alreadyCheckedIn ? '今天已经签到过了' : result.message,
                alreadyCheckedIn: result.alreadyCheckedIn || false
            };

            // 保留最近30天的记录
            config.checkInHistory = config.checkInHistory || [];
            config.checkInHistory.unshift(record);
            if (config.checkInHistory.length > 30) {
                config.checkInHistory = config.checkInHistory.slice(0, 30);
            }

            // 计算连续签到天数（使用之前的lastCheckInDate）
            if (result.alreadyCheckedIn) {
                // 如果是重复签到，不改变连续天数
                console.log('重复签到，保持当前连续天数');
            } else if (previousLastCheckInDate === yesterdayStr) {
                // 如果之前记录的是昨天的日期，连续天数+1
                config.consecutiveDays = (config.consecutiveDays || 0) + 1;
                console.log('连续签到，天数+1');
            } else {
                // 否则重新开始计数
                config.consecutiveDays = 1;
                console.log('重新开始计数，连续天数设为1');
            }

            console.log('更新后的配置:', {
                lastCheckInDate: config.lastCheckInDate,
                consecutiveDays: config.consecutiveDays,
                record: record
            });

            // 保存配置
            await chrome.storage.local.set({ config });
            console.log('签到历史已更新');

        } else {
            console.log('今天已经签到过，无需重复更新');
        }
    } catch (error) {
        console.error('更新签到历史失败:', error);
    }
}

// 显示桌面通知
function showNotification(title, message) {
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: title,
        message: message
    });
}

// 监听消息通信（来自popup或content script）
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'manualCheckIn') {
        // 手动触发签到
        performCheckIn().then(() => {
            sendResponse({ success: true });
        }).catch(error => {
            sendResponse({ success: false, message: error.message });
        });
        return true; // 保持消息通道开启
    }

    if (request.action === 'getConfig') {
        // 获取配置
        chrome.storage.local.get(['config'], (result) => {
            sendResponse(result);
        });
        return true;
    }

    if (request.action === 'updateConfig') {
        // 更新配置
        chrome.storage.local.set({ config: request.config }, () => {
            setupDailyAlarm(); // 重新设置闹钟
            sendResponse({ success: true });
        });
        return true;
    }
});

// 监听存储变化（用于配置更新时重设闹钟）
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) {
        const newConfig = changes.config.newValue;
        if (newConfig && newConfig.checkInTime) {
            setupDailyAlarm();
        }
    }
});
