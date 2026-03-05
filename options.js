// options.js - 设置页面脚本

// 默认配置
const defaultConfig = {
    enabled: true,
    checkInTime: '09:00',
    successNotification: true,
    failureNotification: true,
    retryCount: 1,
    loadTimeout: 30
};

// 当前配置
let currentConfig = { ...defaultConfig };

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

        // 合并配置
        currentConfig = { ...defaultConfig, ...savedConfig };

        // 更新UI
        elements.enabledToggle.checked = currentConfig.enabled;
        elements.checkInTime.value = currentConfig.checkInTime;
        elements.successNotification.checked = currentConfig.successNotification;
        elements.failureNotification.checked = currentConfig.failureNotification;
        elements.retryCount.value = currentConfig.retryCount;
        elements.loadTimeout.value = currentConfig.loadTimeout;

    } catch (error) {
        console.error('加载配置失败:', error);
        showNotification('加载配置失败', 'error');
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

        showNotification('设置已保存', 'success');

    } catch (error) {
        console.error('保存配置失败:', error);
        showNotification('保存配置失败', 'error');
    }
}

// 重置配置
async function resetConfig() {
    try {
        // 重置为默认配置
        await sendMessage({
            action: 'updateConfig',
            config: defaultConfig
        });

        // 更新当前配置
        currentConfig = { ...defaultConfig };

        // 更新UI
        elements.enabledToggle.checked = defaultConfig.enabled;
        elements.checkInTime.value = defaultConfig.checkInTime;
        elements.successNotification.checked = defaultConfig.successNotification;
        elements.failureNotification.checked = defaultConfig.failureNotification;
        elements.retryCount.value = defaultConfig.retryCount;
        elements.loadTimeout.value = defaultConfig.loadTimeout;

        showNotification('设置已重置', 'success');

    } catch (error) {
        console.error('重置配置失败:', error);
        showNotification('重置配置失败', 'error');
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

        showNotification('历史记录已清空', 'success');

    } catch (error) {
        console.error('清空历史记录失败:', error);
        showNotification('清空历史记录失败', 'error');
    }
}

// 发送消息到background
function sendMessage(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(response);
            }
        });
    });
}

// 显示通知
function showNotification(message, type = 'info') {
    // 创建通知元素
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;

    // 添加样式
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? '#4caf50' : type === 'error' ? '#f44336' : '#2196f3'};
        color: white;
        padding: 12px 24px;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 10000;
        animation: slideIn 0.3s ease-out;
    `;

    // 添加动画
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from {
                transform: translateX(400px);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        @keyframes slideOut {
            from {
                transform: translateX(0);
                opacity: 1;
            }
            to {
                transform: translateX(400px);
                opacity: 0;
            }
        }
    `;
    document.head.appendChild(style);

    // 添加到页面
    document.body.appendChild(notification);

    // 3秒后移除
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 300);
    }, 3000);
}
