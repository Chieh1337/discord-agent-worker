/**
 * summarize-youtube.js
 *
 * GitHub Action 觸發。從 env 拿 video_id + Discord interaction context。
 *
 * 策略：跳過字幕（YouTube 對 datacenter IP 全面 bot challenge），
 *      直接把 YouTube URL 丟給 gemini-2.5-pro（讀影片模式）。
 *      Gemini 是 Google 自己 fetch 影片，不會被擋。
 *      Action 有 6 小時時限，Gemini 處理 60-180 秒綽綽有餘。
 *
 * 影片長度上限：gemini-2.5-pro 可吃約 2 小時。
 */

const {
  VIDEO_ID,
  APPLICATION_ID,
  INTERACTION_TOKEN,
  GEMINI_API_KEY,
  DISCORD_BOT_TOKEN,
} = process.env;

// 預設 flash（免費額度可用）；要用 pro 時由 workflow 傳 GEMINI_MODEL 覆蓋
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ═══════════════════════════════════════
// Main
// ═══════════════════════════════════════
async function main() {
  console.log(`[start] video=${VIDEO_ID} model=${MODEL}`);
  const t0 = Date.now();

  try {
    if (!VIDEO_ID || !APPLICATION_ID || !INTERACTION_TOKEN) {
      throw new Error("缺必要 env (VIDEO_ID / APPLICATION_ID / INTERACTION_TOKEN)");
    }
    if (!GEMINI_API_KEY || !DISCORD_BOT_TOKEN) {
      throw new Error("缺 GEMINI_API_KEY 或 DISCORD_BOT_TOKEN");
    }

    const videoUrl = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

    // Gemini 直接讀影片
    const summary = await callGeminiVideo(videoUrl);
    console.log(
      `[gemini] summary len=${summary.length} elapsed=${Date.now() - t0}ms`
    );

    // PATCH 回 Discord
    const header = `_🎬 影像模式 · ${MODEL}_\n\n`;
    const chunks = splitMessage(header + summary, 1900);
    await patchOriginal(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await followUp(chunks[i]);
    }
    await followUp(
      "💾 **回覆此訊息 `/wiki-save` 將摘要存入個人知識庫**（Phase 2 功能）"
    );

    console.log(`[done] total=${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`[FAIL] ${err.message}\n${err.stack}`);
    try {
      await patchOriginal(`❌ 處理失敗：${err.message}`);
    } catch (e) {
      console.error(`[patch-error] ${e.message}`);
    }
    process.exit(1);
  }
}

// ═══════════════════════════════════════
// Gemini 直接讀影片
// ═══════════════════════════════════════
async function callGeminiVideo(videoUrl) {
  const prompt = `你是專業的學習筆記整理員。請看完下面這支 YouTube 影片，整理成結構化的繁體中文學習筆記。

輸出格式：

**📺 標題**：[影片實際標題]
**📡 頻道**：[頻道名稱]
**⏱️ 時長**：[時長，例如 47:23]

## 🎯 核心摘要
（3-5 句話，把這支影片在講的事說清楚）

## 💡 重點精華
（10-15 條 bullet points，每條 2-3 句，具體且有資訊量。長片要多抓深度，不是條數多而已）

## 🔑 關鍵概念
（3-7 個影片中提到的重要名詞、框架、理論，附簡短定義）

## 📚 章節結構
（按影片時序拆 4-7 個段落，每段一行標題 + 時間戳 + 1-2 句該段在講什麼）

## ✅ 可行動建議
（2-5 個可立即套用的具體行動）

【嚴格規則】
- 完全基於影片實際內容，不要編造影片沒提到的東西
- 重點要「有資訊密度」，避免「這很重要」「需要注意」這類廢話
- 章節結構的時間戳請依影片實際時長分配

【影片連結】
${videoUrl}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            fileData: {
              mimeType: "video/youtube",
              fileUri: videoUrl,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      // 低解析度取樣：影片 token 量降約 3 倍，摘要品質幾乎無損（聽覺內容不受影響）
      mediaResolution: "MEDIA_RESOLUTION_LOW",
    },
  };

  console.log(`[gemini] calling ${MODEL}...`);
  const tg = Date.now();
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await r.json();
  console.log(`[gemini] status=${r.status} elapsed=${Date.now() - tg}ms`);

  if (!r.ok) {
    console.error(`[gemini] error body=${JSON.stringify(data).slice(0, 500)}`);
    throw new Error(data.error?.message || `Gemini HTTP ${r.status}`);
  }
  const out = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) {
    console.error(`[gemini] empty full=${JSON.stringify(data).slice(0, 500)}`);
    throw new Error("Gemini 回傳空內容");
  }
  return out;
}

// ═══════════════════════════════════════
// Discord
// ═══════════════════════════════════════
async function patchOriginal(content) {
  const r = await fetch(
    `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${INTERACTION_TOKEN}/messages/@original`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      },
      body: JSON.stringify({ content }),
    }
  );
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Discord PATCH ${r.status}: ${body.slice(0, 200)}`);
  }
}

async function followUp(content) {
  const r = await fetch(
    `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${INTERACTION_TOKEN}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      },
      body: JSON.stringify({ content }),
    }
  );
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Discord follow-up ${r.status}: ${body.slice(0, 200)}`);
  }
}

// ═══════════════════════════════════════
// Utils
// ═══════════════════════════════════════
function splitMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLength;
    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > start) end = lastNewline;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

main();
