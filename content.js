// content.js - 内容脚本
// 注入到掘金页面，执行具体的签到操作

console.log('掘金签到脚本已注入');

// 监听来自background的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'checkIn') {
        executeCheckIn().then(result => {
            sendResponse(result);
        }).catch(error => {
            sendResponse({ success: false, message: error.message });
        });
        return true; // 保持消息通道开启
    }
});

// 执行签到操作
async function executeCheckIn() {
    try {
        console.log('开始执行签到...');

        // 等待页面加载完成
        await waitForPageReady();

        // 方法1: 尝试找到签到按钮
        const checkInButton = findCheckInButton();
        console.log('签到按钮查找结果:', checkInButton);

        if (checkInButton) {
            // 获取按钮文本进行详细分析
            const buttonText = checkInButton.textContent || checkInButton.innerText || '';
            const buttonClasses = checkInButton.className || '';
            const buttonDisabled = checkInButton.disabled || false;

            console.log('按钮详细信息:', {
                text: buttonText.trim(),
                classes: buttonClasses,
                disabled: buttonDisabled,
                html: checkInButton.innerHTML
            });

            // 检查是否已经签到（通过按钮状态判断）
            if (isAlreadyCheckedIn(buttonText, buttonClasses, buttonDisabled)) {
                console.log('检测到已签到状态');
                return {
                    success: true,
                    message: '今天已经签到过了',
                    alreadyCheckedIn: true
                };
            }

            // 尝试点击签到按钮
            console.log('准备点击签到按钮');
            try {
                checkInButton.click();
                console.log('签到按钮点击成功');
            } catch (clickError) {
                console.error('按钮点击失败:', clickError);
                // 尝试使用其他点击方式
                checkInButton.dispatchEvent(new MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true
                }));
            }

            // 等待签到结果
            await delay(3000);

            // 检查签到后的页面状态
            const afterCheckResult = await checkAfterCheckInStatus();
            console.log('签到后状态检测结果:', afterCheckResult);

            if (afterCheckResult.alreadyCheckedIn) {
                return {
                    success: true,
                    message: '今天已经签到过了',
                    alreadyCheckedIn: true
                };
            } else if (afterCheckResult.success) {
                return {
                    success: true,
                    message: afterCheckResult.message || '签到成功'
                };
            }

            // 默认返回成功
            return {
                success: true,
                message: '签到操作已执行'
            };

        } else {
            console.log('未找到签到按钮，尝试其他方法');

            // 方法2: 检查页面是否显示已签到状态
            const pageStatus = checkPageCheckInStatus();
            if (pageStatus.alreadyCheckedIn) {
                return {
                    success: true,
                    message: '今天已经签到过了',
                    alreadyCheckedIn: true
                };
            }

            // 方法3: 尝试通过API接口签到
            const apiResult = await attemptAPICheckIn();
            if (apiResult.success) {
                return apiResult;
            } else if (apiResult.alreadyCheckedIn) {
                return {
                    success: true,
                    message: '今天已经签到过了',
                    alreadyCheckedIn: true
                };
            }

            // 方法4: 检查用户是否登录
            const isLoggedIn = checkLoginStatus();
            if (!isLoggedIn) {
                return {
                    success: false,
                    message: '请先登录掘金账号'
                };
            }

            return {
                success: false,
                message: '未找到签到按钮，可能页面结构已变化'
            };
        }

    } catch (error) {
        console.error('签到过程出错:', error);
        return {
            success: false,
            message: error.message
        };
    }
}

// 查找签到按钮（使用多种选择器策略）
function findCheckInButton() {
    console.log('开始查找签到按钮...');

    // 定义可能的签到按钮选择器（更全面的覆盖）
    const selectors = [
        // 直接的签到按钮
        '.check-in-btn',
        '.sign-in-btn',
        '[class*="check-in"]',
        '[class*="checkin"]',
        '[class*="sign-in"]',
        '[class*="signin"]',

        // 掘金常见的按钮容器
        '.header-button',
        '.btn',
        'button',

        // 可能的签到相关元素
        '[class*="calendar"]',
        '[class*="lottery"]',  // 签到抽奖相关
        '[class*="growth"]',   // 成长相关
    ];

    // 遍历所有选择器查找按钮
    for (const selector of selectors) {
        try {
            const elements = document.querySelectorAll(selector);
            console.log(`选择器 ${selector} 找到 ${elements.length} 个元素`);

            for (const element of elements) {
                const text = (element.textContent || '').trim();
                const className = element.className || '';

                // 检查是否包含签到相关文字
                if (text.includes('签到') || text.includes('打卡') ||
                    text.includes('Check in') || text.includes('Sign in') ||
                    text.includes('日历') || text.includes('抽签')) {

                    console.log('找到可能的签到按钮:', {
                        text: text,
                        className: className,
                        tag: element.tagName
                    });

                    return element;
                }
            }
        } catch (error) {
            console.log(`选择器 ${selector} 查找失败:`, error);
        }
    }

    // 最后尝试：查找所有可点击元素
    const allClickable = document.querySelectorAll('button, .btn, a, [onclick], [class*="button"]');
    console.log(`尝试从 ${allClickable.length} 个可点击元素中查找`);

    for (const element of allClickable) {
        const text = (element.textContent || '').trim();
        if ((text.includes('签到') || text.includes('打卡')) && text.length < 20) {
            console.log('通过文本匹配找到签到按钮:', text);
            return element;
        }
    }

    console.log('未找到签到按钮');
    return null;
}

// 等待页面准备就绪
async function waitForPageReady() {
    console.log('等待页面准备就绪...');

    // 等掘金页面完全加载
    return new Promise((resolve) => {
        if (document.readyState === 'complete') {
            console.log('页面已完全加载');
            setTimeout(resolve, 1000); // 额外等待1秒确保动态内容加载
        } else {
            window.addEventListener('load', () => {
                console.log('页面加载完成事件触发');
                setTimeout(resolve, 2000); // 等待2秒确保内容加载
            });
        }
    });
}

// 判断是否已经签到
function isAlreadyCheckedIn(buttonText, buttonClasses, buttonDisabled) {
    const text = buttonText.trim().toLowerCase();
    const classes = buttonClasses.toLowerCase();

    console.log('检查签到状态:', { text, classes, disabled: buttonDisabled });

    // 检查按钮文本是否显示已签到
    const alreadyCheckedInPatterns = [
        '已签到',
        '已打卡',
        'checked',
        'completed',
        '完成',
        '明天再来',
        'tomorrow'
    ];

    for (const pattern of alreadyCheckedInPatterns) {
        if (text.includes(pattern.toLowerCase()) || classes.includes(pattern.toLowerCase())) {
            console.log(`匹配到已签到模式: ${pattern}`);
            return true;
        }
    }

    // 检查按钮是否被禁用（已签到的按钮通常会被禁用）
    if (buttonDisabled) {
        console.log('按钮被禁用，可能已签到');
        // 需要结合其他条件判断
        if (text.includes('签到') || text.includes('打卡')) {
            return true;
        }
    }

    return false;
}

// 检查签到后的状态
async function checkAfterCheckInStatus() {
    console.log('检查签到后状态...');

    // 使用延迟函数等待页面更新
    await delay(1000);

    // 再次检查按钮状态
    const checkInButton = findCheckInButton();
    if (checkInButton) {
        const buttonText = (checkInButton.textContent || '').trim();
        const buttonClasses = (checkInButton.className || '').toLowerCase();

        console.log('签到后按钮状态:', buttonText);

        // 检查是否变为已签到状态
        if (buttonText.includes('已签到') || buttonText.includes('已打卡') ||
            buttonClasses.includes('checked') || buttonClasses.includes('disabled')) {
            return {
                success: true,
                message: '签到成功'
            };
        }
    }

    // 检查页面提示信息
    const pageText = document.body.textContent || '';

    // 检查成功提示
    const successPatterns = ['签到成功', '打卡成功', '签到完成', '获得', '领取'];
    for (const pattern of successPatterns) {
        if (pageText.includes(pattern)) {
            return {
                success: true,
                message: `签到成功 - ${pattern}`
            };
        }
    }

    // 检查重复签到提示
    const alreadyCheckedPatterns = ['已经签到', '今日已签到', '重复签到', '已经打卡'];
    for (const pattern of alreadyCheckedPatterns) {
        if (pageText.includes(pattern)) {
            return {
                alreadyCheckedIn: true,
                message: '今天已经签到过了'
            };
        }
    }

    return { success: false, alreadyCheckedIn: false };
}

// 检查页面签到状态
function checkPageCheckInStatus() {
    console.log('检查页面整体签到状态...');

    const pageText = document.body.textContent || '';

    // 检查是否显示已签到状态
    const alreadyCheckedPatterns = [
        '今日已签到',
        '今天已签到',
        '已连续签到',
        '已经签到',
        '已打卡',
        'checked in'
    ];

    for (const pattern of alreadyCheckedPatterns) {
        if (pageText.includes(pattern)) {
            console.log(`页面显示已签到: ${pattern}`);
            return { alreadyCheckedIn: true };
        }
    }

    // 检查页面上的签到日历或状态元素
    const statusElements = document.querySelectorAll('[class*="status"], [class*="calendar"], [class*="check-in"]');
    for (const element of statusElements) {
        const text = (element.textContent || '').toLowerCase();
        if (text.includes('已签到') || text.includes('checked') || text.includes('done')) {
            console.log('元素显示已签到状态:', text);
            return { alreadyCheckedIn: true };
        }
    }

    return { alreadyCheckedIn: false };
}

// 尝试通过API接口签到（需要提取用户的cookie和token）
async function attemptAPICheckIn() {
    try {
        console.log('尝试API签到...');
        const apiUrl = 'https://api.juejin.cn/growth_api/v1/check_in';
        const token = getUserToken();

        if (!token) {
            console.log('无法获取用户token');
            return { success: false, message: '无法获取用户token' };
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            credentials: 'include'
        });

        console.log('API签到响应状态:', response.status);

        if (response.ok) {
            const data = await response.json();
            console.log('API签到响应数据:', data);

            if (data.err_no === 0) {
                return {
                    success: true,
                    message: 'API签到成功',
                    data: data.data
                };
            } else if (data.err_no === 10001 || data.err_msg?.includes('重复') || data.err_msg?.includes('已经')) {
                return {
                    success: false,
                    alreadyCheckedIn: true,
                    message: data.err_msg || '今天已经签到过了'
                };
            } else {
                return {
                    success: false,
                    message: data.err_msg || 'API签到失败'
                };
            }
        }

    } catch (error) {
        console.log('API签到尝试失败:', error);
    }

    return { success: false, message: 'API签到不可用' };
}

// 获取用户token
function getUserToken() {
    try {
        // 尝试从localStorage获取（常见的token键名）
        const tokenKeys = ['token', 'accessToken', 'session', 'sessionId', 'uid', 'userId'];
        for (const key of tokenKeys) {
            const token = localStorage.getItem(key);
            if (token) {
                console.log(`从localStorage获取到token: ${key}`);
                return token;
            }
        }

        // 尝试从sessionStorage获取
        for (const key of tokenKeys) {
            const token = sessionStorage.getItem(key);
            if (token) {
                console.log(`从sessionStorage获取到token: ${key}`);
                return token;
            }
        }

        // 从cookie中获取
        const cookies = document.cookie;
        console.log('当前cookies:', cookies.substring(0, 100) + '...');

        const tokenMatch = cookies.match(/token=([^;]+)/) ||
                          cookies.match(/session=([^;]+)/) ||
                          cookies.match(/sessionId=([^;]+)/);

        if (tokenMatch && tokenMatch[1]) {
            console.log('从cookie获取到token');
            return tokenMatch[1];
        }

    } catch (error) {
        console.log('获取用户token失败:', error);
    }

    return null;
}

// 检查用户登录状态
function checkLoginStatus() {
    // 检查是否存在用户信息元素
    const userElements = [
        '.user-avatar',
        '.user-info',
        '[class*="user"]',
        '.avatar',
        '.header-user',
        '.user-header'
    ];

    for (const selector of userElements) {
        if (document.querySelector(selector)) {
            console.log('检测到用户元素，判断为已登录');
            return true;
        }
    }

    // 检查是否有登录按钮
    const loginButton = document.querySelector('[class*="login"]');
    if (loginButton && loginButton.textContent.includes('登录')) {
        console.log('检测到登录按钮，判断为未登录');
        return false;
    }

    console.log('无法确定登录状态，默认为已登录');
    return true; // 默认假设已登录
}

// 等待元素出现
function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const element = document.querySelector(selector);
        if (element) {
            resolve(element);
            return;
        }

        const observer = new MutationObserver(() => {
            const element = document.querySelector(selector);
            if (element) {
                observer.disconnect();
                resolve(element);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // 设置超时
        setTimeout(() => {
            observer.disconnect();
            reject(new Error(`等待元素超时: ${selector}`));
        }, timeout);
    });
}

// 延迟函数
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 页面加载完成后自动执行（可选）
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('掘金页面加载完成');
        // 这里可以添加页面加载后的自动操作
    });
} else {
    console.log('掘金页面已就绪');
}
