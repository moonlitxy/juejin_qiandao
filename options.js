// options.js - 设置页面脚本
// 依赖：shared/config.js, shared/messaging.js, shared/notification.js

// 当前配置（使用 shared/config.js 中的 DEFAULT_CONFIG）
let currentConfig = { ...DEFAULT_CONFIG };

// 手动签到等待状态：background 可能把签到转入重试（pending），
// 最终结果由 checkInCompleted 广播送达，期间按钮保持"签到中..."
let manualCheckInWaiting = false;
let manualCheckInTimeoutId = null;

// 等待广播的超时兜底（毫秒），避免永远卡在"签到中..."
const MANUAL_CHECKIN_TIMEOUT = 90000;

// 抽奖日历：全量记录缓存 + 当前查看的年月（0 表示尚未初始化，用当前月）
let lotteryLogCache = [];
let lotteryView = { year: 0, month: 0 };

// DOM元素
const elements = {
    manualCheckInBtn: null,
    enabledToggle: null,
    checkInTime: null,
    autoLotteryToggle: null,
    successNotification: null,
    failureNotification: null,
    retryCount: null,
    loadTimeout: null,
    calendarMonth: null,
    calendarSummary: null,
    calendarGrid: null,
    historyList: null,
    lotteryCalendarMonth: null,
    lotteryCalendarGrid: null,
    lotteryPrevMonth: null,
    lotteryNextMonth: null,
    lotterySyncToggle: null,
    saveBtn: null,
    resetBtn: null,
    clearHistoryBtn: null,
    clearLotteryBtn: null,
    resetTodayBtn: null
};

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    // 获取DOM元素
    elements.manualCheckInBtn = document.getElementById('manualCheckInBtn');
    elements.enabledToggle = document.getElementById('enabledToggle');
    elements.checkInTime = document.getElementById('checkInTime');
    elements.autoLotteryToggle = document.getElementById('autoLotteryToggle');
    elements.successNotification = document.getElementById('successNotification');
    elements.failureNotification = document.getElementById('failureNotification');
    elements.retryCount = document.getElementById('retryCount');
    elements.loadTimeout = document.getElementById('loadTimeout');
    elements.calendarMonth = document.getElementById('calendarMonth');
    elements.calendarSummary = document.getElementById('calendarSummary');
    elements.calendarGrid = document.getElementById('calendarGrid');
    elements.historyList = document.getElementById('historyList');
    elements.lotteryCalendarMonth = document.getElementById('lotteryCalendarMonth');
    elements.lotteryCalendarGrid = document.getElementById('lotteryCalendarGrid');
    elements.lotteryPrevMonth = document.getElementById('lotteryPrevMonth');
    elements.lotteryNextMonth = document.getElementById('lotteryNextMonth');
    elements.lotterySyncToggle = document.getElementById('lotterySyncToggle');
    elements.saveBtn = document.getElementById('saveBtn');
    elements.resetBtn = document.getElementById('resetBtn');
    elements.clearHistoryBtn = document.getElementById('clearHistoryBtn');
    elements.clearLotteryBtn = document.getElementById('clearLotteryBtn');
    elements.resetTodayBtn = document.getElementById('resetTodayBtn');

    // 绑定事件
    bindEventListeners();

    // 加载配置
    await loadConfig();

    // 加载签到日历（服务端本月明细）
    await loadCalendar();

    // 加载签到历史
    await loadHistory();

    // 加载抽奖记录
    await loadLotteryLog();

    // 监听后台广播：手动签到转重试后由它定案；定时签到完成也顺带刷新日历与历史
    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === 'checkInCompleted') {
            if (manualCheckInWaiting) {
                finishManualCheckIn(request.result);
            } else {
                loadCalendar();
                loadHistory();
            }
        }
    });
});

// 绑定事件监听器
function bindEventListeners() {
    // 立即签到按钮
    elements.manualCheckInBtn.addEventListener('click', async () => {
        await handleManualCheckIn();
    });

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

    // 清空抽奖记录按钮
    elements.clearLotteryBtn.addEventListener('click', async () => {
        if (confirm('确定要清空所有抽奖记录吗？已同步的记录也会一并清除。')) {
            await clearLotteryLog();
        }
    });

    // 抽奖日历翻月
    elements.lotteryPrevMonth.addEventListener('click', () => shiftLotteryMonth(-1));
    elements.lotteryNextMonth.addEventListener('click', () => shiftLotteryMonth(1));

    // 重置今日状态按钮
    elements.resetTodayBtn.addEventListener('click', async () => {
        if (confirm('确定要重置今日签到状态吗？这将允许今日重新签到。')) {
            await resetTodayStatus();
        }
    });
}

// 处理手动签到（与 popup 同一套 pending 协议）
async function handleManualCheckIn() {
    try {
        setManualButtonBusy(true);

        const response = await sendMessage({ action: 'manualCheckIn' });

        // pending：background 已把签到转入重试，最终结果由 checkInCompleted 广播送达
        if (response && response.pending) {
            console.log('签到已转入重试，等待最终结果广播...');
            manualCheckInWaiting = true;
            manualCheckInTimeoutId = setTimeout(() => {
                manualCheckInWaiting = false;
                manualCheckInTimeoutId = null;
                setManualButtonBusy(false);
                showPageNotification('签到结果未确认，请留意桌面通知', 'info');
            }, MANUAL_CHECKIN_TIMEOUT);
            return;
        }

        // 非 pending：结果已确定，直接定案
        finishManualCheckIn(response);

    } catch (error) {
        console.error('手动签到失败:', error);
        resetManualCheckInWaiting();
        setManualButtonBusy(false);
        showPageNotification(error.message || '签到过程出现错误', 'error');
    }
}

// 切换立即签到按钮的忙碌状态
function setManualButtonBusy(busy) {
    elements.manualCheckInBtn.disabled = busy;
    elements.manualCheckInBtn.textContent = busy ? '签到中...' : '立即签到';
}

// 清理手动签到的等待状态与超时定时器
function resetManualCheckInWaiting() {
    manualCheckInWaiting = false;
    if (manualCheckInTimeoutId) {
        clearTimeout(manualCheckInTimeoutId);
        manualCheckInTimeoutId = null;
    }
}

// 手动签到定案：无论成败都恢复按钮，成功后刷新日历与历史
function finishManualCheckIn(result) {
    resetManualCheckInWaiting();
    setManualButtonBusy(false);

    const ok = result && (result.success || result.alreadyCheckedIn);

    if (!ok) {
        showPageNotification((result && result.message) || '签到失败，请重试', 'error');
        return;
    }

    showPageNotification(result.message || '签到成功', 'success');
    loadCalendar();
    loadHistory();
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
        elements.autoLotteryToggle.checked = currentConfig.autoLottery !== false;
        elements.lotterySyncToggle.checked = currentConfig.syncLottery !== false;
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
            autoLottery: elements.autoLotteryToggle.checked,
            syncLottery: elements.lotterySyncToggle.checked,
            successNotification: elements.successNotification.checked,
            failureNotification: elements.failureNotification.checked,
            retryCount: parseInt(elements.retryCount.value),
            loadTimeout: parseInt(elements.loadTimeout.value)
        };

        // 发送到background（只提交表单字段，background 会与已存配置合并）
        await sendMessage({
            action: 'updateConfig',
            config: newConfig
        });

        // 更新当前配置：合并而非替换，保留不在表单里的字段
        // （lastCheckInDate / checkInHistory / consecutiveDays）
        currentConfig = { ...currentConfig, ...newConfig };

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

        // 更新当前配置：只重置设置项，保留签到历史等运行时字段
        currentConfig = { ...currentConfig, ...DEFAULT_CONFIG };

        // 更新UI
        elements.enabledToggle.checked = DEFAULT_CONFIG.enabled;
        elements.checkInTime.value = DEFAULT_CONFIG.checkInTime;
        elements.autoLotteryToggle.checked = DEFAULT_CONFIG.autoLottery;
        elements.lotterySyncToggle.checked = DEFAULT_CONFIG.syncLottery;
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

// 加载签到日历（来自 background 的 getMonthCheckIn，数据以服务端为准）
async function loadCalendar() {
    try {
        const response = await sendMessage({ action: 'getMonthCheckIn' });
        if (!response || !response.ok) {
            renderCalendarError((response && response.message) || '无法获取签到日历');
            return;
        }
        renderCalendar(response);
    } catch (error) {
        console.error('加载签到日历失败:', error);
        renderCalendarError('加载签到日历失败');
    }
}

// 渲染日历：按自然月铺 7 列网格，周一为一周之始
function renderCalendar(data) {
    const [year, month] = data.month.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const dayMap = new Map((data.days || []).map(item => [item.date, item]));

    elements.calendarMonth.textContent = `${year}年${month}月`;
    elements.calendarSummary.textContent = data.checkedIn
        ? `本月已签到 ${data.monthCount} 天`
        : `本月已签到 ${data.monthCount} 天 · 今日未签到`;

    const grid = elements.calendarGrid;
    grid.innerHTML = '';

    // 星期表头（周一为一周之始）
    const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
    for (const label of weekdays) {
        const cell = document.createElement('div');
        cell.className = 'calendar-weekday';
        cell.textContent = label;
        grid.appendChild(cell);
    }

    // 月初空白：getDay() 里周日为 0，转换成"周一为 0"的偏移
    const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
    for (let i = 0; i < firstWeekday; i++) {
        const blank = document.createElement('div');
        blank.className = 'calendar-day empty';
        grid.appendChild(blank);
    }

    // 逐日填充
    for (let day = 1; day <= daysInMonth; day++) {
        const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const info = dayMap.get(key);

        const cell = document.createElement('div');
        cell.className = 'calendar-day';
        cell.textContent = String(day);

        if (info) {
            if (info.checked) {
                cell.classList.add('checked');
                cell.title = info.point > 0 ? `已签到 +${info.point}矿石` : '已签到';
            } else if (info.today) {
                cell.classList.add('today');
                cell.title = '今天尚未签到';
            } else if (info.future) {
                cell.classList.add('future');
                cell.title = '未到';
            } else if (info.miss) {
                cell.classList.add('miss');
                cell.title = '漏签';
            }
        }

        grid.appendChild(cell);
    }
}

// 日历加载失败时的占位提示
function renderCalendarError(message) {
    elements.calendarMonth.textContent = '签到日历';
    elements.calendarSummary.textContent = '';
    elements.calendarGrid.innerHTML = '';
    const tip = document.createElement('div');
    tip.className = 'empty-history';
    tip.textContent = message;
    elements.calendarGrid.appendChild(tip);
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

// 加载抽奖记录（本机流水 + 其他设备同步来的，按天聚合），随后渲染日历
async function loadLotteryLog() {
    try {
        const response = await sendMessage({ action: 'getLotteryLog' });
        lotteryLogCache = (response && response.log) || [];
    } catch (error) {
        console.error('加载抽奖记录失败:', error);
        lotteryLogCache = [];
    }
    renderLotteryCalendar();
}

// 渲染抽奖日历：按 lotteryView 指定的年月铺 7 列网格
// 每个格子显示日期 + 当天结果（奖品名 / 未抽奖 / 失败）
function renderLotteryCalendar() {
    const now = new Date();
    if (!lotteryView.year) {
        lotteryView = { year: now.getFullYear(), month: now.getMonth() + 1 };
    }
    const { year, month } = lotteryView;

    elements.lotteryCalendarMonth.textContent = `${year}年${month}月`;

    // 按"日"索引当月记录；同一天优先中奖
    const dayMap = new Map();
    for (const record of lotteryLogCache) {
        const d = new Date(record.date);
        if (d.getFullYear() !== year || d.getMonth() + 1 !== month) {
            continue;
        }
        const day = d.getDate();
        const existing = dayMap.get(day);
        if (!existing || (existing.status !== 'won' && record.status === 'won')) {
            dayMap.set(day, record);
        }
    }

    const grid = elements.lotteryCalendarGrid;
    grid.innerHTML = '';

    // 星期表头（周一为一周之始）
    const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
    for (const label of weekdays) {
        const cell = document.createElement('div');
        cell.className = 'calendar-weekday';
        cell.textContent = label;
        grid.appendChild(cell);
    }

    // 月初空白
    const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
    for (let i = 0; i < firstWeekday; i++) {
        const blank = document.createElement('div');
        blank.className = 'calendar-day empty';
        grid.appendChild(blank);
    }

    // 逐日填充
    const daysInMonth = new Date(year, month, 0).getDate();
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;

    for (let day = 1; day <= daysInMonth; day++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-day lottery-day';

        if (isCurrentMonth && day === now.getDate()) {
            cell.classList.add('today');
        }

        const numEl = document.createElement('span');
        numEl.className = 'lottery-day-num';
        numEl.textContent = String(day);
        cell.appendChild(numEl);

        const record = dayMap.get(day);
        if (record) {
            cell.classList.add('lottery-' + record.status);

            const prizeEl = document.createElement('span');
            prizeEl.className = 'lottery-day-prize';
            // 奖品名来自服务端，用 textContent 写入避免注入
            prizeEl.textContent = record.status === 'won'
                ? (record.prizeName || '中奖')
                : (record.status === 'skipped' ? '未抽奖' : '失败');
            cell.appendChild(prizeEl);

            cell.title = record.status === 'won'
                ? `抽中 ${record.prizeName || ''}`.trim()
                : (record.message || '');
        } else {
            cell.classList.add('lottery-none');
            cell.title = '无记录';
        }

        grid.appendChild(cell);
    }
}

// 切换抽奖日历的查看月份
function shiftLotteryMonth(delta) {
    const now = new Date();
    let year = lotteryView.year || now.getFullYear();
    let month = lotteryView.month || now.getMonth() + 1;

    month += delta;
    if (month < 1) {
        month = 12;
        year -= 1;
    } else if (month > 12) {
        month = 1;
        year += 1;
    }

    lotteryView = { year, month };
    renderLotteryCalendar();
}

// 清空抽奖记录（本机 + 已同步到其他设备的）
async function clearLotteryLog() {
    try {
        const response = await sendMessage({ action: 'getConfig' });
        const config = response.config || {};
        config.lotteryResult = null;
        config.lotteryHistory = [];

        await sendMessage({ action: 'updateConfig', config });

        // 一并清除 chrome.storage.sync 里同步的按天记录
        try {
            const synced = await chrome.storage.sync.get(null);
            const keys = Object.keys(synced).filter(k => k.startsWith('lottery:'));
            if (keys.length > 0) {
                await chrome.storage.sync.remove(keys);
            }
        } catch (error) {
            console.log('清除同步的抽奖记录失败:', error.message);
        }

        await loadLotteryLog();
        showPageNotification('抽奖记录已清空', 'success');

    } catch (error) {
        console.error('清空抽奖记录失败:', error);
        showPageNotification('清空抽奖记录失败', 'error');
    }
}

// 清空历史记录
async function clearHistory() {
    try {
        const response = await sendMessage({ action: 'getConfig' });
        const config = response.config || {};

        // 清空历史
        config.checkInHistory = [];
        // 同时清除最后签到日期和连续天数，重置签到状态
        config.lastCheckInDate = null;
        config.consecutiveDays = 0;

        console.log('清空历史记录并重置签到状态');

        // 保存配置
        await sendMessage({
            action: 'updateConfig',
            config: config
        });

        // 重新加载历史
        await loadHistory();

        showPageNotification('历史记录已清空，签到状态已重置', 'success');

    } catch (error) {
        console.error('清空历史记录失败:', error);
        showPageNotification('清空历史记录失败', 'error');
    }
}

// 重置今日签到状态（不清空历史记录）
async function resetTodayStatus() {
    try {
        const response = await sendMessage({ action: 'getConfig' });
        const config = response.config || {};

        // 只清除最后签到日期，保留历史记录和连续天数
        const today = new Date().toDateString();
        if (config.lastCheckInDate === today) {
            config.lastCheckInDate = null;
            console.log('已重置今日签到状态，保留历史记录');
        } else {
            console.log('今日未签到，无需重置');
            showPageNotification('今日未签到，无需重置', 'info');
            return;
        }

        // 保存配置
        await sendMessage({
            action: 'updateConfig',
            config: config
        });

        // 重新加载历史
        await loadHistory();

        showPageNotification('今日签到状态已重置', 'success');

    } catch (error) {
        console.error('重置今日状态失败:', error);
        showPageNotification('重置今日状态失败', 'error');
    }
}

// 注意：以下函数已移至共享脚本，避免重复定义
// - sendMessage() -> shared/messaging.js
// - showNotification() -> shared/notification.js (更名为 showPageNotification)

