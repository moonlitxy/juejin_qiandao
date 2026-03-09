// options.js - 设置页面脚本
// 依赖：shared/config.js, shared/messaging.js, shared/notification.js

// 当前配置（使用 shared/config.js 中的 DEFAULT_CONFIG）
let currentConfig = { ...DEFAULT_CONFIG };

// DOM元素
const elements = {
    enabledToggle: null,
    checkInTime: null,
    successNotification: null,
    failureNotification: null,
    retryCount: null,
    loadTimeout: null,
    historyList: null,
    saveBtn: null,
    resetBtn: null,
    clearHistoryBtn: null
};

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    // 获取DOM元素
    elements.enabledToggle = document.getElementById('enabledToggle');
    elements.checkInTime = document.getElementById('checkInTime');
    elements.successNotification = document.getElementById('successNotification');
    elements.failureNotification = document.getElementById('failureNotification');
    elements.retryCount = document.getElementById('retryCount');
    elements.loadTimeout = document.getElementById('loadTimeout');
    elements.historyList = document.getElementById('historyList');
    elements.saveBtn = document.getElementById('saveBtn');
    elements.resetBtn = document.getElementById('resetBtn');
    elements.clearHistoryBtn = document.getElementById('clearHistoryBtn');

    // 绑定事件
    bindEventListeners();

    // 加载配置
    await loadConfig();

    // 加载签到历史
    await loadHistory();
});

// 绑定事件监听器
function bindEventListeners() {
    // 保存按钮
    elements.saveBtn.addEventListener('click', async () => {
        await saveConfig();
    });

    // 重置按钮
    elements.resetBtn.addEventListener('click', async () => {
        if (confirm('确定要重置所有设置吗？')) {
            await resetConfig();
        }
    });

    // 清空历史按钮
    elements.clearHistoryBtn.addEventListener('click', async () => {
        if (confirm('确定要清空所有签到历史记录吗？')) {
            await clearHistory();
        }
    });
}

// 加载配置
async function loadConfig() {
    try {
        const response = await sendMessage({ action: 'getConfig' });
        const savedConfig = response.config || {};

        // 合并配置（使用 shared/config.js 中的 DEFAULT_CONFIG）
        currentConfig = { ...DEFAULT_CONFIG, ...savedConfig };

        // 更新UI
        elements.enabledToggle.checked = currentConfig.enabled;
        elements.checkInTime.value = currentConfig.checkInTime;
        elements.successNotification.checked = currentConfig.successNotification;
        elements.failureNotification.checked = currentConfig.failureNotification;
        elements.retryCount.value = currentConfig.retryCount;
        elements.loadTimeout.value = currentConfig.loadTimeout;

    } catch (error) {
        console.error('加载配置失败:', error);
        showPageNotification('加载配置失败', 'error');
    }
}

// 保存配置
async function saveConfig() {
    try {
        // 收集表单数据
        const newConfig = {
            enabled: elements.enabledToggle.checked,
            checkInTime: elements.checkInTime.value,
            successNotification: elements.successNotification.checked,
            failureNotification: elements.failureNotification.checked,
            retryCount: parseInt(elements.retryCount.value),
            loadTimeout: parseInt(elements.loadTimeout.value)
        };

        // 发送到background
        await sendMessage({
            action: 'updateConfig',
            config: newConfig
        });

        // 更新当前配置
        currentConfig = newConfig;

        showPageNotification('设置已保存', 'success');

    } catch (error) {
        console.error('保存配置失败:', error);
        showPageNotification('保存配置失败', 'error');
    }
}

// 重置配置
async function resetConfig() {
    try {
        // 重置为默认配置（使用 shared/config.js 中的 DEFAULT_CONFIG）
        await sendMessage({
            action: 'updateConfig',
            config: DEFAULT_CONFIG
        });

        // 更新当前配置
        currentConfig = { ...DEFAULT_CONFIG };

        // 更新UI
        elements.enabledToggle.checked = DEFAULT_CONFIG.enabled;
        elements.checkInTime.value = DEFAULT_CONFIG.checkInTime;
        elements.successNotification.checked = DEFAULT_CONFIG.successNotification;
        elements.failureNotification.checked = DEFAULT_CONFIG.failureNotification;
        elements.retryCount.value = DEFAULT_CONFIG.retryCount;
        elements.loadTimeout.value = DEFAULT_CONFIG.loadTimeout;

        showPageNotification('设置已重置', 'success');

    } catch (error) {
        console.error('重置配置失败:', error);
        showPageNotification('重置配置失败', 'error');
    }
}

// 加载签到历史
async function loadHistory() {
    try {
        const response = await sendMessage({ action: 'getConfig' });
        const config = response.config || {};
        const history = config.checkInHistory || [];

        // 清空列表
        elements.historyList.innerHTML = '';

        if (history.length === 0) {
            elements.historyList.innerHTML = '<div class="empty-history">暂无签到记录</div>';
            return;
        }

        // 渲染历史记录
        history.forEach(record => {
            const item = createHistoryItem(record);
            elements.historyList.appendChild(item);
        });

    } catch (error) {
        console.error('加载历史记录失败:', error);
    }
}

// 创建历史记录项
function createHistoryItem(record) {
    const div = document.createElement('div');
    div.className = `history-item ${record.status}`;

    const date = new Date(record.date);
    const dateStr = date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });

    const statusText = record.status === 'success' ? '成功' : '失败';

    div.innerHTML = `
        <div class="history-date">${dateStr}</div>
        <div class="history-status">${statusText}</div>
        ${record.message ? `<div class="history-message">${record.message}</div>` : ''}
    `;

    return div;
}

// 清空历史记录
async function clearHistory() {
    try {
        const response = await sendMessage({ action: 'getConfig' });
        const config = response.config || {};

        // 清空历史
        config.checkInHistory = [];

        // 保存配置
        await sendMessage({
            action: 'updateConfig',
            config: config
        });

        // 重新加载历史
        await loadHistory();

        showPageNotification('历史记录已清空', 'success');

    } catch (error) {
        console.error('清空历史记录失败:', error);
        showPageNotification('清空历史记录失败', 'error');
    }
}

// 注意：以下函数已移至共享脚本，避免重复定义
// - sendMessage() -> shared/messaging.js
// - showNotification() -> shared/notification.js (更名为 showPageNotification)

