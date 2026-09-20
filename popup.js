// popup.js - 弹出窗口脚本
// 依赖：shared/config.js, shared/messaging.js, shared/notification.js

// DOM元素引用
const elements = {
    statusIcon: null,
    statusTitle: null,
    statusDesc: null,
    consecutiveDays: null,
    totalDays: null,
    lastCheckInTime: null,
    manualCheckInBtn: null,
    openJuejinBtn: null,
    autoCheckInToggle: null,
    checkInTime: null,
    optionsBtn: null
};

// 手动签到等待状态：background 可能把签到转入重试（pending），
// 最终结果由 checkInCompleted 广播送达，期间按钮保持"签到中..."
let manualCheckInWaiting = false;
let manualCheckInTimeoutId = null;

// 等待广播的超时兜底（毫秒）。签到链路含重试可能持续数十秒，
// 超时后恢复按钮，避免永远卡在"签到中..."
const MANUAL_CHECKIN_TIMEOUT = 90000;

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    // 获取DOM元素
    elements.statusIcon = document.getElementById('statusIcon');
    elements.statusTitle = document.getElementById('statusTitle');
    elements.statusDesc = document.getElementById('statusDesc');
    elements.consecutiveDays = document.getElementById('consecutiveDays');
    elements.totalDays = document.getElementById('totalDays');
    elements.lastCheckInTime = document.getElementById('lastCheckInTime');
    elements.manualCheckInBtn = document.getElementById('manualCheckInBtn');
    elements.openJuejinBtn = document.getElementById('openJuejinBtn');
    elements.autoCheckInToggle = document.getElementById('autoCheckInToggle');
    elements.checkInTime = document.getElementById('checkInTime');
    elements.optionsBtn = document.getElementById('optionsBtn');

    // 绑定事件监听器
    bindEventListeners();

    // 加载配置并更新UI（合并为一次存储读取）
    const config = await loadConfig();

    // 更新签到状态（传入已读取的 config，避免重复读取）
    updateCheckInStatus(config);

    // 与服务端核对一次：本地可能没有记录（网页签到 / 多设备 / 重装），
    // 否则会误显示"未签到"
    syncCheckInStatusFromServer();

    // 监听来自background的消息（签到完成后更新状态）
    // background 现在成功和失败都会广播 checkInCompleted，UI 以它为准
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'checkInCompleted') {
            console.log('收到签到完成通知，刷新状态:', request.result);

            // 手动签到正在等最终结果，先定案（按钮与提示）
            if (manualCheckInWaiting) {
                finishManualCheckIn(request.result);
            }

            // 再统一刷新状态区与统计
            loadConfig().then(config => {
                updateCheckInStatus(config);
            });
        }
    });
});

// 绑定事件监听器
function bindEventListeners() {
    // 手动签到按钮
    elements.manualCheckInBtn.addEventListener('click', async () => {
        await handleManualCheckIn();
    });

    // 打开掘金网站
    elements.openJuejinBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://juejin.cn' });
    });

    // 自动签到开关
    elements.autoCheckInToggle.addEventListener('change', async (event) => {
        await updateConfig({ enabled: event.target.checked });
    });

    // 签到时间输入
    elements.checkInTime.addEventListener('change', async (event) => {
        await updateConfig({ checkInTime: event.target.value });
    });

    // 打开设置页面
    elements.optionsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
}

// 加载配置（返回 config 对象，避免重复读取存储）
async function loadConfig() {
    try {
        const response = await sendMessage({ action: 'getConfig' });
        const config = response.config || {};

        // 更新UI状态
        elements.autoCheckInToggle.checked = config.enabled !== false;
        elements.checkInTime.value = config.checkInTime || '09:00';

        // 更新统计信息
        updateStatistics(config);

        // 返回 config 供其他函数使用
        return config;

    } catch (error) {
        console.error('加载配置失败:', error);
        showError('加载配置失败');
        return null;
    }
}

// 与服务端核对签到状态；本地记录被补齐时刷新 UI
async function syncCheckInStatusFromServer() {
    try {
        const response = await sendMessage({ action: 'syncCheckInStatus' });
        if (response && response.synced) {
            console.log('服务端已签到但本地无记录，已补齐，刷新 UI');
            const config = await loadConfig();
            updateCheckInStatus(config);
        }
    } catch (error) {
        console.warn('同步服务端签到状态失败:', error);
    }
}

// 更新签到状态（接收 config 参数，避免重复读取存储）
function updateCheckInStatus(config) {
    try {
        if (!config) {
            console.warn('config 为空，跳过更新签到状态');
            return;
        }

        console.log('Popup更新签到状态，当前配置:', config);

        // 检查今天是否已签到
        const today = new Date().toDateString();
        const lastCheckIn = config.lastCheckInDate;
        const hasCheckedInToday = lastCheckIn === today;

        console.log('签到状态检查:', {
            today: today,
            lastCheckIn: lastCheckIn,
            hasCheckedInToday: hasCheckedInToday
        });

        if (hasCheckedInToday) {
            // 已签到
            console.log('显示已签到状态');
            updateStatus('success', '今日已签到', '你今天已经完成签到了');
            elements.manualCheckInBtn.disabled = true;
            elements.manualCheckInBtn.textContent = '已完成';
        } else {
            // 未签到
            console.log('显示未签到状态');
            updateStatus('pending', '未签到', '今天还没有签到，快去签到吧');
            elements.manualCheckInBtn.disabled = false;
            elements.manualCheckInBtn.innerHTML = '<span class="btn-icon">📝</span><span>立即签到</span>';
        }

        // 更新上次签到时间
        updateLastCheckInTime(config.lastCheckInDate);

        // 更新统计信息
        updateStatistics(config);

    } catch (error) {
        console.error('更新签到状态失败:', error);
        updateStatus('error', '状态未知', '无法获取签到状态');
    }
}

// 更新统计信息
function updateStatistics(config) {
    // 连续签到天数
    elements.consecutiveDays.textContent = config.consecutiveDays || 0;

    // 本月签到天数：优先用服务端统计（打开时 syncCheckInStatus 会刷新），
    // 月份不符或缺失时回退到本地历史推算
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    let totalDays;
    if (config.monthCheckInMonth === monthKey && Number.isInteger(config.monthCheckInCount)) {
        totalDays = config.monthCheckInCount;
    } else {
        const thisMonthCheckIns = (config.checkInHistory || []).filter(record => {
            const recordDate = new Date(record.date);
            return recordDate.getMonth() === now.getMonth() &&
                   recordDate.getFullYear() === now.getFullYear() &&
                   record.status === 'success';
        });
        totalDays = thisMonthCheckIns.length;
    }

    elements.totalDays.textContent = totalDays;
}

// 更新上次签到时间
function updateLastCheckInTime(lastCheckInDate) {
    if (!lastCheckInDate) {
        elements.lastCheckInTime.textContent = '上次签到: 从未';
        return;
    }

    const lastDate = new Date(lastCheckInDate);
    const now = new Date();
    const diffTime = Math.abs(now - lastDate);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    let timeText;
    if (diffDays === 0) {
        timeText = '今天';
    } else if (diffDays === 1) {
        timeText = '昨天';
    } else if (diffDays < 7) {
        timeText = `${diffDays}天前`;
    } else {
        timeText = lastDate.toLocaleDateString('zh-CN');
    }

    elements.lastCheckInTime.textContent = `上次签到: ${timeText}`;
}

// 更新状态显示
function updateStatus(status, title, desc) {
    // 更新图标
    elements.statusIcon.className = 'status-icon';
    if (status === 'success') {
        elements.statusIcon.textContent = '✓';
    } else if (status === 'error') {
        elements.statusIcon.classList.add('error');
        elements.statusIcon.textContent = '✗';
    } else if (status === 'pending') {
        elements.statusIcon.classList.add('pending');
        elements.statusIcon.textContent = '⏰';
    }

    // 更新文本
    elements.statusTitle.textContent = title;
    elements.statusDesc.textContent = desc;
}

// 处理手动签到
async function handleManualCheckIn() {
    try {
        // 禁用按钮，显示加载状态
        elements.manualCheckInBtn.disabled = true;
        elements.manualCheckInBtn.innerHTML = '<span class="btn-icon">⏳</span><span>签到中...</span>';

        // 发送签到请求
        const response = await sendMessage({ action: 'manualCheckIn' });

        // pending：background 已把签到转入重试，最终结果由 checkInCompleted 广播送达
        if (response && response.pending) {
            console.log('签到已转入重试，等待最终结果广播...');
            manualCheckInWaiting = true;
            manualCheckInTimeoutId = setTimeout(() => {
                manualCheckInWaiting = false;
                manualCheckInTimeoutId = null;
                elements.manualCheckInBtn.disabled = false;
                elements.manualCheckInBtn.innerHTML = '<span class="btn-icon">📝</span><span>立即签到</span>';
                showError('签到结果未确认，请留意桌面通知');
            }, MANUAL_CHECKIN_TIMEOUT);
            return;
        }

        // 非 pending：结果已确定，直接定案
        finishManualCheckIn(response);

    } catch (error) {
        console.error('手动签到失败:', error);
        resetManualCheckInWaiting();
        elements.manualCheckInBtn.disabled = false;
        elements.manualCheckInBtn.innerHTML = '<span class="btn-icon">📝</span><span>立即签到</span>';
        showError(error.message || '签到过程出现错误');
    }
}

// 清理手动签到的等待状态与超时定时器
function resetManualCheckInWaiting() {
    manualCheckInWaiting = false;
    if (manualCheckInTimeoutId) {
        clearTimeout(manualCheckInTimeoutId);
        manualCheckInTimeoutId = null;
    }
}

// 手动签到定案：成功保持完成态，失败恢复按钮并用页面内通知告知原因
// 状态区与按钮文案统一交给 updateCheckInStatus 依据 config 刷新，此处不直接改状态文字
function finishManualCheckIn(result) {
    resetManualCheckInWaiting();

    const ok = result && (result.success || result.alreadyCheckedIn);

    if (!ok) {
        elements.manualCheckInBtn.disabled = false;
        elements.manualCheckInBtn.innerHTML = '<span class="btn-icon">📝</span><span>立即签到</span>';
        showError((result && result.message) || '签到失败，请重试');
        return;
    }

    showSuccess(result.message || '签到成功');
}

// 更新配置
async function updateConfig(updates) {
    try {
        const response = await sendMessage({ action: 'getConfig' });
        const config = { ...response.config, ...updates };

        await sendMessage({
            action: 'updateConfig',
            config: config
        });

        showSuccess('设置已保存');

    } catch (error) {
        console.error('更新配置失败:', error);
        showError('保存设置失败');
    }
}

// 注意：以下函数已移至共享脚本，避免重复定义
// - sendMessage() -> shared/messaging.js
// - showSuccess() -> shared/notification.js
// - showError() -> shared/notification.js

