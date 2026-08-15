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

    // 监听来自background的消息（签到完成后更新状态）
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'checkInCompleted') {
            console.log('收到签到完成通知，刷新状态');
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

    // 计算本月签到天数
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    const thisMonthCheckIns = (config.checkInHistory || []).filter(record => {
        const recordDate = new Date(record.date);
        return recordDate.getMonth() === currentMonth &&
               recordDate.getFullYear() === currentYear &&
               record.status === 'success';
    });

    elements.totalDays.textContent = thisMonthCheckIns.length;
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

        if (response.success) {
            updateStatus('success', '签到成功', '恭喜你完成今日签到');
            elements.manualCheckInBtn.innerHTML = '<span class="btn-icon">✓</span><span>已完成</span>';

            // 刷新统计信息
            setTimeout(async () => {
                const config = await loadConfig();
                await updateCheckInStatus(config);
            }, 1000);
        } else {
            updateStatus('error', '签到失败', response.message || '签到操作失败，请重试');
            elements.manualCheckInBtn.disabled = false;
            elements.manualCheckInBtn.innerHTML = '<span class="btn-icon">📝</span><span>立即签到</span>';
        }

    } catch (error) {
        console.error('手动签到失败:', error);
        updateStatus('error', '签到出错', error.message || '签到过程出现错误');
        elements.manualCheckInBtn.disabled = false;
        elements.manualCheckInBtn.innerHTML = '<span class="btn-icon">📝</span><span>立即签到</span>';
    }
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

