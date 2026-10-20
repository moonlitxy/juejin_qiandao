// shared/messaging.js - 统一的消息通信工具

/**
 * 发送消息到 background script
 * 将 chrome.runtime.sendMessage 包装为 Promise，统一错误处理
 *
 * 「Receiving end does not exist」是 MV3 下的常见瞬时错误：弹窗打开时
 * service worker 可能尚未启动完成，或刚从休眠中被唤醒。这种情况重试一次
 * 通常就成功，所以内置一次短暂延迟后的重试；其余错误立即抛出。
 * 注意：重试仅限发送阶段的失败，不会重复执行后台动作。
 *
 * @param {Object} message - 要发送的消息对象
 * @returns {Promise<Object>} 消息响应
 *
 * @example
 * const response = await sendMessage({ action: 'getConfig' });
 * console.log(response.config);
 */
function sendMessage(message) {
    const attempt = (retriesLeft) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (!chrome.runtime.lastError) {
                resolve(response);
                return;
            }

            const error = chrome.runtime.lastError;
            const text = error.message || String(error);
            const isChannelDown = text.includes('Receiving end does not exist') ||
                text.includes('message channel closed') ||
                text.includes('Extension context invalidated');

            if (isChannelDown && retriesLeft > 0) {
                // 等 service worker 起来再试一次
                setTimeout(() => resolve(attempt(retriesLeft - 1)), 300);
                return;
            }
            // 传 Error 而非 lastError 对象，调用方打印时可以读到 message
            reject(new Error(text));
        });
    });

    return attempt(1);
}

/**
 * 从任意错误对象中取出可读的错误信息
 * chrome.runtime.lastError 是对象，直接插进模板会打印成 [object Object]
 * @param {*} error
 * @returns {string}
 */
function describeError(error) {
    if (!error) {
        return '未知错误';
    }
    return error.message || String(error);
}
