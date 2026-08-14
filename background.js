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
    } else if (alarm.name === 'checkInRetry') {
        // MV3 service worker 可能被终止，重试状态存 storage.session，由闹钟恢复
        console.log('签到重试闹钟触发');
        const { checkInRetry } = await chrome.storage.session.get('checkInRetry');
        if (!checkInRetry) {
            return;
        }
        await chrome.storage.session.remove('checkInRetry');
        await performCheckIn(checkInRetry);
    }
});

// 执行签到操作
// resumeState 为上次重试持久化的状态（service worker 重启后由闹钟恢复）
async function performCheckIn(resumeState = null) {
    try {
        // 恢复重试时直接继续签到尝试
        if (resumeState) {
            await runCheckInAttempt(resumeState);
            return;
        }

        // 新的签到流程开始前，清理可能残留的重试闹钟和状态
        await chrome.alarms.clear('checkInRetry');
        await chrome.storage.session.remove('checkInRetry');

        // 检查今天是否已经签到
        const today = new Date().toDateString();
        const { config } = await chrome.storage.local.get(['config']);

        // 检查 config 是否存在
        if (!config) {
            console.warn('⚠️ config 不存在，初始化默认配置');
            await chrome.storage.local.set({ config: DEFAULT_CONFIG });
            return;
        }

        if (config.lastCheckInDate === today) {
            console.log('✅ 今天已经签到过了');
            return;
        }

        // 打开掘金首页（让 content.js 自动处理跳转到签到页面）
        console.log('打开掘金首页...');
        const tab = await chrome.tabs.create({
            url: 'https://juejin.cn',
            active: false
        });

        // 等待首页加载完成
        await waitForTabLoaded(tab.id, 30000);

        // 等待 content script 注入和初始化完成（增加等待时间）
        console.log('等待 content script 注入和页面渲染...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // 检查是否已经跳转到签到页面（等待页面自动跳转）
        console.log('检查当前页面 URL...');
        let currentTab = await chrome.tabs.get(tab.id);
        const initialUrl = currentTab.url;

        console.log('当前 URL:', initialUrl);

        // 如果还在首页，等待页面可能自动跳转到签到页面（最多5秒）
        if (!initialUrl.includes('checkin') && !initialUrl.includes('lottery')) {
            console.log('仍在首页，等待可能的自动跳转...');
            for (let i = 0; i < 5; i++) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                currentTab = await chrome.tabs.get(tab.id);
                if (currentTab.url && (currentTab.url.includes('checkin') || currentTab.url.includes('lottery'))) {
                    console.log('检测到页面已跳转到签到页面:', currentTab.url);
                    break;
                }
            }
        }

        // 获取最终 URL
        currentTab = await chrome.tabs.get(tab.id);
        const finalUrl = currentTab.url;
        console.log('最终 URL:', finalUrl);

        // 检查是否已经在签到页面，直接执行签到
        if (finalUrl && (finalUrl.includes('checkin') || finalUrl.includes('lottery'))) {
            console.log('已在签到页面，等待页面加载完成后执行签到');
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        // 【改进】支持页面跳转的签到流程
        const state = {
            tabId: tab.id,
            config,
            maxRetries: 10,
            retryCount: 0,
            currentUrl: finalUrl
        };

        // 首次尝试发送消息
        await runCheckInAttempt(state);

    } catch (error) {
        console.error('签到过程出错:', error);
        showNotification('签到出错', error.message);
    }
}

// 执行一次签到尝试；需要重试时通过 alarms 调度下一次（MV3 下比 setTimeout 更可靠）
async function runCheckInAttempt(state) {
    const { tabId, config } = state;
    console.log(`📤 尝试发送签到消息 (${state.retryCount + 1}/${state.maxRetries})...`);

    // 先刷新当前 URL
    try {
        const updatedTab = await chrome.tabs.get(tabId);
        state.currentUrl = updatedTab.url;
        console.log('📍 当前页面 URL:', state.currentUrl);
    } catch (e) {
        console.log('⚠️ 无法获取当前页面 URL');
    }

    // 先测试 content script 是否准备好
    const isReady = await testContentScriptReady(tabId);
    if (!isReady) {
        console.warn('⚠️ content script 未就绪，等待页面注入后重试');
        state.retryCount++;

        if (state.retryCount < state.maxRetries) {
            await scheduleCheckInRetry(state);
            return;
        }

        // 即使 content script 始终未就绪，也要先通过 API 验证签到状态，
        // 因为首次点击可能已经触发签到成功
        const apiResult = await verifyCheckInViaApi(tabId);
        if (await finalizeIfApiVerified(apiResult, config, tabId)) {
            return;
        }

        // API 验证未确认已签到，尝试通过 API 直接签到
        const apiCheckResult = await attemptCheckInViaApi(tabId);
        if (await finalizeIfApiVerified(apiCheckResult, config, tabId)) {
            return;
        }

        showNotification('签到失败', apiCheckResult.message || apiResult.message || '页面脚本未就绪，请刷新插件后重试');
        chrome.tabs.remove(tabId);
        return;
    }

    // content script 已就绪，发送签到消息
    let response;
    try {
        response = await chrome.tabs.sendMessage(tabId, { action: 'checkIn' });
    } catch (error) {
        const errorMsg = error.message || String(error);
        // 签到按钮点击后页面常会跳转/刷新，content script 上下文销毁会导致消息通道关闭、
        // 响应丢失；此时签到可能已经触发，不能直接当失败处理，一律先通过 API 验证。
        console.warn('⚠️ 签到消息未收到响应，可能是页面跳转/刷新导致通道关闭:', errorMsg);

        // 等待页面稳定（让跳转完成或 API 请求完成）
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
            const updatedTab = await chrome.tabs.get(tabId);
            state.currentUrl = updatedTab.url;
            console.log('🔄 页面跳转后的 URL:', state.currentUrl);

            // 如果在签到页面，等待更长时间确保 API 请求完成
            if (state.currentUrl && (state.currentUrl.includes('checkin') || state.currentUrl.includes('lottery'))) {
                console.log('✅ 在签到页面，等待 API 请求完成...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        } catch (e) {
            console.warn('⚠️ 获取更新后的标签页失败:', e);
        }

        // 通过 API 验证签到状态（通道关闭往往意味着签到已触发）
        const apiResult = await verifyCheckInViaApi(tabId);
        if (await finalizeIfApiVerified(apiResult, config, tabId)) {
            return;
        }

        // API 验证未确认已签到，尝试通过 API 直接签到
        const apiCheckResult = await attemptCheckInViaApi(tabId);
        if (await finalizeIfApiVerified(apiCheckResult, config, tabId)) {
            return;
        }

        // 仍未确认，走重试流程
        console.log('⚠️ API 未确认已签到，准备重试签到...');
        state.retryCount++;
        if (state.retryCount < state.maxRetries) {
            await scheduleCheckInRetry(state);
            return;
        }

        // 重试已耗尽，最后一次 API 验证刚刚已执行，确认失败
        showNotification('签到失败', apiCheckResult.message || apiResult.message || '无法确认签到状态，请手动检查');
        chrome.tabs.remove(tabId);
        return;
    }

    console.log('✅ 收到 content script 响应:', response);

    // 检查是否需要重定向
    if (response && response.needRedirect && response.redirectUrl) {
        console.log('🔀 收到重定向请求:', response.redirectUrl);

        // 更新标签页 URL
        await chrome.tabs.update(tabId, { url: response.redirectUrl });
        console.log('✅ 已更新标签页 URL');

        // 等待新页面加载
        await new Promise(resolve => setTimeout(resolve, 5000));

        // 重新尝试发送签到消息
        state.retryCount++;
        await scheduleCheckInRetry(state, 1000);
        return;
    }

    // 处理签到结果（包括重复签到的情况）
    if (response && (response.success || response.alreadyCheckedIn)) {
        await finalizeCheckInSuccess(response, config);
    } else {
        showNotification('签到失败', response?.message || '签到操作失败，请手动检查');
    }

    // 延迟关闭标签页（给用户看结果的时间）
    setTimeout(() => {
        chrome.tabs.remove(tabId);
    }, 3000);
}

// 调度下一次签到重试（状态持久化到 storage.session，闹钟触发后由 service worker 恢复）
async function scheduleCheckInRetry(state, delayMs = 3000) {
    console.log(`⏳ ${delayMs / 1000}秒后重试 (${state.retryCount}/${state.maxRetries})...`);
    await chrome.storage.session.set({ checkInRetry: state });
    chrome.alarms.create('checkInRetry', { when: Date.now() + delayMs });
}

// 测试 content script 是否就绪
async function testContentScriptReady(tabId) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        if (response && response.action === 'pong') {
            console.log('✅ content script 已就绪');
            return true;
        }
    } catch (e) {
        console.log('⚠️ content script 未就绪:', e.message);
    }
    return false;
}

// 签到成功统一处理：更新历史、展示通知、广播给 popup
async function finalizeCheckInSuccess(result, config) {
    // 传递已读取的 config，避免重复读取存储
    await updateCheckInHistory(result, config);
    const message = result.alreadyCheckedIn ?
        (result.message || '今天已经签到过了') :
        (result.message || '掘金签到完成！');
    showNotification('签到成功', message);

    // 通知 popup 更新状态（popup 可能没有打开，忽略错误）
    chrome.runtime.sendMessage({
        action: 'checkInCompleted',
        result: result
    }).catch(() => {
        console.log('通知popup更新状态失败，popup可能未打开');
    });
}

// API 结果确认已签到时的统一处理：更新历史、通知、关闭标签页
async function finalizeIfApiVerified(apiResult, config, tabId) {
    if (apiResult.success || apiResult.alreadyCheckedIn) {
        console.log('✅ API 确认：签到已成功！');
        await finalizeCheckInSuccess(apiResult, config);
        chrome.tabs.remove(tabId);
        return true;
    }
    return false;
}

// 通过 API 验证签到状态（用于消息通道关闭后的备用验证）
async function verifyCheckInViaApi(tabId) {
    try {
        console.log('🔍 通过 API 验证签到状态...');

        // 在页面上下文中执行 API 请求
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: async () => {
                try {
                    const response = await fetch('https://api.juejin.cn/growth_api/v2/get_today_status', {
                        method: 'GET',
                        credentials: 'include'
                    });

                    if (response.status === 401) {
                        return { success: false, message: '请先登录掘金账号' };
                    }

                    if (response.ok) {
                        const data = await response.json();
                        console.log('📋 API 验证响应:', JSON.stringify(data));

                        if (data.err_no === 0 && data.data) {
                            const todayStatus = data.data.today_status;
                            const hasCheckIn = data.data.has_check_in;

                            if (todayStatus === 1 || hasCheckIn === true) {
                                return { success: true, alreadyCheckedIn: true, message: '今日已签到（API 验证）' };
                            } else if (todayStatus === 0 || hasCheckIn === false) {
                                return { success: false, message: '今日未签到（API 验证）' };
                            }
                        } else if (data.err_no !== 0) {
                            const errMsg = data.err_msg || `API 验证失败 (err_no: ${data.err_no})`;
                            if (errMsg.includes('登录')) {
                                return { success: false, message: '请先登录掘金账号' };
                            }
                            return { success: false, message: errMsg };
                        }
                    }
                    return { success: false, message: `API 验证请求失败 (${response.status})` };
                } catch (error) {
                    console.error('API 验证异常:', error);
                    return { success: false, message: `API 验证异常: ${error.message}` };
                }
            }
        });

        if (results && results[0] && results[0].result) {
            console.log('✅ API 验证结果:', results[0].result);
            return results[0].result;
        }

        return { success: false, message: '无法验证签到状态' };
    } catch (error) {
        console.error('❌ API 验证失败:', error);
        return { success: false, message: error.message };
    }
}

// 通过 API 直接签到（content script 不可用时的备用方案）
async function attemptCheckInViaApi(tabId) {
    try {
        console.log('🔧 尝试使用 API 直接签到...');

        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: async () => {
                try {
                    const response = await fetch('https://api.juejin.cn/growth_api/v1/check_in', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        credentials: 'include'
                    });

                    if (response.status === 401) {
                        return { success: false, message: '请先登录掘金账号' };
                    }

                    if (response.ok) {
                        const data = await response.json();
                        console.log('📋 API 签到完整响应:', JSON.stringify(data));

                        if (data.err_no === 0) {
                            return { success: true, message: 'API 签到成功' };
                        } else if (data.err_no === 10001 || data.err_msg?.includes('重复') || data.err_msg?.includes('已经')) {
                            return { success: true, alreadyCheckedIn: true, message: data.err_msg || '今天已经签到过了' };
                        }
                        return { success: false, message: data.err_msg || `API 签到失败 (err_no: ${data.err_no})` };
                    }
                    return { success: false, message: `API 签到请求失败 (${response.status})` };
                } catch (error) {
                    console.error('API 签到异常:', error);
                    return { success: false, message: `API 签到异常: ${error.message}` };
                }
            }
        });

        if (results && results[0] && results[0].result) {
            console.log('✅ API 签到结果:', results[0].result);
            return results[0].result;
        }

        return { success: false, message: 'API 签到无响应' };
    } catch (error) {
        console.error('❌ API 签到失败:', error);
        return { success: false, message: `API 签到失败: ${error.message}` };
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
            const storageResult = await chrome.storage.local.get(['config']);
            config = storageResult.config;
        }

        // 检查 config 是否存在
        if (!config) {
            console.warn('⚠️ config 为空，跳过更新签到状态');
            return;
        }

        const today = new Date().toDateString();

        console.log('📝 更新签到历史，当前结果:', result);
        console.log('📅 当前配置的最后签到日期:', config.lastCheckInDate);
        console.log('📅 今天的日期:', today);

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

            console.log('✅ 更新后的配置:', {
                lastCheckInDate: config.lastCheckInDate,
                consecutiveDays: config.consecutiveDays,
                record: record
            });

            // 保存配置
            await chrome.storage.local.set({ config });
            console.log('✅ 签到历史已更新');

        } else {
            console.log('ℹ️ 今天已经签到过，无需重复更新');
        }
    } catch (error) {
        console.error('❌ 更新签到历史失败:', error);
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
