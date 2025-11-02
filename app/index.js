// ✅ 根據你的專案結構（app 與 config/locales/services/utils 同層）
import config from '../config/index.js';
import { t } from '../locales/index.js';
import { ROLE_AI, ROLE_HUMAN } from '../services/openai.js';
import { generateCompletion } from '../utils/index.js';
import Context from './context.js';
import { updateHistory } from './history/index.js';
import { getPrompt, setPrompt } from './prompt/index.js';

// 用於提醒功能
import { scheduleJob } from 'node-schedule';

/**
 * 偵測使用者訊息是否包含提醒語句
 */
function detectReminder(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.replace(/[，,。.!！?？]/g, ' ');
  const pattern = /(今天|明天|後天)?\s*(早上|中午|下午|晚上)?\s*(\d{1,2})點(\d{0,2})?/;
  const match = clean.match(pattern);
  if (!match) return null;
  const timePart = match[0];
  const task = clean.replace(timePart, '').replace(/(提醒我|幫我|設定|叫我|請幫我)/g, '').trim() || '提醒事項';
  return { timeText: timePart.trim(), task };
}

/**
 * 解析自然語言時間
 */
function parseToDate(timeText) {
  try {
    const now = new Date();
    let dayOffset = 0;
    if (/明天/.test(timeText)) dayOffset = 1;
    if (/後天/.test(timeText)) dayOffset = 2;

    let hourAdjust = 0;
    if (/早上/.test(timeText)) hourAdjust = 0;
    if (/中午/.test(timeText)) hourAdjust = 12;
    if (/下午/.test(timeText)) hourAdjust = 12;
    if (/晚上/.test(timeText)) hourAdjust = 18;

    const match = timeText.match(/(\d{1,2})點(?:\s*(\d{1,2})分?)?/);
    if (!match) return null;

    let hour = parseInt(match[1]);
    const minute = match[2] ? parseInt(match[2]) : 0;
    if ((/下午|晚上/.test(timeText)) && hour < 12) hour += 12;

    const target = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayOffset,
      hour,
      minute,
      0
    );

    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target;
  } catch {
    return null;
  }
}

/**
 * 主程式
 */
const exec = async (context) => {
  try {
    if (!context) return context;
    if (context.event && context.event.isText) {
      const text = context.trimmedText || '';
      const reminder = detectReminder(text);

      if (reminder) {
        const targetDate = parseToDate(reminder.timeText);
        if (!targetDate) {
          context.pushText('我不太確定時間，可以再說一次嗎？例如「明天下午5點提醒我買菜」');
          return context;
        }

        context.pushText(
          `✅ 已設定提醒！\n🕓 時間：${targetDate.toLocaleString()}\n📌 內容：${reminder.task}`
        );

        // 設定測試排程（serverless 僅短期有效）
        scheduleJob(targetDate, () => {
          try {
            context.pushText(`⏰ 提醒：${reminder.task}`);
          } catch (e) {
            console.error('推送失敗：', e.message);
          }
        });
        return context;
      }

      // 一般對話
      const prompt = getPrompt(context.userId);
      prompt.write(ROLE_HUMAN, `${t('__COMPLETION_DEFAULT_AI_TONE')(config.BOT_TONE)}${text}`).write(ROLE_AI);
      const { text: reply } = await generateCompletion({ prompt });
      prompt.patch(reply);
      setPrompt(context.userId, prompt);
      updateHistory(context.id, (h) => h.write(config.BOT_NAME, reply));
      context.pushText(reply);
    }
    return context;
  } catch (err) {
    console.error('執行錯誤：', err.message);
    try {
      context.pushError(err);
    } catch {}
    return context;
  }
};

export default exec;
