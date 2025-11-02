import config from '../../config/index.js';
import { t } from '../../locales/index.js';
import { ROLE_AI, ROLE_HUMAN } from '../../services/openai.js';
import { generateCompletion } from '../../utils/index.js';
import Context from '../context.js';
import { updateHistory } from '../history/index.js';
import { getPrompt, setPrompt } from '../prompt/index.js';

// ⭐ 新增提醒功能用的模組
import { scheduleJob } from 'node-schedule';

const reminders = {}; // 暫時存在記憶體裡

function detectReminder(text) {
  const timePattern = /(今天|明天|後天)?(早上|中午|下午|晚上)?(\d{1,2})點(\d{0,2})?/;
  const match = text.match(timePattern);
  if (!match) return null;
  const task = text.replace(timePattern, '').replace(/提醒我|幫我|設定|叫我/g, '').trim();
  return { task, time: match[0] };
}

export default async function exec(context) {
  try {
    if (context.event.isText) {
      const text = context.trimmedText;
      const reminder = detectReminder(text);

      if (reminder) {
        // 暫時假設是 1 分鐘後提醒（測試用）
        const remindTime = new Date(Date.now() + 60 * 1000);
        scheduleJob(remindTime, () => {
          context.pushText(`⏰ 提醒：${reminder.task}`);
        });

        context.pushText(`好喔～我會在 ${reminder.time} 提醒你「${reminder.task}」！`);
        return context;
      }

      // 🧠 一般對話（交給 GPT）
      const prompt = getPrompt(context.userId);
      prompt.write(ROLE_HUMAN, `${t('__COMPLETION_DEFAULT_AI_TONE')(config.BOT_TONE)}${text}`).write(ROLE_AI);
      const { text: reply } = await generateCompletion({ prompt });
      prompt.patch(reply);
      setPrompt(context.userId, prompt);
      updateHistory(context.id, (history) => history.write(config.BOT_NAME, reply));
      context.pushText(reply);
    }
  } catch (err) {
    context.pushError(err);
  }
  return context;
}
