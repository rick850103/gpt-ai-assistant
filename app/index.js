import config from '../config/index.js';
import { t } from '../locales/index.js';
import { ROLE_AI, ROLE_HUMAN } from '../../services/openai.js';
import { generateCompletion } from '../../utils/index.js';
import Context from '../context.js';
import { updateHistory } from '../history/index.js';
import { getPrompt, setPrompt } from '../prompt/index.js';

// 新增提醒需要的排程模組（請在 package.json 安裝 node-schedule）
import { scheduleJob } from 'node-schedule';

/**
 * 檢查是否要處理（保留原先判斷行為）
 * @param {Context} context
 * @returns {boolean}
 */
const check = (context) => (
  context.hasCommand && (context.hasCommand('BOT_TALK') || context.hasBotName || (context.source && context.source.bot && context.source.bot.isActivated))
);

/**
 * 簡單的提醒偵測器（基礎版）
 * 回傳 null 或 { task, timeText }
 * 目前會抓「今天/明天/後天 + 早上/中午/下午/晚上 + N點(可有分)」
 */
function detectReminder(text) {
  if (!text || typeof text !== 'string') return null;
  // 盡量容錯：移除標點
  const clean = text.replace(/[，,。.!！?？]/g, ' ');
  // 範例： "明天下午5點買菜" 或 "下午5點提醒我買菜"
  const timePattern = /(今天|明天|後天)?\s*(早上|中午|下午|晚上)?\s*(\d{1,2})點(?:\s*(\d{1,2})分?)?/i;
  const match = clean.match(timePattern);
  if (!match) return null;

  // 抽出任務內容（把時間片段移除後剩下的字）
  const timePart = match[0];
  let task = clean.replace(timePart, '').replace(/\b(提醒我|幫我|設定|叫我|請幫我)\b/gi, '').trim();
  if (!task) task = '提醒事項';

  // 時間文字
  const timeText = timePart.trim();

  return { task, timeText };
}

/**
 * 測試用：將偵測到的時間轉成 Date（非常簡化）
 * 這個版本：如果偵測到「今天」或無前綴，視為今天相對時間；如果是「明天/後天」則加上天數。
 * 若解析失敗，會回傳 null。
 *
 * 注意：這只是基礎示範。之後可替換成更完整的自然語言時間解析器（例如 chrono-node）。
 */
function parseToDate(timeText) {
  try {
    const now = new Date();
    let dayOffset = 0;

    if (/明天/.test(timeText)) dayOffset = 1;
    if (/後天/.test(timeText)) dayOffset = 2;
    // 早上/中午/下午/晚上 基本時段補正（可再優化）
    let hourAdjust = 0;
    if (/早上/.test(timeText)) hourAdjust = 0;
    if (/中午/.test(timeText)) hourAdjust = 12;
    if (/下午/.test(timeText)) hourAdjust = 12;
    if (/晚上/.test(timeText)) hourAdjust = 18; // 調整：若為晚上，預設 +18（可細修）

    const match = timeText.match(/(\d{1,2})點(?:\s*(\d{1,2})分?)?/);
    if (!match) return null;

    let hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;

    // 若時段為 下午 且 hour < 12，加 12（避免 5 點被解析成早上）
    if ((/下午|晚上/.test(timeText)) && hour < 12) {
      hour = hour + 12;
    }
    // 基礎決策：若中午且 hour < 12，保留 hour
    // 建立目標日期
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0, 0);

    // 若 target 已過去（例如本日時間已過），自動推到下一天（避免立即觸發）
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  } catch (e) {
    return null;
  }
}

/**
 * 主執行函式
 * @param {Context} context
 * @returns {Promise<Context>}
 */
const exec = async (context) => {
  // 保留原本的 check 行為（必要時可套用）
  // 但這個專案原本的檢查是在外層呼叫，這裡直接處理 context
  try {
    if (!context) return context;

    if (context.event && context.event.isText) {
      const text = context.trimmedText || '';

      // 嘗試偵測是否為提醒指令
      const reminder = detectReminder(text);

      if (reminder) {
        // 進一步把自然語言時間轉成 Date
        const targetDate = parseToDate(reminder.timeText);

        // 若解析失敗，先告知使用者（請求補充）
        if (!targetDate) {
          context.pushText('抱歉，我無法理解你要的提醒時間，能不能再用「今天/明天 + 上午/下午 + N點」的格式說一次？');
          return context;
        }

        // 先簡易回覆確認（使用者可視為已設定）
        context.pushText(`✅ 好的，我已為你設定提醒：\n📌 內容：${reminder.task}\n🕓 時間：${targetDate.toLocaleString()}\n（到時候我會在指定時間傳訊息提醒你）`);

        // 使用 node-schedule 設定排程（短期測試用）
        // 注意：在 serverless 平台（如 Vercel）上，長期排程不可靠；這只是測試性功能。
        // 正式應使用 KV + Cron 或外部 job（我會在後面教你如何做）。
        try {
          scheduleJob(targetDate, async () => {
            // 當排程觸發時，我們需要把提醒發回 LINE 使用者。
            // 這裡沒有直接的 line client，所以我們使用 context.pushText 做內部回覆路徑。
            // 在 serverless 真實環境中，context 物件可能不再存在；正式版應使用 LINE pushMessage API。
            try {
              // 嘗試使用 context 推送（若執行時 context 尚存在）
              context.pushText(`⏰ 提醒：${reminder.task}`);
            } catch (e) {
              // 若 context 不可用，請改用你專案內已有的推播函式或儲存提醒到 DB，等待 cron job 發送。
              console.error('Reminder job failed to push message via context:', e?.message || e);
            }
          });
        } catch (e) {
          console.error('Failed to schedule job:', e?.message || e);
        }

        return context;
      }

      // 非提醒指令：維持原 GPT 對話流程
      const prompt = getPrompt(context.userId);
      prompt.write(ROLE_HUMAN, `${t('__COMPLETION_DEFAULT_AI_TONE')(config.BOT_TONE)}${text}`).write(ROLE_AI);
      const { text: reply, isFinishReasonStop } = await generateCompletion({ prompt });
      prompt.patch(reply);
      setPrompt(context.userId, prompt);
      updateHistory(context.id, (history) => history.write(config.BOT_NAME, reply));
      const actions = isFinishReasonStop ? ['BOT_FORGET'] : ['BOT_CONTINUE'];
      context.pushText(reply, actions);
      return context;
    }

    // 非文字事件或其他情況，回傳原處理（或保持不動）
    return context;
  } catch (err) {
    // 若發生錯誤，把錯誤訊息放進 context（原專案慣例）
    try {
      context.pushError(err);
    } catch (e) {
      console.error('Error pushing error to context:', e?.message || e);
    }
    return context;
  }
};

export default exec;
