/**
 * summarize-youtube.js
 *
 * GitHub Action 觸發。從 env 拿 video_id + Discord interaction context。
 *
 * 抓字幕策略（依序試）：
 *   1. watch page scrape — 簡單、從 GitHub IP 不會被 429
 *   2. Innertube ANDROID — yt-dlp 用的客戶端
 *   3. Innertube IOS     — 同上
 *
 * 不再用 youtubei.js（v11 對新 YouTube response 解析失敗，captions field 空）
 */

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

    const transcript = await fetchTranscript(VIDEO_ID);
    console.log(
      `[transcript] lang=${transcript.lang} chars=${transcript.text.length} title="${transcript.title}" channel="${transcript.channel}" dur=${transcript.duration}s elapsed=${Date.now() - t0}ms`
    );

    const summary = await callGemini({
      title: transcript.title,
      channel: transcript.channel,
      videoId: VIDEO_ID,
      text: transcript.text,
      lang: transcript.lang,
      duration: transcript.duration,
    });
    console.log(`[gemini] summary len=${summary.length} elapsed=${Date.now() - t0}ms`);

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
// 抓字幕：多策略 fallback
// ═══════════════════════════════════════
async function fetchTranscript(videoId) {
  const strategies = [
    { name: "watch-page", fn: () => fetchViaWatchPage(videoId) },
    { name: "innertube-ANDROID", fn: () => fetchViaInnertube(videoId, "ANDROID") },
    { name: "innertube-IOS", fn: () => fetchViaInnertube(videoId, "IOS") },
  ];

  let lastErr;
  for (const { name, fn } of strategies) {
    try {
      const result = await fn();
      console.log(`[transcript] strategy=${name} succeeded`);
      return result;
    } catch (e) {
      console.log(`[transcript] strategy=${name} failed: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr || new Error("所有字幕策略都失敗");
}

// ── 策略 1：scrape watch page，取 ytInitialPlayerResponse
async function fetchViaWatchPage(videoId) {
  const t0 = Date.now();
  const resp = await fetch(
    `https://www.youtube.com/watch?v=${videoId}&hl=zh-TW&bpctr=9999999999&has_verified=1`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      },
    }
  );
  if (!resp.ok) throw new Error(`watch HTTP ${resp.status}`);
  const html = await resp.text();
  console.log(`[watch] fetched ${Date.now() - t0}ms size=${html.length}`);

  const m = html.match(
    /ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;\s*(?:var\s|<\/script>)/
  );
  if (!m) throw new Error("找不到 ytInitialPlayerResponse");
  const pr = JSON.parse(m[1]);
  return await extractFromPlayerResponse(pr);
}

// ── 策略 2/3：Innertube API（ANDROID / IOS）
async function fetchViaInnertube(videoId, clientType) {
  const t0 = Date.now();
  const apiKeys = {
    ANDROID: "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
    IOS: "AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc",
  };
  const clients = {
    ANDROID: {
      clientName: "ANDROID",
      clientVersion: "19.45.36",
      androidSdkVersion: 30,
      osName: "Android",
      osVersion: "11",
      userAgent: "com.google.android.youtube/19.45.36 (Linux; U; Android 11) gzip",
      headerClientName: "3",
    },
    IOS: {
      clientName: "IOS",
      clientVersion: "19.45.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.1.0.22B83",
      userAgent:
        "com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)",
      headerClientName: "5",
    },
  };
  const c = clients[clientType];
  const apiKey = apiKeys[clientType];

  const clientCtx = {
    clientName: c.clientName,
    clientVersion: c.clientVersion,
    hl: "zh-TW",
    gl: "TW",
    utcOffsetMinutes: 480,
  };
  if (c.androidSdkVersion) clientCtx.androidSdkVersion = c.androidSdkVersion;
  if (c.deviceMake) clientCtx.deviceMake = c.deviceMake;
  if (c.deviceModel) clientCtx.deviceModel = c.deviceModel;
  if (c.osName) clientCtx.osName = c.osName;
  if (c.osVersion) clientCtx.osVersion = c.osVersion;

  const resp = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": c.userAgent,
        "X-YouTube-Client-Name": c.headerClientName,
        "X-YouTube-Client-Version": c.clientVersion,
      },
      body: JSON.stringify({
        context: { client: clientCtx },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    }
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `innertube HTTP ${resp.status}${body ? " body=" + body.slice(0, 200) : ""}`
    );
  }
  const pr = await resp.json();
  console.log(`[innertube:${clientType}] fetched ${Date.now() - t0}ms`);
  return await extractFromPlayerResponse(pr);
}

// ── 從 player response 抓 captions、合併文字
async function extractFromPlayerResponse(pr) {
  const status = pr.playabilityStatus;
  if (status?.status && status.status !== "OK") {
    throw new Error(`不可播：${status.reason || status.status}`);
  }

  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) {
    const dump = pr.captions ? JSON.stringify(pr.captions).slice(0, 200) : "(null)";
    console.log(`[extract] no captionTracks. captions=${dump}`);
    throw new Error("captions 為空");
  }

  console.log(
    `[extract] tracks: ${tracks
      .map((t) => `${t.languageCode}${t.kind === "asr" ? "/auto" : ""}`)
      .join(", ")}`
  );

  const track = pickBestTrack(tracks);
  const lang = track.languageCode || "unknown";
  const isAuto = track.kind === "asr";

  const url =
    track.baseUrl + (track.baseUrl.includes("fmt=") ? "" : "&fmt=json3");
  const capResp = await fetch(url);
  if (!capResp.ok) throw new Error(`caption fetch ${capResp.status}`);
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

  const v = pr.videoDetails || {};
  return {
    text,
    lang: `${lang}${isAuto ? "(自動)" : ""}`,
    title: v.title || "(未知標題)",
    channel: v.author || "(未知頻道)",
    duration: Number(v.lengthSeconds) || 0,
  };
}

function pickBestTrack(tracks) {
  const preferred = ["zh-TW", "zh-Hant", "zh-CN", "zh-Hans", "zh", "en"];
  for (const lang of preferred) {
    const t = tracks.find(
      (tr) => (tr.languageCode || "").startsWith(lang) && tr.kind !== "asr"
    );
    if (t) return t;
  }
  for (const lang of preferred) {
    const t = tracks.find(
      (tr) => (tr.languageCode || "").startsWith(lang) && tr.kind === "asr"
    );
    if (t) return t;
  }
  return tracks.find((tr) => tr.kind !== "asr") || tracks[0];
}

// ═══════════════════════════════════════
// Gemini
// ═══════════════════════════════════════
async function callGemini({ title, channel, videoId, text, lang, duration }) {
  const isLong = (duration || Math.round(text.length / 5)) > 1800;

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
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
      }),
    }
  );

  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Gemini HTTP ${r.status}`);
  const out = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) throw new Error("Gemini 回傳空內容");
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
