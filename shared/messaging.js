// shared/messaging.js - 统一的消息通信工具

/**
 * 发送消息到 background script
 * 将 chrome.runtime.sendMessage 包装为 Promise，统一错误处理
 *
 * @param {Object} message - 要发送的消息对象
 * @returns {Promise<Object>} 消息响应
 *
 * @example
 * const response = await sendMessage({ action: 'getConfig' });
 * console.log(response.config);
 */
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

/**
 * 发送消息到指定的 tab（仅在 background.js 中使用）
 * 将 chrome.tabs.sendMessage 包装为 Promise
 *
 * @param {number} tabId - 目标标签页ID
 * @param {Object} message - 要发送的消息对象
 * @returns {Promise<Object>} 消息响应
 *
 * @example
 * const response = await sendTabMessage(tabId, { action: 'checkIn' });
 */
function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(response);
            }
        });
    });
}
