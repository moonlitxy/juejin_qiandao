// content.js - 内容脚本
// 注入到掘金页面，执行具体的签到操作

console.log('掘金签到脚本已注入');

// 监听来自background的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('📨 收到消息:', request.action);

    // ping/pong 机制 - 用于测试 content script 是否准备好
    if (request.action === 'ping') {
        console.log('🏓 收到 ping，回复 pong');
        sendResponse({ action: 'pong', status: 'ready' });
        return true;
    }

    if (request.action === 'checkIn') {
        executeCheckIn().then(result => {
            console.log('✅ 签到执行完成，返回结果:', result);
            sendResponse(result);
        }).catch(error => {
            console.error('❌ 签到执行出错:', error);
            sendResponse({ success: false, message: error.message });
        });
        return true; // 保持消息通道开启
    }

    return true;
});

// 执行签到操作
async function executeCheckIn() {
    try {
        console.log('===== 开始执行签到 =====');

        // 等待页面加载完成
        await waitForPageReady();

        // 检查当前页面是否是签到页面
        const currentUrl = window.location.href;
        console.log('当前页面 URL:', currentUrl);

        // 【优先检查】先通过 API 检查今日签到状态（最准确）
        console.log('【步骤 0】通过 API 检查签到状态...');
        const apiStatus = await checkTodayCheckInStatus();
        if (apiStatus) {
            console.log('✅ API 返回今日已签到');
            return {
                success: true,
                message: '今天已经签到过了',
                alreadyCheckedIn: true
            };
        } else {
            console.log('⚠️ API 返回今日未签到，继续执行签到流程');
        }

        // 如果已经在签到页面，直接执行签到
        if (currentUrl.includes('checkin') || currentUrl.includes('lottery')) {
            console.log('已在签到页面，直接执行签到');
            return await performActualCheckIn();
        }

        // 在首页，先检查是否已经签到
        console.log('在首页，检查首页签到状态...');
        const checkInStatus = checkHomePageCheckInStatus();
        if (checkInStatus.alreadyCheckedIn) {
            console.log('✅ 首页显示已签到，今天已经签到过了');
            return {
                success: true,
                message: '今天已经签到过了',
                alreadyCheckedIn: true
            };
        }

        // 首页显示未签到，尝试点击"去签到"按钮跳转
        console.log('首页显示未签到，尝试点击"去签到"按钮...');
        const goToCheckInButton = findGoToCheckInButton();
        if (goToCheckInButton) {
            console.log('✅ 找到"去签到"按钮，准备点击');
            console.log('按钮信息:', {
                tag: goToCheckInButton.tagName,
                text: goToCheckInButton.textContent?.trim(),
                href: goToCheckInButton.href
            });

            // 获取签到页面 URL
            let checkInUrl = null;
            if (goToCheckInButton.tagName === 'A' && goToCheckInButton.href) {
                checkInUrl = goToCheckInButton.href;
            } else {
                // 如果是按钮，尝试通过其他方式获取 URL
                const onclickAttr = goToCheckInButton.getAttribute('onclick');
                if (onclickAttr && onclickAttr.includes('http')) {
                    const urlMatch = onclickAttr.match(/https?:\/\/[^"'\s]+/);
                    if (urlMatch) {
                        checkInUrl = urlMatch[0];
                    }
                }
            }

            if (checkInUrl) {
                console.log('📍 找到签到页面 URL:', checkInUrl);
                // 不直接跳转，而是告诉 background 需要跳转
                console.log('⚠️ 需要跳转到签到页面，让 background 处理');
                // 返回特殊响应，让 background 处理跳转
                return {
                    success: false,
                    needRedirect: true,
                    redirectUrl: checkInUrl,
                    message: '需要跳转到签到页面'
                };
            }

            // 如果找不到 URL，尝试点击按钮（可能导致页面跳转）
            console.log('⚠️ 未找到 URL，尝试点击按钮');
            try {
                goToCheckInButton.click();
                console.log('✅ 点击成功，等待页面跳转...');

                // 等待页面跳转（最多10秒）
                for (let i = 0; i < 10; i++) {
                    await delay(1000);
                    const newUrl = window.location.href;
                    if (newUrl !== currentUrl && (newUrl.includes('checkin') || newUrl.includes('lottery'))) {
                        console.log('✅ 已跳转到签到页面，等待加载...');
                        await delay(3000);
                        console.log('在新页面重新执行签到...');
                        return await performActualCheckIn();
                    }
                }
                console.log('⚠️ 等待跳转超时');
            } catch (e) {
                console.error('❌ 点击失败:', e);
            }
        } else {
            console.log('⚠️ 未找到"去签到"按钮');
        }

        // 最后尝试：直接在当前页面查找签到按钮
        console.log('尝试在当前页面查找签到按钮');
        return await performActualCheckIn();

    } catch (error) {
        console.error('签到过程出错:', error);
        return {
            success: false,
            message: error.message
        };
    }
}

// 检查首页的签到状态
function checkHomePageCheckInStatus() {
    console.log('检查首页签到状态...');

    const goToCheckInButton = findGoToCheckInButton();
    if (goToCheckInButton) {
        const buttonText = (goToCheckInButton.textContent || '').trim();
        console.log('首页签到按钮文本:', buttonText);

        // 如果按钮显示"已签到"，说明今天已经签到过了
        if (buttonText === '已签到' || buttonText.includes('已签到')) {
            console.log('首页显示已签到');
            return { alreadyCheckedIn: true };
        }

        console.log('首页显示未签到');
        return { alreadyCheckedIn: false };
    }

    console.log('未找到首页签到按钮');
    return { alreadyCheckedIn: false };
}

// 查找"去签到"按钮（首页）
function findGoToCheckInButton() {
    console.log('开始查找首页"去签到"按钮...');

    const selectors = [
        // 直接签到按钮（按优先级排序）
        'a[href*="signin"]',
        'a[href*="checkin"]',
        'a[href*="lottery"]',
        '.signin-btn',
        '.check-in-btn',
        '[class*="signin"]',
        '[class*="check-in"]',
        'a',
        'button',
        '.btn'
    ];

    for (const selector of selectors) {
        try {
            const elements = document.querySelectorAll(selector);
            console.log(`选择器 "${selector}" 找到 ${elements.length} 个元素`);

            for (const element of elements) {
                const text = (element.textContent || '').trim();
                // 优先精确匹配"去签到"，其次是包含"去签到"
                if (text === '去签到' || text === '立即签到' || text.includes('去签到')) {
                    console.log('✅ 找到签到按钮:', {
                        text: text,
                        tag: element.tagName,
                        href: element.href,
                        className: element.className
                    });
                    return element;
                }
            }
        } catch (error) {
            console.log(`选择器 "${selector}" 查找失败:`, error);
        }
    }

    return null;
}

// 执行实际的签到操作（在签到页面）
async function performActualCheckIn() {
    console.log('===== 开始执行实际签到操作 =====');

    // 等待页面加载完成
    await waitForPageReady();

    // 【步骤 1】先通过 API 检查今日签到状态
    console.log('【步骤 1】检查今日签到状态...');
    const alreadyChecked = await checkTodayCheckInStatus();
    if (alreadyChecked) {
        console.log('✅ 今日已签到，无需重复签到');
        return {
            success: true,
            message: '今天已经签到过了',
            alreadyCheckedIn: true
        };
    } else {
        console.log('⚠️ 今日尚未签到');
    }

    // 【步骤 2】查找签到按钮
    console.log('【步骤 2】查找签到按钮...');
    const checkInButton = findCheckInButton();
    console.log('签到按钮查找结果:', checkInButton ? '找到' : '未找到');

    if (!checkInButton) {
        console.log('❌ 未找到签到按钮');

        // 检查页面是否显示已签到状态
        const pageStatus = checkPageCheckInStatus();
        if (pageStatus.alreadyCheckedIn) {
            return {
                success: true,
                message: '今天已经签到过了',
                alreadyCheckedIn: true
            };
        }

        // 检查用户是否登录
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

    // 获取按钮信息
    const buttonText = checkInButton.textContent || checkInButton.innerText || '';
    const buttonClasses = checkInButton.className || '';
    const buttonDisabled = checkInButton.disabled || false;

    console.log('📋 按钮详细信息:', {
        text: buttonText.trim(),
        classes: buttonClasses,
        disabled: buttonDisabled
    });

    // 【步骤 3】通过按钮状态再次检查（辅助判断）
    console.log('【步骤 3】通过按钮状态检查...');
    if (isAlreadyCheckedIn(buttonText, buttonClasses, buttonDisabled)) {
        console.log('⚠️ 按钮状态显示已签到（可能与 API 状态不一致）');
        // 以 API 状态为准，这里仅作为警告
    }

    // 【步骤 4】点击签到按钮
    console.log('【步骤 4】点击签到按钮...');

    // 记录点击前的页面状态
    console.log('📸 点击前页面状态快照:');
    console.log('  - URL:', window.location.href);
    console.log('  - 按钮文本:', buttonText);
    console.log('  - 按钮禁用:', buttonDisabled);
    console.log('  - 按钮可见:', checkInButton.offsetParent !== null);

    // 尝试监听网络请求（如果有）
    let networkRequests = [];
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        console.log('🌐 检测到 fetch 请求:', args[0]);
        networkRequests.push(args[0]);
        return originalFetch.apply(this, args);
    };

    try {
        checkInButton.click();
        console.log('✅ 签到按钮点击成功');

        // 等待一小段时间，检查是否有网络请求
        await delay(1000);
        if (networkRequests.length > 0) {
            console.log('📡 检测到网络请求:', networkRequests);
        } else {
            console.log('⚠️ 未检测到网络请求，可能点击未生效');
        }
    } catch (clickError) {
        console.error('❌ 按钮点击失败:', clickError);
        try {
            checkInButton.dispatchEvent(new MouseEvent('click', {
                view: window,
                bubbles: true,
                cancelable: true
            }));
            console.log('✅ dispatchEvent 点击完成');
        } catch (e) {
            console.error('❌ 所有点击方式都失败:', e);
            return {
                success: false,
                message: '无法点击签到按钮'
            };
        }
    }

    // 恢复原始 fetch
    window.fetch = originalFetch;

    // 【步骤 5】查找并点击"领取矿石"按钮（如果有）
    console.log('【步骤 5】查找并点击领取矿石按钮...');
    await delay(2000); // 等待签到请求完成
    const claimButton = findClaimButton();
    if (claimButton) {
        console.log('✅ 找到领取矿石按钮，点击领取');
        try {
            claimButton.click();
            console.log('✅ 领取矿石按钮点击成功');
            await delay(2000);
        } catch (e) {
            console.error('⚠️ 点击领取矿石失败:', e);
        }
    } else {
        console.log('ℹ️ 未找到领取矿石按钮，可能自动领取或已完成');
    }

    // 【步骤 6】等待并验证签到结果（核心验证）
    console.log('【步骤 6】验证签到结果...');

    // 多次尝试验证，增加延迟确保 API 请求完成
    let finalCheck = null;
    const maxVerifyAttempts = 3;

    for (let attempt = 1; attempt <= maxVerifyAttempts; attempt++) {
        console.log(`🔍 验证尝试 ${attempt}/${maxVerifyAttempts}...`);

        // 每次尝试等待更长时间
        const waitTime = attempt * 2000; // 2s, 4s, 6s
        await delay(waitTime);

        finalCheck = await checkAfterCheckInStatus(checkInButton);

        if (finalCheck.success) {
            console.log(`✅✅✅ 签到成功！（第 ${attempt} 次验证）`);
            return {
                success: true,
                message: finalCheck.message || '签到成功！'
            };
        } else {
            console.log(`⚠️ 第 ${attempt} 次验证未通过，继续等待...`);
        }
    }

    // 【备用方案】所有验证都失败，尝试使用 API 直接签到
    console.log('❌ 所有 UI 验证尝试都失败');
    console.log('🔧 尝试备用方案：API 直接签到...');

    const apiResult = await attemptAPICheckIn();
    if (apiResult.success || apiResult.alreadyCheckedIn) {
        console.log('✅ API 签到成功！');
        return {
            success: true,
            message: apiResult.message || '签到成功（API 方式）'
        };
    }

    console.log('❌❌❌ UI 验证和 API 签到都失败');
    return {
        success: false,
        message: finalCheck?.message || '签到操作已执行，但无法确认是否成功，请手动检查'
    };
}

// 查找签到按钮（使用多种选择器策略）
function findCheckInButton() {
    console.log('开始查找签到按钮...');

    // 定义可能的签到按钮选择器（更全面的覆盖）
    const selectors = [
        // 直接的签到按钮（按优先级排序）
        '.signin-btn',         // 掘金实际的签到按钮class（签到页面的"立即签到"）
        '.signin',             // 签到页面的按钮class
        '.check-in-btn',
        '.sign-in-btn',
        '[class*="signin"]',   // 匹配 signin-btn
        '[class*="check-in"]',
        '[class*="checkin"]',
        '[class*="sign-in"]',

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

                // 检查是否包含签到相关文字（优先匹配"立即签到"和"去签到"）
                // ⚠️ 不包含"日历"、"抽签"等关键词，避免误匹配日历元素
                if (text.includes('立即签到') || text.includes('去签到') ||
                    text.includes('签到') || text.includes('打卡') ||
                    text.includes('Check in') || text.includes('Sign in')) {

                    console.log('找到可能的签到按钮:', {
                        text: text,
                        className: className,
                        tag: element.tagName,
                        id: element.id,
                        href: element.href,
                        onclick: element.onclick ? '存在' : '不存在'
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

    // 记录所有包含"签到"或"打卡"的元素（包括"立即签到"和"去签到"）
    const allCheckInElements = [];
    for (const element of allClickable) {
        const text = (element.textContent || '').trim();
        // 优先匹配"立即签到"，其次是"去签到"，最后是其他签到相关文本
        if ((text.includes('立即签到') || text.includes('去签到') ||
             text.includes('签到') || text.includes('打卡')) && text.length < 50) {
            let priority = 3; // 默认优先级
            if (text.includes('立即签到')) {
                priority = 1;  // 最高优先级
            } else if (text.includes('去签到')) {
                priority = 2;  // 中等优先级
            }

            allCheckInElements.push({
                text: text,
                tag: element.tagName,
                className: element.className,
                priority: priority
            });
        }
    }

    // 按优先级排序（"立即签到" > "去签到" > 其他）
    allCheckInElements.sort((a, b) => a.priority - b.priority);

    console.log('找到的所有签到相关元素:', allCheckInElements);

    // 返回第一个匹配的元素
    if (allCheckInElements.length > 0) {
        console.log('选择第一个签到按钮:', allCheckInElements[0]);
        // 通过文本重新找到对应的元素
        for (const element of allClickable) {
            const text = (element.textContent || '').trim();
            if (text === allCheckInElements[0].text) {
                return element;
            }
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

// 判断是否已经签到（更严格的判断条件）
function isAlreadyCheckedIn(buttonText, buttonClasses, buttonDisabled) {
    // 预先转换为小写，避免重复调用 toLowerCase()
    const text = buttonText.trim().toLowerCase();
    const classes = buttonClasses.toLowerCase();

    console.log('检查签到状态:', { text, classes, disabled: buttonDisabled });

    // 如果按钮显示"去签到"或"立即签到"，说明还没有签到（明确判断）
    if (text.includes('去签到') || text.includes('去打卡') ||
        text.includes('立即签到') || text.includes('立即打卡')) {
        console.log('✅ 按钮显示"去签到"或"立即签到"，明确判断为未签到');
        return false;
    }

    // 检查按钮文本是否明确显示已签到（严格匹配）
    const alreadyCheckedInPatterns = [
        '已签到',      // 必须包含"已"
        '已打卡',      // 必须包含"已"
        '今日已签到',
        '今天已签到',
        '明日再来',    // 明日再来 = 今日已签到
        '明天再来'
    ];

    for (const pattern of alreadyCheckedInPatterns) {
        const patternLower = pattern.toLowerCase();
        if (text.includes(patternLower)) {
            console.log(`✅ 按钮文本明确显示已签到: ${pattern}`);
            return true;
        }
    }

    // ⚠️ 不再使用 class 判断（太容易误判）
    // 只保留按钮文本判断作为依据

    // ⚠️ 不再单独依赖 disabled 属性判断
    // disabled 属性必须配合明确的文本判断

    // 如果没有明确匹配，返回 false（不确定状态当作未签到处理）
    console.log('⚠️ 无法确定签到状态，当作未签到处理');
    return false;
}

// 检查签到后的状态（优先使用 API 验证）
async function checkAfterCheckInStatus(checkInButton = null) {
    console.log('===== 开始检查签到后状态 =====');

    // 等待 API 请求完成
    await delay(2000);

    // 【验证方式 1】API 验证（最准确，优先使用）
    console.log('🔍 验证方式 1: 通过 API 检查签到状态...');
    const apiStatus = await checkTodayCheckInStatus();
    if (apiStatus) {
        console.log('✅ API 验证成功：今日已签到');
        return {
            success: true,
            message: '签到成功（API 验证）'
        };
    } else {
        console.log('⚠️ API 返回未签到状态（可能签到失败或 API 延迟）');
    }

    // 【验证方式 2】按钮状态判断（辅助验证）
    console.log('🔍 验证方式 2: 检查按钮状态...');

    // 如果没有传入按钮，才重新查找
    if (!checkInButton) {
        checkInButton = findCheckInButton();
    }

    if (checkInButton) {
        const buttonText = (checkInButton.textContent || '').trim();
        const buttonDisabled = checkInButton.disabled;

        console.log('签到后按钮状态:', {
            text: buttonText,
            disabled: buttonDisabled
        });

        // 严格判断：只有明确显示"已签到"才算成功
        if (buttonText.includes('已签到') || buttonText.includes('今日已签到')) {
            console.log('✅ 按钮文本明确显示已签到');
            return {
                success: true,
                message: '签到成功（按钮状态确认）'
            };
        }

        // 如果按钮仍然显示"立即签到"或"去签到"，说明签到失败
        if (buttonText.includes('立即签到') || buttonText.includes('去签到')) {
            console.log('⚠️ 按钮仍然显示签到按钮，可能签到失败');
            return {
                success: false,
                message: '签到操作已执行，但按钮状态未变化，可能签到失败'
            };
        }
    } else {
        console.log('⚠️ 未找到签到按钮');
    }

    // 【验证方式 3】页面提示信息（作为辅助判断）
    console.log('🔍 验证方式 3: 检查页面提示信息...');

    // 只检查明确的成功提示
    const strongSuccessPatterns = [
        '签到成功',
        '今日已签到',
        '连续签到',
        '恭喜签到'
    ];

    const messageSelectors = [
        '.message',
        '.toast',
        '.notification',
        '.alert',
        '.modal',
        '.popup',
        '[class*="message"]',
        '[class*="toast"]',
        '[role="alert"]',
        '[role="status"]'
    ];

    for (const selector of messageSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
            const text = (element.textContent || '').trim();
            if (text.length > 0) {
                for (const pattern of strongSuccessPatterns) {
                    if (text.includes(pattern)) {
                        console.log(`✅ 页面提示明确显示: ${pattern}`);
                        return {
                            success: true,
                            message: `签到成功 - ${pattern}`
                        };
                    }
                }
            }
        }
    }

    // 【验证方式 4】检查是否提示重复签到
    const alreadyCheckedPatterns = ['已经签到', '今日已签到', '重复签到', '已经打卡'];
    const bodyText = document.body.textContent || '';

    for (const pattern of alreadyCheckedPatterns) {
        if (bodyText.includes(pattern)) {
            console.log(`✅ 检测到重复签到提示: ${pattern}`);
            return {
                success: true,
                alreadyCheckedIn: true,
                message: '今天已经签到过了'
            };
        }
    }

    // 所有验证都未通过
    console.log('❌ 所有验证方式都未确认签到成功');
    return {
        success: false,
        message: '签到操作已执行，但无法确认是否成功，请手动检查'
    };
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

// 尝试通过API接口直接签到（使用 cookie 认证）
async function attemptAPICheckIn() {
    try {
        console.log('🔧 尝试使用 API 直接签到...');
        // 掘金签到的 API 端点
        const apiUrl = 'https://api.juejin.cn/growth_api/v1/check_in';

        console.log('发送 POST 请求到:', apiUrl);

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include'  // 自动发送 cookie
        });

        console.log('📡 API 签到响应状态:', response.status);

        if (response.ok) {
            const data = await response.json();
            console.log('📋 API 签到完整响应:', JSON.stringify(data));

            if (data.err_no === 0) {
                console.log('✅ API 签到成功');
                return {
                    success: true,
                    message: 'API 签到成功',
                    data: data.data
                };
            } else if (data.err_no === 10001 || data.err_msg?.includes('重复') || data.err_msg?.includes('已经')) {
                console.log('ℹ️ API 返回重复签到');
                return {
                    success: true,
                    alreadyCheckedIn: true,
                    message: data.err_msg || '今天已经签到过了'
                };
            } else {
                console.log('⚠️ API 返回错误:', data.err_no, data.err_msg);
                return {
                    success: false,
                    message: data.err_msg || `API 签到失败 (err_no: ${data.err_no})`
                };
            }
        } else {
            console.log('⚠️ API 请求失败，状态码:', response.status);
            return {
                success: false,
                message: `API 请求失败 (${response.status})`
            };
        }

    } catch (error) {
        console.log('❌ API 签到异常:', error.message);
        return {
            success: false,
            message: `API 签到异常: ${error.message}`
        };
    }
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

// 等待元素出现（修复内存泄漏：确保 observer 被正确清理）
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
                // 立即断开 observer，防止内存泄漏
                observer.disconnect();
                resolve(element);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // 设置超时，确保清理 observer
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

// 通过 API 检查今日签到状态（最准确的方法）
// 返回值: true = 已签到, false = 未签到或无法确定
async function checkTodayCheckInStatus() {
    try {
        console.log('🔍 调用 API 检查签到状态...');
        const response = await fetch('https://api.juejin.cn/growth_api/v2/get_today_status', {
            method: 'GET',
            credentials: 'include'
        });

        console.log('API 响应状态:', response.status);

        if (response.ok) {
            const data = await response.json();
            console.log('📋 API 完整响应数据:', JSON.stringify(data));

            // err_no === 0 表示请求成功
            if (data.err_no === 0 && data.data) {
                // 检查是否已签到
                const todayStatus = data.data.today_status;
                const hasCheckIn = data.data.has_check_in;

                console.log('📊 签到状态数据:', {
                    today_status: todayStatus,
                    has_check_in: hasCheckIn
                });

                // today_status: 1 = 已签到, 0 = 未签到
                // has_check_in: true = 已签到
                if (todayStatus === 1 || hasCheckIn === true) {
                    console.log('✅ API 返回：今日已签到');
                    return true;
                } else if (todayStatus === 0 || hasCheckIn === false) {
                    console.log('⚠️ API 返回：今日未签到');
                    return false;
                }
            } else if (data.err_no !== 0) {
                console.log('⚠️ API 返回错误，err_no:', data.err_no, 'err_msg:', data.err_msg);
                // API 返回错误时，无法确定签到状态
                // 返回 false，让其他验证方式来判断
            }
        } else {
            console.log('⚠️ API 请求失败，状态码:', response.status);
        }
    } catch (error) {
        console.log('❌ API 检查签到状态异常:', error.message);
    }

    console.log('⚠️ 无法通过 API 确定签到状态，返回未签到');
    return false;
}

// 查找领取矿石按钮
function findClaimButton() {
    console.log('查找领取矿石按钮...');

    const claimPatterns = [
        '领取矿石',
        '立即领取',
        '领取',
        '领取奖励',
        'Claim'
    ];

    // 遍历所有可能的按钮
    const allButtons = document.querySelectorAll('button, .btn, [class*="button"]');

    for (const button of allButtons) {
        const text = (button.textContent || '').trim();
        const className = button.className || '';

        // 检查是否包含领取相关的文字
        for (const pattern of claimPatterns) {
            if (text.includes(pattern) && !text.includes('明日')) {
                // 排除"明日领取"之类的按钮
                console.log(`找到领取按钮: ${text}`);
                return button;
            }
        }

        // 检查class是否包含claim相关
        if (className.toLowerCase().includes('claim')) {
            console.log(`找到领取按钮（通过class）: ${text}`);
            return button;
        }
    }

    console.log('未找到领取矿石按钮');
    return null;
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
