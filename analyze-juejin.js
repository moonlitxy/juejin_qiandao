/**
 * 掘金签到页面分析脚本
 * 使用 Playwright 自动化分析掘金签到流程
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 创建输出目录
const outputDir = path.join(__dirname, 'analysis-output');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// 日志辅助函数
function log(message, data = null) {
    const timestamp = new Date().toLocaleTimeString('zh-CN');
    console.log(`[${timestamp}] ${message}`);
    if (data) {
        console.log(JSON.stringify(data, null, 2));
    }
}

// 保存截图
async function saveScreenshot(page, name) {
    const screenshotPath = path.join(outputDir, `${name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log(`📸 截图已保存: ${screenshotPath}`);
    return screenshotPath;
}

// 提取元素信息
function extractElementInfo(element, description) {
    const info = {
        description,
        tagName: '',
        innerHTML: '',
        outerHTML: '',
        textContent: '',
        attributes: {},
        classes: []
    };

    try {
        info.tagName = element.evaluate(el => el.tagName);
        info.innerHTML = element.evaluate(el => el.innerHTML);
        info.outerHTML = element.evaluate(el => el.outerHTML);
        info.textContent = element.evaluate(el => el.textContent);
        info.attributes = element.evaluate(el => {
            const attrs = {};
            for (const attr of el.attributes) {
                attrs[attr.name] = attr.value;
            }
            return attrs;
        });
        info.classes = element.evaluate(el => {
            return Array.from(el.classList);
        });
    } catch (error) {
        log(`⚠️  提取元素信息失败: ${error.message}`);
    }

    return info;
}

// 主分析函数
async function analyzeJuejinCheckIn() {
    log('🚀 开始分析掘金签到页面...');

    // 启动浏览器
    const browser = await chromium.launch({
        headless: false,
        slowMo: 1000 // 慢速操作以便观察
    });

    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // 监听响应
    const apiResponses = [];
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('juejin.cn')) {
            const status = response.status();
            const contentType = response.headers()['content-type'] || '';

            if (contentType.includes('application/json')) {
                try {
                    const json = await response.json();
                    apiResponses.push({
                        url,
                        status,
                        method: response.request().method(),
                        data: json
                    });
                    log(`📡 API 响应: ${response.request().method()} ${url}`);
                } catch (e) {
                    // 忽略非 JSON 响应
                }
            }
        }
    });

    try {
        // ========== 步骤 1: 打开掘金首页 ==========
        log('\n📍 步骤 1: 打开掘金首页');
        await page.goto('https://juejin.cn', { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        await saveScreenshot(page, '01-homepage');

        // 检查登录状态
        const isLoggedIn = await page.evaluate(() => {
            const loginButton = document.querySelector('a[href*="login"]');
            return !loginButton;
        });

        if (!isLoggedIn) {
            log('⚠️  未登录状态，请先登录后再运行此脚本');
            log('⏳ 等待 30 秒以便手动登录...');
            await page.waitForTimeout(30000);

            // 重新检查登录状态
            const stillNotLoggedIn = await page.evaluate(() => {
                const loginButton = document.querySelector('a[href*="login"]');
                return !loginButton;
            });

            if (stillNotLoggedIn) {
                throw new Error('用户未登录，无法继续分析');
            }
        }

        log('✅ 已登录状态');

        // ========== 步骤 2: 查找签到按钮 ==========
        log('\n📍 步骤 2: 查找签到按钮');

        const checkInButtonSelectors = [
            'button:has-text("去签到")',
            'a:has-text("去签到")',
            'button:has-text("已签到")',
            'a:has-text("已签到")',
            '[class*="check"]',
            '[class*="sign"]',
            '.header-sign-in',
            '.sign-in-btn'
        ];

        let checkInButton = null;
        let buttonInfo = null;

        for (const selector of checkInButtonSelectors) {
            try {
                const elements = await page.$$(selector);
                for (const element of elements) {
                    const isVisible = await element.isVisible();
                    if (isVisible) {
                        checkInButton = element;
                        buttonInfo = extractElementInfo(element, `签到按钮 (${selector})`);
                        log(`✅ 找到签到按钮: ${selector}`);
                        break;
                    }
                }
                if (checkInButton) break;
            } catch (error) {
                // 继续尝试下一个选择器
            }
        }

        if (!checkInButton) {
            // 如果找不到，尝试查找所有按钮
            log('⚠️  未找到标准签到按钮，尝试查找所有可能按钮...');
            const allButtons = await page.$$('button, a');
            log(`🔍 页面共有 ${allButtons.length} 个按钮/链接`);

            for (const btn of allButtons) {
                const text = await btn.evaluate(el => el.textContent?.trim());
                if (text && (text.includes('签到') || text.includes('打卡'))) {
                    checkInButton = btn;
                    buttonInfo = extractElementInfo(btn, `签到按钮 (文本: ${text})`);
                    log(`✅ 找到签到按钮: ${text}`);
                    break;
                }
            }
        }

        if (buttonInfo) {
            log('\n📋 签到按钮详细信息:');
            log(JSON.stringify(buttonInfo, null, 2));

            // 保存按钮信息到文件
            fs.writeFileSync(
                path.join(outputDir, 'check-in-button-info.json'),
                JSON.stringify(buttonInfo, null, 2)
            );
        }

        await saveScreenshot(page, '02-found-checkin-button');

        // ========== 步骤 3: 点击签到按钮 ==========
        if (checkInButton) {
            log('\n📍 步骤 3: 点击签到按钮');

            const buttonText = await checkInButton.evaluate(el => el.textContent);
            log(`🖱️  点击按钮: "${buttonText}"`);

            await checkInButton.click();
            await page.waitForTimeout(3000);
            await saveScreenshot(page, '03-after-click-checkin');

            // 检查是否跳转到签到页面
            const currentUrl = page.url();
            log(`🔗 当前页面 URL: ${currentUrl}`);

            // ========== 步骤 4: 在签到页面查找签到按钮 ==========
            if (currentUrl.includes('task') || currentUrl.includes('checkin') || currentUrl.includes('签到')) {
                log('\n📍 步骤 4: 已进入签到页面');

                await page.waitForTimeout(2000);
                await saveScreenshot(page, '04-checkin-page');

                // 查找"立即签到"按钮
                const signInButtonSelectors = [
                    'button:has-text("立即签到")',
                    'button:has-text("去签到")',
                    'button:has-text("打卡")',
                    '.sign-in-btn',
                    '.check-in-btn',
                    '[class*="sign-in"]'
                ];

                let signInButton = null;
                let signInButtonInfo = null;

                for (const selector of signInButtonSelectors) {
                    try {
                        const elements = await page.$$(selector);
                        for (const element of elements) {
                            const isVisible = await element.isVisible();
                            if (isVisible) {
                                signInButton = element;
                                signInButtonInfo = extractElementInfo(element, `签到页面按钮 (${selector})`);
                                log(`✅ 找到签到页面按钮: ${selector}`);
                                break;
                            }
                        }
                        if (signInButton) break;
                    } catch (error) {
                        // 继续尝试
                    }
                }

                if (!signInButton) {
                    log('⚠️  未找到签到页面按钮，查找所有按钮...');
                    const allButtons = await page.$$('button');
                    for (const btn of allButtons) {
                        const text = await btn.evaluate(el => el.textContent?.trim());
                        if (text && (text.includes('签到') || text.includes('打卡'))) {
                            signInButton = btn;
                            signInButtonInfo = extractElementInfo(btn, `签到页面按钮 (文本: ${text})`);
                            log(`✅ 找到签到页面按钮: ${text}`);
                            break;
                        }
                    }
                }

                if (signInButtonInfo) {
                    log('\n📋 签到页面按钮详细信息:');
                    log(JSON.stringify(signInButtonInfo, null, 2));

                    fs.writeFileSync(
                        path.join(outputDir, 'signin-page-button-info.json'),
                        JSON.stringify(signInButtonInfo, null, 2)
                    );
                }

                // ========== 步骤 5: 点击签到按钮 ==========
                if (signInButton) {
                    log('\n📍 步骤 5: 点击签到按钮');

                    const signInButtonText = await signInButton.evaluate(el => el.textContent);
                    log(`🖱️  点击按钮: "${signInButtonText}"`);

                    // 点击前保存页面状态
                    const beforeClickText = await page.evaluate(() => document.body.innerText);

                    await signInButton.click();
                    await page.waitForTimeout(3000);
                    await saveScreenshot(page, '05-after-click-signin');

                    // 检查页面变化
                    const afterClickText = await page.evaluate(() => document.body.innerText);

                    // 查找成功提示
                    const successIndicators = [
                        '签到成功',
                        '今日已签到',
                        '已经打卡',
                        '已完成',
                        '连续签到'
                    ];

                    log('\n🔍 检查签到成功标志:');
                    for (const indicator of successIndicators) {
                        if (afterClickText.includes(indicator)) {
                            log(`✅ 找到成功标志: "${indicator}"`);
                        }
                    }

                    // 检查页面文字变化
                    const diff = findTextDiff(beforeClickText, afterClickText);
                    if (diff.length > 0) {
                        log('\n📝 页面文字变化:');
                        diff.forEach(change => log(`  - ${change}`));
                    }
                }

                // 等待并截取最终状态
                await page.waitForTimeout(3000);
                await saveScreenshot(page, '06-final-state');

                // 获取页面所有可能的签到相关元素
                log('\n📍 步骤 6: 提取所有签到相关元素');
                const allRelevantElements = await page.evaluate(() => {
                    const elements = [];

                    // 查找所有包含"签到"、"打卡"文字的元素
                    const allElements = document.querySelectorAll('*');
                    allElements.forEach(el => {
                        const text = el.textContent?.trim();
                        if (text && (text.includes('签到') || text.includes('打卡')) && text.length < 50) {
                            elements.push({
                                tagName: el.tagName,
                                innerHTML: el.innerHTML,
                                outerHTML: el.outerHTML,
                                textContent: text,
                                className: el.className,
                                id: el.id,
                                attributes: Array.from(el.attributes).map(attr => ({
                                    name: attr.name,
                                    value: attr.value
                                }))
                            });
                        }
                    });

                    return elements;
                });

                if (allRelevantElements.length > 0) {
                    log(`🔍 找到 ${allRelevantElements.length} 个签到相关元素`);
                    fs.writeFileSync(
                        path.join(outputDir, 'all-relevant-elements.json'),
                        JSON.stringify(allRelevantElements, null, 2)
                    );
                }
            }
        }

        // ========== 步骤 7: 保存 API 响应 ==========
        log('\n📍 步骤 7: 保存 API 响应记录');
        if (apiResponses.length > 0) {
            log(`📡 共捕获 ${apiResponses.length} 个 API 响应`);
            fs.writeFileSync(
                path.join(outputDir, 'api-responses.json'),
                JSON.stringify(apiResponses, null, 2)
            );

            // 筛选出签到相关的 API
            const checkInAPIs = apiResponses.filter(resp =>
                resp.url.includes('checkin') ||
                resp.url.includes('sign') ||
                resp.url.includes('task')
            );

            if (checkInAPIs.length > 0) {
                log(`📡 签到相关 API: ${checkInAPIs.length} 个`);
                fs.writeFileSync(
                    path.join(outputDir, 'signin-api-responses.json'),
                    JSON.stringify(checkInAPIs, null, 2)
                );
            }
        }

        log('\n✅ 分析完成！');
        log(`📁 所有结果已保存到: ${outputDir}`);

    } catch (error) {
        log(`❌ 分析过程中出错: ${error.message}`);
        console.error(error);
    } finally {
        // 保持浏览器打开一段时间以便查看
        log('\n⏳ 保持浏览器打开 10 秒以便查看...');
        await page.waitForTimeout(10000);
        await browser.close();
    }
}

// 文本对比辅助函数
function findTextDiff(before, after) {
    const changes = [];
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');

    // 简单对比，找出新增的包含"签到"、"打卡"的行
    for (const line of afterLines) {
        const trimmed = line.trim();
        if ((trimmed.includes('签到') || trimmed.includes('打卡')) &&
            !before.includes(trimmed) &&
            trimmed.length > 0 && trimmed.length < 100) {
            changes.push(trimmed);
        }
    }

    return changes;
}

// 运行分析
analyzeJuejinCheckIn().catch(console.error);
