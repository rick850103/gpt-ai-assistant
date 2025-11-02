import express from 'express';

// 這是我們剛剛重寫過的 bot 主邏輯（app/index.js 的 default export）
import botExec from '../app/index.js';

// 這些是原本 api/index.js 就有在用的模組
import config from '../config/index.js';
import { validateLineSignature } from '../middleware/index.js';
import storage from '../storage/index.js';
import { fetchVersion, getVersion } from '../utils/index.js';

// 我們需要用到 Context 來處理每一個 LINE event
import Context from '../app/context.js';

const app = express();

// 讓 LINE 傳進來的 raw body 能被驗證簽章
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  },
}));

/**
 * 新的 handleEvents：
 * - 以前這個 function 是從 app/index.js 匯出的
 * - 現在我們自己在這裡實作
 * - 對每一個 LINE event：
 *   1. 建 Context
 *   2. 執行 bot 邏輯 (botExec)
 *   3. 回覆訊息給使用者 (context.reply())
 */
async function handleEvents(events) {
  for (const event of events) {
    // 建立一個 context 物件，封裝這次訊息的上下文
    const context = new Context(event);

    // 執行你的機器人主邏輯（包含提醒判斷 / GPT 對話）
    await botExec(context);

    // 把要回給使用者的訊息真的送出去
    // Context 這個類別在你的專案裡通常會有 reply() 來送 LINE 回應
    if (typeof context.reply === 'function') {
      await context.reply();
    }
  }
}

/**
 * GET "/"：健康檢查＋版本資訊
 * 這邊讓你打開 https://你的vercel網址/ 時不會報錯
 */
app.get('/', async (req, res) => {
  try {
    // 如果在 config 裡有設定 APP_URL，就轉過去（專案原本的行為）
    if (config.APP_URL) {
      res.redirect(config.APP_URL);
      return;
    }

    const currentVersion = getVersion();
    const latestVersion = await fetchVersion();

    res.status(200).send({
      status: 'OK',
      currentVersion,
      latestVersion,
    });
  } catch (err) {
    console.error('GET / error:', err?.message || err);
    res.status(500).send({ error: 'Internal Server Error' });
  }
});

/**
 * POST webhook：這是 LINE 會呼叫的端點
 * config.APP_WEBHOOK_PATH 通常是 '/webhook'
 */
app.post(
  config.APP_WEBHOOK_PATH,
  validateLineSignature, // 驗證這次請求確實是從 LINE 來的
  async (req, res) => {
    try {
      // 初始化 storage（原專案流程）
      await storage.initialize();

      // 把這次收到的所有 events 丟去處理
      await handleEvents(req.body.events);

      // 回覆 LINE "我處理好了"
      res.sendStatus(200);
    } catch (err) {
      console.error('POST webhook error:', err?.message || err);
      res.sendStatus(500);
    }
  }
);

// 如果你在本地跑，有 APP_PORT 的話就會啟動 server；
// 在 Vercel 上不會靠這個，沒差，但保留不影響。
if (config.APP_PORT) {
  app.listen(config.APP_PORT);
}

export default app;
