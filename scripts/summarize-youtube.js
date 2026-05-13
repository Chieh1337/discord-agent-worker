/**
 * summarize-youtube.js
 *
 * 由 GitHub Action 觸發。從 env 拿 video_id + Discord interaction context，
 * 1) 抓字幕（GitHub IP，YouTube 不擋）
 * 2) 呼叫 Gemini 2.5 Flash 整理成繁中筆記
 * 3) PATCH 回原本那條 Discord 訊息
 *
 * 抓字幕策略：用 youtubei.js getInfo() 拿 caption tracks，
 *           然後自己 fetch baseUrl?fmt=json3（避開 buggy 的 getTranscript()）
 */

import { Innertube } from "youtubei.js";

const {
  VIDEO_ID,
  APPLICATION_ID,
  INTERACTION_TOKEN,
  GEMINI_API_KEY,
  DISCORD_BOT_TOKEN,
} = process.env;

// ═══════════════════════════════════════
// Main
// ═══════════════════════════════════════
async function main() {
  console.log(`[start] video=${VIDEO_ID}`);
  const t0 = Date.now();

  try {
    if (!VIDEO_ID || !APPLICATION_ID || !INTERACTION_TOKEN) {
      throw new Error("缺必要 env (VIDEO_ID / APPLICATION_ID / INTERACTION_TOKEN)");
    }
    if (!GEMINI_API_KEY || !DISCORD_BOT_TOKEN) {
      throw new Error("缺 GEMINI_API_KEY 或 DISCORD_BOT_TOKEN");
    }

    // 1) 抓字幕 + metadata
    const transcript = await fetchTranscript(VIDEO_ID);
    console.log(
      `[transcript] lang=${transcript.lang} chars=${transcript.text.length} title="${transcript.title}" channel="${transcript.channel}" dur=${transcript.duration}s elapsed=${Date.now() - t0}ms`
    );

    // 2) Gemini 整理
    const summary = await callGemini({
      title: transcript.title,
      channel: transcript.channel,
      videoId: VIDEO_ID,
      text: transcript.text,
      lang: transcript.lang,
      duration: transcript.duration,
    });
    console.log(`[gemini] summary len=${summary.length} elapsed=${Date.now() - t0}ms`);

    // 3) PATCH 回 Discord
    const durMin = transcript.duration ? `${Math.round(transcript.duration / 60)}分 · ` : "";
    const header = `_📝 字幕模式 · ${transcript.lang} · ${durMin}${transcript.text.length.toLocaleString()}字_\n\n`;
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
// YouTube 字幕：getInfo() + 自抓 timedtext
// ═══════════════════════════════════════
async function fetchTranscript(videoId) {
  const yt = await Innertube.create({
    lang: "zh-TW",
    location: "TW",
    retrieve_player: false,
  });

  const info = await yt.getInfo(videoId);
  const basic = info.basic_info || {};

  const tracks =
    info.captions?.caption_tracks ||
    info.captions?.captionTracks ||
    [];

  if (!tracks || tracks.length === 0) {
    const capsDump = info.captions
      ? JSON.stringify(info.captions).slice(0, 300)
      : "(no captions field)";
    console.log(`[transcript] no tracks. captions=${capsDump}`);
    throw new Error("這支影片沒有可用字幕");
  }

  console.log(
    `[transcript] tracks: ${tracks
      .map((t) => `${t.language_code || t.languageCode}${t.kind === "asr" ? "/auto" : ""}`)
      .join(", ")}`
  );

  const track = pickBestTrack(tracks);
  const lang = track.language_code || track.languageCode || "unknown";
  const isAuto = track.kind === "asr";
  console.log(`[transcript] picked: ${lang}${isAuto ? "/auto" : ""}`);

  const baseUrl = track.base_url || track.baseUrl;
  if (!baseUrl) throw new Error("track 沒有 base_url");
  const captionUrl = baseUrl + (baseUrl.includes("fmt=") ? "" : "&fmt=json3");
  const capResp = await fetch(captionUrl);
  if (!capResp.ok) {
    throw new Error(`字幕內容 fetch 失敗：HTTP ${capResp.status}`);
  }
  const capData = await capResp.json();

  const text = capData.events
    ?.filter((e) => e.segs)
    ?.map((e) => e.segs.map((s) => s.utf8 || "").join(""))
    ?.join(" ")
    ?.replace(/\s+/g, " ")
    ?.trim();

  if (!text || text.length < 50) {
    throw new Error(`字幕為空或過短（${text?.length || 0} 字）`);
  }

  return {
    text,
    lang: `${lang}${isAuto ? "(自動)" : ""}`,
    title: basic.title || "(未知標題)",
    channel: basic.author || basic.channel?.name || "(未知頻道)",
    duration: basic.duration || 0,
  };
}

function pickBestTrack(tracks) {
  const preferred = ["zh-TW", "zh-Hant", "zh-CN", "zh-Hans", "zh", "en"];
  for (const lang of preferred) {
    const t = tracks.find((tr) => {
      const code = tr.language_code || tr.languageCode || "";
      return code.startsWith(lang) && tr.kind !== "asr";
    });
    if (t) return t;
  }
  for (const lang of preferred) {
    const t = tracks.find((tr) => {
      const code = tr.language_code || tr.languageCode || "";
      return code.startsWith(lang) && tr.kind === "asr";
    });
    if (t) return t;
  }
  return tracks.find((tr) => tr.kind !== "asr") || tracks[0];
}

// ═══════════════════════════════════════
// Gemini
// ═══════════════════════════════════════
async function callGemini({ title, channel, videoId, text, lang, duration }) {
  const isLong = (duration || estimateDurationFromTranscript(text)) > 1800;

  const prompt = `你是專業的學習筆記整理員。下面是一支 YouTube 影片的逐字稿，請整理成結構化的繁體中文學習筆記。

【影片資訊】
標題：${title}
頻道：${channel}
字幕語言：${lang}
字幕字數：${text.length}

【輸出格式】

**📺 ${title}**
**📡 ${channel}**

## 🎯 核心摘要
（3-5 句話，把這支影片在講的事說清楚）

## 💡 重點精華
（依影片實際內容抓出 ${isLong ? "10-15" : "6-10"} 條 bullet points，每條 2-3 句，具體且有資訊量。長片要多抓深度，不是條數多而已）

## 🔑 關鍵概念
（3-7 個影片中提到的重要名詞、框架、理論，附簡短定義）

${isLong ? `## 📚 章節結構
（按影片時序拆 4-7 個段落，每段一行標題 + 1-2 句該段在講什麼）

` : ""}## ✅ 可行動建議
（2-5 個可立即套用的具體行動）

【嚴格規則】
- 完全基於下方逐字稿內容，不要編造影片裡沒提到的東西
- 自動字幕可能有錯字或斷句問題，請依上下文修正後再摘要
- 重點要「有資訊密度」，避免「這很重要」「需要注意」這類廢話

【影片連結】
https://www.youtube.com/watch?v=${videoId}

【逐字稿】
${text}`;

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
        },
      }),
    }
  );

  const data = await r.json();
  if (!r.ok) {
    throw new Error(data.error?.message || `Gemini HTTP ${r.status}`);
  }
  const out = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) throw new Error("Gemini 回傳空內容");
  return out;
}

function estimateDurationFromTranscript(text) {
  // 粗估：~5 字/秒
  return Math.round(text.length / 5);
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
