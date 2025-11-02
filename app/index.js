// 目前你的專案目錄結構是：
// - app/
// - config/
// - locales/
// - services/
// - utils/
// 所以我們用 ../ 來抓上層的模組
import config from '../config/index.js';
import { t } from '../locales/index.js';
import { ROLE_AI, ROLE_HUMAN } from '../services/openai.js';
import { generateCompletion } from '../utils/index.js';

import Context from './context.js';
import { updateHistory } from './history/index.js';
import { getPrompt, setPrompt } from './prompt/index.js';

/**
 * 嘗試從使用者訊息中抓出「提醒」需求
 * 回傳格式：
 *   { task: '買菜', timeText: '明天下午5點', targetDate: Date物件 }
 * 或回傳 null 表示不是提醒
 */
function detectReminderInfo(userText) {
  if (!userText || typeof userText !== 'string') return null;

  // 1. 清理常見標點，避免干擾
  const clean = userText.replace(/[，,。.!！?？]/g, ' ').trim();

  // 2. 嘗試抓出「時間片段」
  //    例如：今天/明天/後天 + (早上/中午/下午/晚上) + 幾點(幾分)
  const timePattern = /(今天|明天|後天)?\s*(早上|早上|上午|中午|下午|晚上)?\s*(\d{1,2})點(\d{1,2})?分?/i;
  const timeMatch = clean.match(timePattern);

  if (!timeMatch) {
    // 沒有時間字樣，就當作不是提醒
    return null;
  }

  const timeText = timeMatch[0].trim(); // e.g. "明天下午5點"
  // 3. 任務內容：把時間那段拿掉，再把「提醒我/幫我/設定/叫我」這些字拿掉
  const taskText = clean
    .replace(timeText, '')
    .replace(/(提醒我|提醒一下|幫我|幫我設定|設定|幫我記得|叫我|記得)/g, '')
    .trim();

  const task = taskText || '提醒事項';

  // 4. 把時間文字轉成 Date 物件（台灣本地邏輯的簡化版本）
  const targetDate = parseToDate(timeText);

  return {
    task,
    timeText,
    targetDate,
  };
}

/**
 * 把像「明天下午5點」這種自然語言，轉成一個 Date 物件
 * 注意：這是超簡化版，只支援：
 *   - 今天/明天/後天（沒講就預設今天）
 *   - 早上/上午/中午/下午/晚上
 *   - 幾點 幾分(可選)
 * 如果算出來的時間已經過了現在，就自動往後一天，避免解析成過去時間
 */
function parseToDate(timeText) {
  try {
    const now = new Date();
    let dayOffset = 0;

    if (/明天/.test(timeText)) dayOffset = 1;
    if (/後天/.test(timeText)) dayOffset = 2;
    // 如果寫「今天」或沒寫天數 → dayOffset = 0

    // 依照中文時段大概推小時
    // 注意：「下午3點」我們會把3點轉成15:00
    const hasMorning = /(早上|上午)/.test(timeText);
    const hasNoon = /(中午)/.test(timeText);
    const hasAfternoon = /(下午)/.test(timeText);
    const hasNight = /(晚上)/.test(timeText);

    // 抓小時、分鐘
    const hm = timeText.match(/(\d{1,2})點(\d{1,2})?/);
    if (!hm) return null;

    let hour = parseInt(hm[1], 10); // 幾點
    const minute = hm[2] ? parseInt(hm[2], 10) : 0; // 幾分（可能沒講）

    // 根據時段修正小時
    // 例如：「下午5點」-> 17點
    if ((hasAfternoon || hasNight) && hour < 12) {
      hour += 12;
    }
    // 「中午12點」基本上就是12
    // 「早上9點」保持9

    const scheduled = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayOffset,
      hour,
      minute,
      0,
      0
    );

    // 如果時間已經過了現在（例如現在是晚上10:00，但你說「今天下午3點」）
    // 我們推到下一天同一時間，避免變成「過去的時間」
    if (scheduled.getTime() <= now.getTime()) {
      scheduled.setDate(scheduled.getDate() + 1);
    }

    return scheduled;
  } catch (err) {
    // 如果哪裡算壞了，就回傳 null，稍後我們會優雅地跟使用者說聽不懂
    return null;
  }
}

/**
 * 主邏輯：
 * - 如果使用者在講「提醒我...」，我們就用我們自己的邏輯處理
 * - 其他一般聊天，才丟給 OpenAI
 */
const exec = async (context) => {
  try {
    // 安全檢查
    if (!context) return context;

    // 我們只處理文字訊息，圖/貼圖/etc 先不管
    if (context.event && context.event.isText) {
      const userText = context.trimmedText || '';

      // 1. 先判斷是不是「提醒」型的句子
      const reminderInfo = detectReminderInfo(userText);

      if (reminderInfo) {
        // 如果抓到了提醒資訊
        // 但時間無法解析，就請他講清楚一點
        if (!reminderInfo.targetDate) {
          context.pushText(
            '我聽到你要提醒，但時間我聽不懂 🤔\n可以像這樣說嗎：\n「明天下午5點提醒我買菜」或「今天晚上9點叫我拿藥」'
          );
          return context;
        }

        // 如果解析成功，我們目前先「確認紀錄」，還不真的排計時
        // （之後我們會用資料庫＋排程來真的推播）
        const humanTime = reminderInfo.targetDate.toLocaleString('zh-TW', {
          hour12: false,
        });

        context.pushText(
          [
            '✅ 提醒已記下！',
            `🕓 時間：${humanTime}`,
            `📌 內容：${reminderInfo.task}`,
            '',
            '（下一步我們會讓我到時間主動傳訊息提醒你～）',
          ].join('\n')
        );

        // 這裡以後可以把 reminderInfo 存進資料庫（KV / SQLite / etc.）
        // 現在我們先不存，因為你還沒加 DB。

        return context;
      }

      // 2. 否則就是一般聊天 → 丟給 OpenAI 產生回覆
      const prompt = getPrompt(context.userId);

      // 把使用者的話 + 一個「語氣模板」塞進去
      // t('__COMPLETION_DEFAULT_AI_TONE')(config.BOT_TONE) 是這個專案原本就有的口吻設定
      prompt
        .write(
          ROLE_HUMAN,
          `${t('__COMPLETION_DEFAULT_AI_TONE')(config.BOT_TONE)}${userText}`
        )
        .write(ROLE_AI);

      // 呼叫 OpenAI 產生回覆
      const { text: replyText } = await generateCompletion({ prompt });

      // 把模型產生的回覆寫回去
      prompt.patch(replyText);
      setPrompt(context.userId, prompt);
      updateHistory(context.id, (history) =>
        history.write(config.BOT_NAME, replyText)
      );

      // 傳回 LINE
      context.pushText(replyText);

      return context;
    }

    // 非文字訊息就先忽略
    return context;
  } catch (err) {
    console.error('執行錯誤：', err.message);

    try {
      context.pushError(err);
    } catch {
      // 如果 context.pushError 自己爆了就算了，至少 log
    }

    return context;
  }
};

export default exec;
