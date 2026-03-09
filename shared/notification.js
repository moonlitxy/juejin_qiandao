// shared/notification.js - 统一的通知系统

/**
 * 显示桌面通知（在 background.js 中使用）
 *
 * @param {string} title - 通知标题
 * @param {string} message - 通知内容
 * @param {string} iconUrl - 图标URL（可选）
 */
function showDesktopNotification(title, message, iconUrl = null) {
    chrome.notifications.create({
        type: 'basic',
        iconUrl: iconUrl || 'icons/icon48.png',
        title: title,
        message: message
    });
}

/**
 * 显示页面内通知（在 popup.js 和 options.js 中使用）
 * 带动画效果的通知，自动在3秒后消失
 *
 * @param {string} message - 通知内容
 * @param {string} type - 通知类型：'success', 'error', 'info'
 */
function showPageNotification(message, type = 'info') {
    // 确保页面中有通知容器
    let container = document.getElementById('notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notification-container';
        container.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 10px;
        `;
        document.body.appendChild(container);
    }

    // 创建通知元素
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;

    // 根据类型设置颜色
    const colors = {
        success: '#4caf50',
        error: '#f44336',
        info: '#2196f3'
    };

    notification.style.cssText = `
        background: ${colors[type] || colors.info};
        color: white;
        padding: 12px 24px;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        animation: slideIn 0.3s ease-out;
        min-width: 200px;
        max-width: 400px;
    `;

    notification.textContent = message;

    // 确保动画样式存在
    if (!document.getElementById('notification-styles')) {
        const style = document.createElement('style');
        style.id = 'notification-styles';
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
    }

    // 添加到容器
    container.appendChild(notification);

    // 3秒后移除
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

/**
 * 显示成功通知（便捷方法）
 * @param {string} message - 通知内容
 */
function showSuccess(message) {
    showPageNotification(message, 'success');
}

/**
 * 显示错误通知（便捷方法）
 * @param {string} message - 通知内容
 */
function showError(message) {
    showPageNotification(message, 'error');
}

/**
 * 显示信息通知（便捷方法）
 * @param {string} message - 通知内容
 */
function showInfo(message) {
    showPageNotification(message, 'info');
}
