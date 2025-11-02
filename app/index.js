// 正確引用：根據你的專案結構
import config from '../config/index.js';
import { t } from '../locales/index.js';
import { ROLE_AI, ROLE_HUMAN } from '../services/openai.js';
import { generateCompletion } from '../utils/index.js';
import Context from './context.js';
import { updateHistory } from './history/index.js';
import { getPrompt, setPrompt } from './prompt/index.js';

// 新增排程模組（測試提醒用）
import { scheduleJob } from 'node-schedule';

/**
 * 偵測使用者訊息中是否包含提醒指令
 * 回傳 { task, timeText } 或 null
 */
function detectReminder(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.replace(/[，,。.!！?？]/g, ' ');
  const timePattern = /(今天|明天|後天)?\s*(早上|中午|下午|晚上)?\s*(\d{1,2})點(?:\s*(\d{1,2})分?)?/i;
  const match = clean.match(timePattern);
  if (!match) return null;
  const timePart = match[0];
  let task = clean.replace(timePart, '').replace(/(提醒我|幫我|設定|叫我|請幫我)/gi, '').trim();
  if (!task) task = '提醒事項';
  return { task, timeText: timePart.trim() };
}

/**
 * 把自然語言時間轉換成 Date
 * 基礎版，只解析 今天/明天/後天 + 時段 + 幾點
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

    let hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    if ((/下午|晚上/.test(timeText)) && hour < 12) hour += 12;

    const target = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayOffset,
      hour,
      minute,
      0,
      0
    );

    // 若時間已過，往後一天
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target;
  } catch {
    return null;
  }
}

/**
 * 主執行函式
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
          context.pushText('抱歉，我無法理解你要的提醒時間，請用「今天/明天 下午5點」的格式說一次。');
          return context;
        }

        // 回覆設定成功
        context.pushText(`✅ 已設定提醒：\n🕓 ${targetDate.toLocaleString()}\n📌 內容：${reminder.task}`);

        // 測試版提醒（Vercel 無法保證長期執行，只做暫時示範）
        scheduleJob(targetDate, () => {
          try {
            context.pushText(`⏰ 提醒：${reminder.task}`);
          } catch (e) {
            console.error('提醒失敗：', e.message);
          }
        });
        return context;
      }

      // ---- 一般對話 ----
      const prompt = getPrompt(context.userId);
      prompt.write(ROLE_HUMAN, `${t('__COMPLETION_DEFAULT_AI_TONE')(config.BOT_TONE)}${text}`).write(ROLE_AI);
      const { text: reply, isFinishReasonStop } = await generateCompletion({ prompt });
      prompt.patch(reply);
      setPrompt(context.userId, prompt);
      updateHistory(context.id, (h) => h.write(config.BOT_NAME, reply));
      const actions = isFinishReasonStop ? ['BOT_FORGET'] : ['BOT_CONTINUE'];
      context.pushText(reply, actions);
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
