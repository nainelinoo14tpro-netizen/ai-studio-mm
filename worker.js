/**
 * AI Studio All-in-One Master Backend Worker
 * - Models: gemini-3.8-flash, gemini-3.5-flash-lite, gemini-3.6-flash
 * - Dual Oxion AI API Keys (OXION_API_KEY_1 -> OXION_API_KEY_2 Auto-Failover)
 * - Guaranteed Burmese Translation Engine (AI + Server-Side GTX Fallback)
 * - Fast Audio Chunk Timestamp Offset Support for Real 0-100% Progress
 * - Scroll-Stopping Dramatic Hook Engine for Story Maker & Story to Video
 * - Triple-Engine Myanmar TTS (Render Python Backend + Edge WS + Direct HTTPS)
 */

// =====================================================
// CONFIG
// =====================================================

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const EDGE_TTS_BASE = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const RENDER_PYTHON_TTS_URL = "https://ai-studio-mm.onrender.com";

const DEFAULT_MYANMAR_VOICE = "my-MM-ThihaNeural";
const MYANMAR_VOICES = {
  male: "my-MM-ThihaNeural",
  female: "my-MM-NilarNeural",
};

const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
];

// =====================================================
// CORS
// =====================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "X-TTS-Voice, X-AI-Provider",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

// =====================================================
// API KEY COLLECTORS & HELPERS
// =====================================================

function getOxionApiKeys(env) {
  const rawKeys = [
    env.OXION_API_KEY_1,
    env.OXION_API_KEY_2,
    env.OXION_API_KEY,
    env.OXION_KEY_1,
    env.OXION_KEY_2,
  ];
  const validKeys = [];
  for (const item of rawKeys) {
    if (typeof item === "string" && item.trim()) {
      const parts = item.split(",").map((k) => k.trim()).filter(Boolean);
      for (const p of parts) {
        if (!validKeys.includes(p)) validKeys.push(p);
      }
    }
  }
  return validKeys;
}

function getGeminiApiKeys(env) {
  const rawKeys = [
    env.GEMINI_API_KEY,
    env.GEMINI_API_KEY_1,
    env.GEMINI_API_KEY_2,
  ];
  const validKeys = [];
  for (const item of rawKeys) {
    if (typeof item === "string" && item.trim()) {
      const parts = item.split(",").map((k) => k.trim()).filter(Boolean);
      for (const p of parts) {
        if (!validKeys.includes(p)) validKeys.push(p);
      }
    }
  }
  return validKeys;
}

function cleanSongTitleFromFilename(rawName) {
  if (!rawName) return "";
  let s = String(rawName).trim().replace(/\.[a-zA-Z0-9]{2,4}$/, "");
  s = s.replace(
    /\b(official\s*mv|official\s*video|music\s*video|lyric\s*video|lyrics|audio|karaoke|hd|fhd|4k|1080p|720p|mp4|mp3|vocals?|mv)\b/gi,
    " "
  );
  s = s.replace(/[\[\(\{]\s*[\]\)\}]/g, " ");
  s = s.replace(/[_]+/g, " ");
  s = s.replace(/\s+/g, " ").replace(/^[-_.\s]+|[-_.\s]+$/g, "");
  return s;
}

function isGibberishOrPlaceholder(str) {
  const s = String(str || "").trim();
  if (!s) return true;
  if (/random\s+gibberish|random\s+text|အဓိပ္ပာယ်မရှိသော\s*စာသား|prooh/i.test(s)) return true;
  if (/[\u10A0-\u10FF\u0530-\u058F\u0590-\u05FF]/.test(s)) return true;
  return false;
}

function hasMyanmarScript(str) {
  return /[\u1000-\u109F]/.test(String(str || ""));
}

async function serverSideTranslateGTX(text, targetLang = "my") {
  const clean = String(text || "").trim();
  if (!clean) return "";
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(clean)}`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d) && Array.isArray(d[0])) {
        return d[0].map((item) => item[0] || "").join("").trim();
      }
    }
  } catch (e) {}
  return clean;
}

// =====================================================
// MAIN WORKER FETCH
// =====================================================

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(request.url);
      const oxionKeys = getOxionApiKeys(env);
      const geminiKeys = getGeminiApiKeys(env);

      // Health Check
      if ((url.pathname === "/" || url.pathname === "/api/health") && request.method === "GET") {
        return json({
          ok: true,
          service: "ai-studio-backend-master",
          status: "online",
          primary_gemini_model: GEMINI_MODELS[0],
          oxion_keys_count: oxionKeys.length,
          oxion_key_1_configured: !!oxionKeys[0],
          oxion_key_2_configured: !!oxionKeys[1],
          groq_key_configured: !!env.GROQ_API_KEY,
          gemini_key_configured: geminiKeys.length > 0,
          hf_token_configured: !!env.HF_TOKEN,
          tts: {
            enabled: true,
            primary_engine: RENDER_PYTHON_TTS_URL,
            default_voice: DEFAULT_MYANMAR_VOICE,
            voices: MYANMAR_VOICES,
            language: "my-MM",
          },
          routes: [
            "GET /",
            "GET /voices",
            "POST /api/fetch-lyrics",
            "POST /transcribe",
            "POST /api/karaoke",
            "POST /translate",
            "POST /song",
            "POST /recap",
            "POST /story",
            "POST /tts",
            "POST /api/tts",
            "POST /api/synthesize",
            "POST /image",
            "POST /clone-tts",
          ],
        });
      }

      // Voices List
      if (url.pathname === "/voices" && request.method === "GET") {
        return json({
          ok: true,
          language: "my-MM",
          voices: [
            { id: "my-MM-ThihaNeural", name: "Myanmar Male", gender: "male" },
            { id: "my-MM-NilarNeural", name: "Myanmar Female", gender: "female" },
          ],
        });
      }

      // =================================================
      // 0. FETCH LYRICS BY SONG TITLE OR VIDEO FILENAME
      // =================================================
      if (url.pathname === "/api/fetch-lyrics" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const cleanedTitle = cleanSongTitleFromFilename(body?.song_title || "");
        if (!cleanedTitle) {
          return json({ error: "သီချင်းအမည် ရိုက်ထည့်ပေးပါ။" }, 400);
        }

        const prompt = `
သင်သည် မြန်မာသီချင်းနှင့် နိုင်ငံတကာသီချင်းစာသားများကို အတိအကျ သိရှိသော သီချင်းစာသားဘဏ် (Lyrics Database) ဖြစ်သည်။
ရှာဖွေလိုသော သီချင်းအမည် / ဖိုင်အမည်: "${cleanedTitle}"

အထက်ပါ သီချင်း၏ စာသားအပြည့်အစုံကို ကာရာအိုကေ စာတန်းထိုးရန်အတွက် တစ်ကြောင်းချင်းစီ အစဉ်လိုက် ထုတ်ပေးပါ။
Output MUST be ONLY a valid JSON array of strings:
[
  "ပထမ စာကြောင်း...",
  "ဒုတိယ စာကြောင်း..."
]
`;
        const result = await callMasterAIWithFailover(prompt, env);
        if (!result.ok) {
          return json({ error: result.error || "Lyrics ရှာမတွေ့ပါ" }, 503);
        }

        const lines = parseJsonArray(result.text);
        if (!Array.isArray(lines) || !lines.length) {
          return json({ error: "သီချင်းစာသား ဖတ်မရပါ။" }, 422);
        }

        const cleanLines = lines
          .map((l) => String(l || "").trim())
          .filter((l) => l && !isGibberishOrPlaceholder(l));

        return json({
          ok: true,
          song_title: cleanedTitle,
          lyrics_text: cleanLines.join("\n"),
          lines: cleanLines,
        });
      }

      // =================================================
      // 1. AUDIO TRANSCRIPTION & FAST CHUNKED KARAOKE
      // =================================================
      if ((url.pathname === "/transcribe" || url.pathname === "/api/karaoke") && request.method === "POST") {
        const incoming = await request.formData();
        const file = incoming.get("file");
        const songLangHint = String(incoming.get("lang") || "").toLowerCase();
        const modeHint = String(incoming.get("mode") || "").toLowerCase();
        const rawSongTitle = String(incoming.get("song_title") || "").trim();
        const customLyrics = String(incoming.get("lyrics") || "").trim();
        const timeOffset = Math.max(0, Number(incoming.get("time_offset") || 0));

        if (!file || typeof file === "string") {
          return json({ error: "Video သို့မဟုတ် Audio file မတွေ့ရှိပါ။" }, 400);
        }

        let songTitle = cleanSongTitleFromFilename(rawSongTitle || file.name || "");
        if (/^(vocal_isolated|chunk_\d+|audio|video|vid_\d+|lv_\d+|capcut.*|inshot.*|\d+)$/i.test(songTitle)) {
          songTitle = "";
        }

        const isMyanmarSongMode =
          modeHint === "myanmar_gemini_only" ||
          songLangHint === "my" ||
          songLangHint === "myanmar";

        // MYANMAR SONG MODE -> Use Gemini Multimodal Audio (Direct, no extra blocking calls!)
        if (isMyanmarSongMode) {
          if (geminiKeys.length === 0) {
            return json({ error: "မြန်မာသီချင်း နားထောင်ရန် GEMINI_API_KEY လိုအပ်ပါသည်။" }, 500);
          }

          const geminiAudioResult = await transcribeAudioWithGemini(
            file,
            geminiKeys,
            "my",
            songTitle,
            customLyrics,
            timeOffset
          );

          if (geminiAudioResult.ok && geminiAudioResult.segments.length > 0) {
            return json({
              ok: true,
              engine: geminiAudioResult.engine || "gemini-3.8-flash-audio",
              language: "my",
              duration: geminiAudioResult.duration,
              text: geminiAudioResult.segments.map((s) => s.text).join(" "),
              segments: geminiAudioResult.segments,
            });
          }

          return json(
            {
              error:
                geminiAudioResult.error ||
                "မြန်မာသီချင်းဆိုသံကို နားထောင်ရာတွင် စာသားမတွေ့ရှိပါ။",
            },
            422
          );
        }

        // FOREIGN SONG / MOVIE RECAP MODE: Use Groq Whisper First for Ultra-Fast Timestamps (2-4 seconds!)
        if (env.GROQ_API_KEY) {
          try {
            const formData = new FormData();
            formData.append("file", file, file.name || "audio.wav");
            formData.append("model", "whisper-large-v3-turbo");
            formData.append("response_format", "verbose_json");
            formData.append("timestamp_granularities[]", "segment");
            formData.append("temperature", "0");

            const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
              method: "POST",
              headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
              body: formData,
            });

            if (response.ok) {
              const data = await response.json().catch(() => ({}));
              if (Array.isArray(data?.segments) && data.segments.length > 0) {
                const cleanSegments = data.segments
                  .map((s, index) => ({
                    id: index + 1,
                    start: Number(((Number(s.start) || 0) + timeOffset).toFixed(2)),
                    end: Number(((Number(s.end) || 0) + timeOffset).toFixed(2)),
                    text: String(s.text || "").trim(),
                  }))
                  .filter((s) => s.text && !isGibberishOrPlaceholder(s.text) && s.end > s.start);

                if (cleanSegments.length > 0) {
                  return json({
                    ok: true,
                    engine: "groq-whisper",
                    language: data?.language || "auto",
                    duration: (Number(data?.duration) || 0) + timeOffset,
                    text: cleanSegments.map((s) => s.text).join(" "),
                    segments: cleanSegments,
                  });
                }
              }
            }
          } catch (e) {}
        }

        // Fallback to Gemini Audio for foreign songs if Groq fails
        if (geminiKeys.length > 0) {
          const fallbackAudio = await transcribeAudioWithGemini(
            file,
            geminiKeys,
            "auto",
            songTitle,
            customLyrics,
            timeOffset
          );
          if (fallbackAudio.ok && fallbackAudio.segments.length > 0) {
            return json({
              ok: true,
              engine: fallbackAudio.engine || "gemini-3.8-flash-audio",
              language: fallbackAudio.language || "auto",
              duration: fallbackAudio.duration,
              text: fallbackAudio.segments.map((s) => s.text).join(" "),
              segments: fallbackAudio.segments,
            });
          }
        }

        return json({ error: "အသံဖိုင်ထဲမှ စာသား ထုတ်ယူ၍ မရနိုင်ပါ။" }, 422);
      }

      // =================================================
      // 2. BATCH TRANSLATION (GUARANTEED MYANMAR & ENGLISH)
      // =================================================
      if (url.pathname === "/translate" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const texts = body?.texts;
        const isTargetEn = body?.targetLang === "en";
        const targetLangDesc = isTargetEn
          ? "clear, natural, poetic English"
          : "VERY SHORT, concise, poetic Myanmar Burmese (maximum 4 to 6 Burmese words per line so it fits on 1 short subtitle line)";

        if (!Array.isArray(texts) || texts.length === 0) {
          return json({ ok: true, translations: [] });
        }

        const BATCH_SIZE = 35;
        const allTranslations = [];

        for (let start = 0; start < texts.length; start += BATCH_SIZE) {
          const batch = texts.slice(start, start + BATCH_SIZE);
          const prompt = `
You are an expert subtitle and song lyric translator for Myanmar and English.
Translate every line in the input JSON array into ${targetLangDesc}.

CRITICAL RULES:
1. When translating into Myanmar Burmese, you MUST output genuine Myanmar Burmese script (never repeat the English text).
2. Make each Myanmar line ULTRA-CONCISE and poetic (only 4 to 6 words/phrases). Use short pronouns like "ကိုယ်", "မင်း", "တို့".
3. Keep EXACTLY ${batch.length} items in the exact same order.
4. Output ONLY a valid JSON array of strings. No markdown.

Input:
${JSON.stringify(batch)}
`;

          let batchTranslations = null;
          const result = await callMasterAIWithFailover(prompt, env);
          if (result.ok) {
            batchTranslations = parseJsonArray(result.text);
          }

          const normalized = [];
          for (let i = 0; i < batch.length; i++) {
            const orig = String(batch[i] || "").trim();
            let tr = Array.isArray(batchTranslations) && typeof batchTranslations[i] === "string"
              ? batchTranslations[i].replace(/\r?\n/g, " ").trim()
              : "";

            // Server-side GTX guarantee if AI didn't return Burmese for Myanmar target
            if (!isTargetEn && (!tr || !hasMyanmarScript(tr) || isGibberishOrPlaceholder(tr))) {
              tr = await serverSideTranslateGTX(orig, "my");
            } else if (isTargetEn && (!tr || isGibberishOrPlaceholder(tr))) {
              tr = await serverSideTranslateGTX(orig, "en");
            }

            normalized.push(tr || orig);
          }

          allTranslations.push(...normalized);
        }

        return json({
          ok: true,
          translations: allTranslations,
        });
      }

      // =================================================
      // 2B. SONG & KARAOKE TRANSLATOR (100% GUARANTEED MYANMAR)
      // =================================================
      if (url.pathname === "/song" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const rawSegments = Array.isArray(body?.segments) ? body.segments : [];

        if (!rawSegments.length) {
          return json({ error: "Song segments မပါရှိပါ။" }, 400);
        }

        const BATCH_SIZE = 28;
        const allLyrics = [];

        for (let start = 0; start < rawSegments.length; start += BATCH_SIZE) {
          const batch = rawSegments.slice(start, start + BATCH_SIZE);
          const inputPayload = batch.map((s, idx) => ({
            idx,
            text: String(s.text || s.orig || "").replace(/\r?\n/g, " ").trim(),
          }));

          const prompt = `
သင်သည် နိုင်ငံတကာသီချင်းများကို မြန်မာကာရာအိုကေ စာတန်းထိုးအဖြစ် ဘာသာပြန်ပေးသော ပညာရှင် ဖြစ်သည်။

အောက်ပါ သီချင်းစာကြောင်း တစ်ကြောင်းချင်းစီအတွက် မူရင်းစာသား (orig)၊ အင်္ဂလိပ်ဘာသာပြန် (en) နှင့် အလွန်ကျစ်လျစ်တိုတောင်းသော မြန်မာဘာသာပြန် (mm) တို့ကို ထုတ်ပေးပါ။

အလွန်အရေးကြီးသော စည်းမျဉ်းများ:
1. "mm" သည် မြန်မာယူနီကုဒ်စာသား စစ်စစ် ဖြစ်ရမည် (အင်္ဂလိပ်စာသား လုံးဝ ပြန်မထည့်ရပါ)။
2. "mm" (မြန်မာစာတန်း) သည် ဗီဒီယိုပေါ်တွင် (၁) ကြောင်းတည်း လှပစွာ ပေါ်စေရန် အလွန်တိုတိုနှင့် အဓိပ္ပာယ်ထိမိသော သီချင်းစာသားစတိုင် (စကားလုံး ၄ လုံး မှ ၆ လုံးခန့်သာ) ရေးပေးရမည်။
3. "ကျွန်တော်/ကျွန်မ/ခင်ဗျား/သင်" အစား သီချင်းဆန်သော "ကိုယ်/ငါ/မင်း/တို့" ကိုသာ သုံးပါ။
4. စာကြောင်းအရေအတွက် (${inputPayload.length} ကြောင်း) နှင့် အစီအစဉ် (idx) အတိအကျ တူညီရမည်။
5. Output MUST be ONLY a valid JSON array:
[
  {
    "idx": 0,
    "orig": "မူရင်းစာသား",
    "en": "Concise English lyric",
    "mm": "တိုတိုကျစ်လျစ်သော မြန်မာသီချင်းစာတန်း"
  }
]

Input Lyrics:
${JSON.stringify(inputPayload)}
`;

          let parsedBatch = null;
          const result = await callMasterAIWithFailover(prompt, env);
          if (result.ok) {
            parsedBatch = parseJsonArray(result.text);
          }

          for (let i = 0; i < batch.length; i++) {
            const seg = batch[i];
            const origClean = String(seg.text || seg.orig || "").replace(/\r?\n/g, " ").trim();
            const found = Array.isArray(parsedBatch)
              ? parsedBatch.find((item) => Number(item?.idx) === i) || parsedBatch[i] || {}
              : {};

            let mmClean = !isGibberishOrPlaceholder(found.mm)
              ? String(found.mm || "").replace(/\r?\n/g, " ").trim()
              : "";

            // Guarantee genuine Burmese script via Server-Side GTX if AI skipped or returned English
            if (!mmClean || (!hasMyanmarScript(mmClean) && /[a-zA-Z]/.test(mmClean))) {
              mmClean = await serverSideTranslateGTX(origClean, "my");
            }

            allLyrics.push({
              id: start + i + 1,
              start: Number(seg.start) || 0,
              end: Number(seg.end) || 0,
              orig: String(found.orig || origClean).replace(/\r?\n/g, " ").trim(),
              en: String(found.en || origClean).replace(/\r?\n/g, " ").trim(),
              mm: mmClean || origClean,
            });
          }
        }

        return json({
          ok: true,
          lyrics: allLyrics,
        });
      }

      // =================================================
      // 3. MOVIE RECAP (FULL TIMELINE COVERAGE + OPENING HOOK)
      // =================================================
      if (url.pathname === "/recap" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const segments = body?.segments;
        const tone = body?.tone || "narrator";
        const videoDuration = Number(body?.duration) || (segments?.length ? Number(segments[segments.length - 1].end) : 60);

        if (!Array.isArray(segments) || !segments.length) {
          return json({ error: "Transcribed dialogue segments မပါရှိပါ။" }, 400);
        }

        const toneGuides = {
          narrator: "ရုပ်ရှင်ဇာတ်လမ်းပြော စံပြစတိုင်။ သွက်သွက်လက်လက်၊ စိတ်ဝင်စားဖွယ်ရာ၊ ပရိသတ်ကို ဆွဲဆောင်နိုင်သော မြန်မာစကားပြော။",
          suspense: "ရင်ခုန်စိတ်လှုပ်ရှားစရာ အရေးအသား။ သည်းထိတ်ရင်ဖို mood ဖြစ်အောင် ရေးပါ။",
          comedy: "ဟာသပေါ့ပေါ့ပါးပါး၊ သဘာဝကျသော လူငယ်သုံး မြန်မာစကားများဖြင့် ရေးပါ။",
          natural: "သဘာဝကျကျ ဇာတ်ကြောင်းပြောပြသလို စီးဆင်းမှုရှိအောင် ရေးပါ။",
          horror: "ကျောချမ်းစရာ၊ သရဲနှင့် သည်းထိတ်ရင်ဖို mood ပါအောင် ရေးပါ။",
        };

        const maxSegments = 160;
        let sampledSegments = segments;
        if (segments.length > maxSegments) {
          const step = Math.ceil(segments.length / maxSegments);
          sampledSegments = segments.filter((_, idx) => idx % step === 0);
          if (sampledSegments[sampledSegments.length - 1] !== segments[segments.length - 1]) {
            sampledSegments.push(segments[segments.length - 1]);
          }
        }

        const prompt = `
သင်သည် မြန်မာ Movie Recap Channel အတွက် ကျွမ်းကျင်သော ဇာတ်ကြောင်းပြော စာရေးဆရာ ဖြစ်သည်။

အောက်ပါ movie dialogue segments များကို အခြေခံပြီး
ဗီဒီယိုတစ်ခုလုံး၏ စတင်ချိန်မှ ပြီးဆုံးချိန်အထိ အစအဆုံး အချိုးကျ လွှမ်းခြုံသော Myanmar Burmese narration recap script ရေးပါ။

ဗီဒီယို အချက်အလက်:
- ဗီဒီယို စုစုပေါင်း ကြာချိန်: ${Math.round(videoDuration)} စက္ကန့်
- Mood / Tone: ${toneGuides[tone] || toneGuides.narrator}

အလွန်အရေးကြီးသော စည်းမျဉ်းများ:
1. ပထမဆုံး စာကြောင်း (id: 1) ကို ပရိသတ် ဖုန်းပွတ်နေရာမှ ချက်ချင်း ရပ်ကြည့်ချင်လာစေမည့် အလွန်စိတ်ဝင်စားဖွယ် အဖွင့် Hook ဖြင့် စတင်ပါ။
2. Narration timestamps (start/end) များကို 0 စက္ကန့်မှ စတင်၍ ဗီဒီယိုအဆုံး ${Math.round(videoDuration)} စက္ကန့်အထိ ညီညီညာညာ ဖြန့်ခွဲရေးပေးရမည်။
3. စာကြောင်းတစ်ခုလျှင် ဖတ်ရလွယ်စေရန် တိုတိုရှင်းရှင်း (စကားလုံး ၆ လုံး မှ ၁၀ လုံးခန့်သာ) ရေးပါ။
4. Output MUST be ONLY valid JSON array:

[
  {
    "id": 1,
    "start": 0.0,
    "end": 4.5,
    "recap_mm": "ဆွဲဆောင်မှုရှိသော အဖွင့်စာသား..."
  }
]

SOURCE SEGMENTS:
${JSON.stringify(sampledSegments)}
`;

        const result = await callMasterAIWithFailover(prompt, env);
        if (!result.ok) {
          return json(
            { error: result.error, modelErrors: result.modelErrors || [] },
            result.status || 503
          );
        }

        const parsedRecap = parseJsonArray(result.text);
        if (!Array.isArray(parsedRecap)) {
          return json({ error: "Recap JSON array ဖတ်မရပါ။", raw: result.text }, 502);
        }

        return json({
          ok: true,
          recap: parsedRecap,
        });
      }

      // =================================================
      // 4. STORY GENERATOR (CAPTIVATING HOOK FOR STORY MAKER & STORY TO VIDEO)
      // =================================================
      if (url.pathname === "/story" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const {
          topic,
          duration = 1,
          type = "single",
          category = "horror",
          episodes = 2,
        } = body;

        if (!topic) {
          return json({ error: "Story topic လိုအပ်ပါသည်။" }, 400);
        }

        const hookInstruction = `
🔥 အလွန်အရေးကြီးသော အဖွင့်ပိုင်း (SCENE 1 CAPTIVATING HOOK RULE):
- ပထမဆုံး အခန်း (Scene 1) ကို "တစ်ခါတုန်းက..." သို့မဟုတ် ရိုးရှင်းပျင်းရိဖွယ် မိတ်ဆက်စကားဖြင့် လုံးဝ မစရပါ!
- ပထမဆုံး စက္ကန့်ပိုင်းအတွင်း နားထောင်သူ ကြက်သီးထသွားစေမည့်၊ သိချင်စိတ် ပြင်းပြပြီး ဗီဒီယိုကို ဆက်မကြည့်ဘဲ မနေနိုင်အောင် ဆွဲဆောင်နိုင်သည့် (Scroll-Stopping Dramatic Hook / ထူးဆန်းထိတ်လန့်ဖွယ် အဖြစ်အပျက် / အသက်လုရသည့် အခိုက်အတန့် သို့မဟုတ် လျှို့ဝှက်ဆန်းကြယ် မေးခွန်းထုတ်ချက်) ဖြင့် ချက်ချင်း စတင်ရေးသားပါ။
- အခန်းတိုင်းကို စကားပြောဟန် သဘာဝကျကျ၊ ရုပ်ရှင်ဆန်ဆန် စိတ်ဝင်စားဖွယ် အရှိန်အဟုန်မပြတ် စီးဆင်းအောင် ရေးသားပါ။
`;

        let prompt = "";

        if (type === "series") {
          const epCount = Math.min(6, Math.max(2, Number(episodes) || 2));
          prompt = `
သင်သည် ပရိသတ် သန်းချီကြည့်ရှုသော Viral Short Video ဇာတ်လမ်းတွဲ ရေးသားသူ ပညာရှင် ဖြစ်သည်။
အောက်ပါ ခေါင်းစဉ်ကို အခြေခံ၍ စုစုပေါင်း ${epCount} ပိုင်း (Episode 1 မှ Episode ${epCount} အထိ) ပါဝင်သော ဇာတ်လမ်းတွဲကို ရေးပေးပါ။

ခေါင်းစဉ်: "${topic}"
အမျိုးအစား: ${category}
အပိုင်း အရေအတွက်: စုစုပေါင်း ${epCount} ပိုင်း (တစ်ပိုင်းလျှင် အခန်း ၁၅ ခန်း အတိအကျ)

${hookInstruction}

စည်းမျဉ်းများ:
1. Episode တစ်ခုစီ၏ Scene 1 တိုင်းတွင် ပရိသတ်ကို ချက်ချင်း ဖမ်းစားနိုင်သော အပြင်းထန်ဆုံး Hook ဖြင့် စတင်ပြီး၊ အပိုင်းအဆုံး (Scene 15) တွင် နောက်တစ်ပိုင်း ဆက်ကြည့်ချင်လာအောင် Cliffhanger ဖြင့် အဆုံးသတ်ပါ။
2. Scene တစ်ခုစီ၏ မြန်မာစာသား (text_mm) သည် စကားလုံးရေ ၃၅ လုံးမှ ၄၅ လုံးခန့် ရှိရမည်။
3. image_prompt_en ကို Cinematic English visual prompt အဖြစ် ရေးပါ။
4. Output MUST be ONLY valid JSON array:
[
  {
    "episode": 1,
    "scene": 1,
    "text_mm": "ညသန်းခေါင် ၁၂ နာရီတိတိမှာ သင့်အိပ်ခန်းတံခါးကို အပြင်ကမဟုတ်ဘဲ အထဲကနေ လာခေါက်နေသံ ကြားလိုက်ရရင် သင်ဘာလုပ်မလဲ...",
    "image_prompt_en": "Eerie bedroom door at midnight, dramatic shadows, cinematic horror lighting, 8k"
  }
]
`;
        } else {
          const numDur = Number(duration);
          const sceneCount = numDur === 1 ? 8 : (numDur === 2 ? 15 : (numDur === 3 ? 20 : 32));
          prompt = `
သင်သည် ပရိသတ် သန်းချီကြည့်ရှုသော Viral Faceless AI Video ဇာတ်လမ်းရေးဆရာ ဖြစ်သည်။
Topic: "${topic}"
Category: ${category}
Duration: ${numDur} Minutes
Scenes: Exactly ${sceneCount} scenes.

${hookInstruction}

Rules:
1. Scene 1 ကို ပရိသတ် ဖုန်းပွတ်နေရာမှ ရပ်ပြီး နားထောင်ချင်လာစေမည့် အပြင်းထန်ဆုံး စိတ်ဝင်စားဖွယ် Hook ဖြင့် စတင်ပါ။
2. Each scene's narration (text_mm) MUST be 35 to 45 Burmese words long in natural spoken Myanmar Burmese.
3. image_prompt_en MUST be English and highly cinematic.
4. Output ONLY valid JSON array:
[
  {
    "episode": 1,
    "scene": 1,
    "text_mm": "လူတိုင်း မေ့ပျောက်ထားကြတဲ့ ဒီရွာပျက်ကြီးထဲကို ခြေချမိသူတိုင်း ဘာကြောင့် မနက်မိုးလင်းတာနဲ့ ပျောက်ဆုံးသွားကြရတာလဲ...",
    "image_prompt_en": "Abandoned mysterious village in deep fog, cinematic dramatic lighting, 8k resolution"
  }
]
`;
        }

        const result = await callMasterAIWithFailover(prompt, env);
        if (!result.ok) {
          return json({ error: result.error, modelErrors: result.modelErrors || [] }, result.status || 503);
        }

        const parsedStory = parseJsonArray(result.text);
        if (!Array.isArray(parsedStory) || !parsedStory.length) {
          return json({ error: "Story JSON array ဖတ်မရပါ။", raw: result.text }, 502);
        }

        return json({
          ok: true,
          story: parsedStory,
        });
      }

      // =================================================
      // 5. MYANMAR EDGE TTS (RENDER PYTHON + WS + DIRECT HTTPS)
      // =================================================
      if (
        (url.pathname === "/tts" || url.pathname === "/api/tts" || url.pathname === "/api/synthesize") &&
        request.method === "POST"
      ) {
        const body = await request.json().catch(() => ({}));
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        const voice = normalizeMyanmarVoice(body?.voice);
        const rate = normalizeSpeechRate(body?.rate);
        const pitch = normalizeSpeechPitch(body?.pitch);
        const volume = normalizeSpeechVolume(body?.volume);

        if (!text) {
          return json({ error: "Text လိုအပ်ပါသည်။" }, 400);
        }

        if (text.length > 5000) {
          return json({ error: "TTS text အရှည်များလွန်းပါတယ်။ Max 5000 characters." }, 400);
        }

        const audioBuffer = await generateEdgeSpeech(text, voice, rate, pitch, volume);

        return new Response(audioBuffer, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "audio/mpeg",
            "Content-Disposition": `inline; filename="myanmar-tts.mp3"`,
            "Cache-Control": "public, max-age=86400",
            "X-TTS-Voice": voice,
          },
        });
      }

      // =================================================
      // 6. TRIPLE-HYBRID AI IMAGE ENGINE
      // =================================================
      if (url.pathname === "/image" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        let { prompt, engine = "auto" } = body;
        if (!prompt) return json({ error: "Prompt လိုအပ်ပါသည်။" }, 400);

        let cleanPrompt = prompt
          .replace(/[\u1000-\u109F]/g, "")
          .replace(/[^\w\s,.-]/gi, " ")
          .replace(/\bblood(y)?\b/gi, "crimson shade")
          .replace(/\bkill(ed|ing)?\b/gi, "defeat")
          .replace(/\bcorpse\b/gi, "fallen silhouette")
          .replace(/\bdead\b/gi, "silent figure")
          .trim();

        if (!cleanPrompt || cleanPrompt.length < 5) {
          cleanPrompt = "cinematic atmospheric mystery scene, dark lighting, 8k";
        }

        let buffer = null;

        if ((engine === "auto" || engine === "cf") && env.AI) {
          try {
            const cfResp = await env.AI.run(
              "@cf/bytedance/stable-diffusion-xl-lightning",
              { prompt: cleanPrompt, num_steps: 4 }
            );
            if (cfResp) {
              buffer = await new Response(cfResp).arrayBuffer();
            }
          } catch (e) {}
        }

        if (!buffer && (engine === "auto" || engine === "hf")) {
          const hfToken = env.HF_TOKEN || "";
          if (hfToken) {
            try {
              const hfResp = await fetch(
                "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell",
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${hfToken}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ inputs: cleanPrompt }),
                }
              );
              if (hfResp.ok) {
                buffer = await hfResp.arrayBuffer();
              }
            } catch (e) {}
          }
        }

        if (!buffer && engine === "auto") {
          try {
            const seed = Math.floor(Math.random() * 899999) + 100000;
            const fallbackUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt.slice(0, 180))}?width=1024&height=576&nologo=true&seed=${seed}`;
            const fbResp = await fetch(fallbackUrl, {
              headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*" },
            });
            if (fbResp.ok) {
              const tempBuf = await fbResp.arrayBuffer();
              if (tempBuf.byteLength > 1000) buffer = tempBuf;
            }
          } catch (e) {}
        }

        if (buffer && buffer.byteLength > 1000) {
          return new Response(buffer, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "image/jpeg",
              "Cache-Control": "public, max-age=86400",
            },
          });
        }

        return json({ error: "Worker engines exhausted.", code: "FALLBACK_TO_CLIENT" }, 429);
      }

      // =================================================
      // 7. ZEROGPU BURMESE VOICE CLONE
      // =================================================
      if (url.pathname === "/clone-tts" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        const style = body?.style || "News anchor, formal";
        const hfToken = env.HF_TOKEN || "";

        if (!text) {
          return json({ error: "Text လိုအပ်ပါသည်။" }, 400);
        }

        const hfHeaders = { "Content-Type": "application/json" };
        if (hfToken) {
          hfHeaders["Authorization"] = `Bearer ${hfToken}`;
        }

        const hfCallResp = await fetch("https://nlopro-clone-burmese-tts.hf.space/gradio_api/call/prompt_voice", {
          method: "POST",
          headers: hfHeaders,
          body: JSON.stringify({ data: [text, style] }),
        });

        if (!hfCallResp.ok) {
          const errText = await hfCallResp.text().catch(() => "");
          return json({ error: `ZeroGPU Queue Error HTTP ${hfCallResp.status}: ${errText}` }, hfCallResp.status);
        }

        const callData = await hfCallResp.json().catch(() => ({}));
        const eventId = callData?.event_id;
        if (!eventId) {
          return json({ error: "ZeroGPU ထံမှ event_id မရရှိပါ" }, 502);
        }

        const sseResp = await fetch(`https://nlopro-clone-burmese-tts.hf.space/gradio_api/call/prompt_voice/${eventId}`, {
          headers: hfHeaders,
        });

        if (!sseResp.ok) {
          return json({ error: "ZeroGPU Result Stream ဆက်သွယ်မှု မအောင်မြင်ပါ" }, sseResp.status);
        }

        const sseText = await sseResp.text();
        const lines = sseText.split("\n");
        let resultAudioUrl = null;

        for (const line of lines) {
          if (line.startsWith("data:")) {
            try {
              const payload = JSON.parse(line.slice(5).trim());
              if (Array.isArray(payload) && payload[0]) {
                const audioObj = payload[0];
                if (typeof audioObj === "object" && audioObj !== null) {
                  if (audioObj.url) resultAudioUrl = audioObj.url;
                  else if (audioObj.path) resultAudioUrl = `https://nlopro-clone-burmese-tts.hf.space/gradio_api/file=${audioObj.path}`;
                } else if (typeof audioObj === "string" && audioObj.length > 5) {
                  resultAudioUrl = audioObj.startsWith("http")
                    ? audioObj
                    : `https://nlopro-clone-burmese-tts.hf.space/gradio_api/file=${audioObj}`;
                }
              }
            } catch (e) {}
          }
        }

        if (!resultAudioUrl) {
          return json({ error: "ZeroGPU Audio data ထုတ်ယူမရရှိပါ", raw: sseText.slice(0, 350) }, 500);
        }

        return json({ ok: true, url: resultAudioUrl });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (error) {
      console.error("Worker error:", error);
      return json({ ok: false, error: error?.message || "Internal Worker error." }, 500);
    }
  },
};

// =====================================================
// MASTER AI ROUTER:
// 1. GEMINI (3.8-flash / 3.5-flash-lite) -> 2. OXION -> 3. GROQ
// =====================================================

async function callMasterAIWithFailover(prompt, env) {
  const allErrors = [];
  const oxionKeys = getOxionApiKeys(env);
  const geminiKeys = getGeminiApiKeys(env);

  // 1. Try Gemini Direct Keys First
  for (let gIdx = 0; gIdx < geminiKeys.length; gIdx++) {
    const gemKey = geminiKeys[gIdx];
    const gemRes = await callGeminiWithFallback(prompt, gemKey);
    if (gemRes.ok && gemRes.text) {
      return gemRes;
    }
    allErrors.push(...(gemRes.modelErrors || []));
  }

  // 2. Try Oxion AI Keys (Key 1 -> Key 2)
  for (let kIdx = 0; kIdx < oxionKeys.length; kIdx++) {
    const oxKey = oxionKeys[kIdx];
    const oxRes = await callOxionSingleKey(prompt, oxKey, env.OXION_BASE_URL, env.OXION_MODEL, kIdx + 1);
    if (oxRes.ok && oxRes.text) {
      return oxRes;
    }
    allErrors.push(...(oxRes.errors || []));
  }

  // 3. Fallback to Groq Llama-3.3-70b
  if (env.GROQ_API_KEY) {
    try {
      const groqResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: "You are a precise JSON generator. Output valid JSON only." },
            { role: "user", content: prompt },
          ],
          temperature: 0.25,
        }),
      });
      if (groqResp.ok) {
        const gData = await groqResp.json().catch(() => ({}));
        const gText = gData?.choices?.[0]?.message?.content?.trim();
        if (gText) {
          return { ok: true, model: "groq-llama-3.3-70b", text: gText };
        }
      } else {
        allErrors.push({ provider: "groq", status: groqResp.status });
      }
    } catch (e) {
      allErrors.push({ provider: "groq", message: e.message });
    }
  }

  return {
    ok: false,
    status: 503,
    error: "AI Models အားလုံး ချိတ်ဆက်၍ မရနိုင်သေးပါ။",
    modelErrors: allErrors,
  };
}

async function callOxionSingleKey(prompt, apiKey, customBaseUrl, customModel, keySlotNumber) {
  const endpoints = customBaseUrl
    ? [customBaseUrl.replace(/\/+$/, "")]
    : [
        "https://api.oxionai.com/v1/chat/completions",
        "https://oxionai.com/api/v1/chat/completions",
      ];

  const models = customModel
    ? [customModel]
    : ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gpt-4o-mini"];

  const errors = [];

  for (const endpoint of endpoints) {
    for (const model of models) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: "Output ONLY valid JSON without markdown formatting." },
              { role: "user", content: prompt },
            ],
            temperature: 0.25,
          }),
        });

        const raw = await response.text();
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch {}

        if (response.ok) {
          const text =
            data?.choices?.[0]?.message?.content?.trim() ||
            data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("").trim() ||
            data?.text?.trim();

          if (text) {
            return {
              ok: true,
              provider: `oxion-key-${keySlotNumber}`,
              model,
              text,
            };
          }
        } else {
          const status = response.status;
          errors.push({
            provider: `oxion-key-${keySlotNumber}`,
            endpoint,
            model,
            status,
            message: data?.error?.message || `HTTP ${status}`,
          });

          if ([401, 402, 403].includes(status)) {
            return { ok: false, errors };
          }
          continue;
        }
      } catch (err) {
        errors.push({
          provider: `oxion-key-${keySlotNumber}`,
          endpoint,
          model,
          message: err.message,
        });
        break;
      }
    }
  }

  return { ok: false, errors };
}

// =====================================================
// GEMINI MULTIMODAL AUDIO TRANSCRIPTION (FAST CHUNK READY)
// =====================================================

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function transcribeAudioWithGemini(
  fileBlob,
  geminiKeys,
  langHint = "my",
  songTitle = "",
  referenceLyrics = "",
  timeOffset = 0
) {
  try {
    const arrayBuf = await fileBlob.arrayBuffer();
    if (arrayBuf.byteLength > 19 * 1024 * 1024) {
      return { ok: false, error: "အသံဖိုင်ဆိုဒ် အရမ်းကြီးနေပါသည် (Max 19MB)။" };
    }

    const base64Audio = arrayBufferToBase64(arrayBuf);
    const mimeType = fileBlob.type && fileBlob.type.startsWith("audio/") ? fileBlob.type : "audio/wav";

    const titleContext = songTitle ? `သီချင်းအမည်/အဆိုတော်: "${songTitle}"\n` : "";
    const lyricsContext = referenceLyrics
      ? `အောက်ပါ မူရင်းသီချင်းစာသားအမှန်ထဲမှ ဤအသံပိုင်းတွင် သီဆိုနေသော စာကြောင်းများကို အသံချိန် (start နှင့် end စက္ကန့်) အတိအကျဖြင့် ချိန်ညှိပေးပါ:\n${referenceLyrics}\n`
      : "";

    const prompt =
      langHint === "my"
        ? `
သင်သည် မြန်မာသီချင်းများကို နားထောင်ပြီး စာသားနှင့် အချိန် (Timestamps) အတိအကျ ထုတ်ပေးသော ပညာရှင် ဖြစ်သည်။
${titleContext}${lyricsContext}
ဤအသံဖိုင်ထဲရှိ နောက်ခံတီးလုံးသံများ (Guitar, Drums, Music) ကို ကျော်ပြီး အဆိုတော် သီဆိုနေသော မြန်မာသီချင်းစာသားကို နားထောင်၍ မြန်မာယူနီကုဒ်စာသားဖြင့် ထုတ်ပေးပါ။
အကယ်၍ ဤအသံပိုင်းတွင် လူဆိုသံ လုံးဝမပါဘဲ တီးလုံးသက်သက်သာ ဖြစ်နေပါက [] (Empty array) သာ ပြန်ပေးပါ။

စည်းမျဉ်းများ:
1. အဆိုတော် စတင်သီဆိုသည့် စက္ကန့်အတိအကျကို "start" တွင်ထားပြီး စာကြောင်းဆုံးသည့် စက္ကန့်ကို "end" တွင် ထားပါ (ဤအသံဖိုင်၏ 0.0 စက္ကန့်မှ စတင်တွက်ချက်ပါ)။
2. စာကြောင်းတစ်ကြောင်းလျှင် စက္ကန့် ၂.၅ မှ ၄.၅ စက္ကန့်စာခန့် ပိုင်းဖြတ်ပေးပါ။
3. Output MUST be ONLY a valid JSON array:
[
  { "id": 1, "start": 2.5, "end": 6.2, "text": "မြန်မာသီချင်းစာသား..." }
]
`
        : `
Listen carefully to the singing voice in this audio clip (ignoring purely instrumental parts) and transcribe every sung lyric line with accurate start and end timestamps in seconds relative to the start of this audio clip (0.0s).
${titleContext}${lyricsContext}
If there are no vocals in this clip, output [].
Output ONLY a valid JSON array:
[
  { "id": 1, "start": 2.5, "end": 6.2, "text": "Lyric line..." }
]
`;

    for (const apiKey of geminiKeys) {
      for (const model of GEMINI_MODELS) {
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
              },
              body: JSON.stringify({
                contents: [
                  {
                    parts: [
                      { inlineData: { mimeType, data: base64Audio } },
                      { text: prompt },
                    ],
                  },
                ],
                generationConfig: {
                  responseMimeType: "application/json",
                  temperature: 0.1,
                },
              }),
            }
          );

          if (resp.ok) {
            const data = await resp.json().catch(() => ({}));
            const rawText = data?.candidates?.[0]?.content?.parts
              ?.filter((p) => !p.thought)
              ?.map((p) => p?.text || "")
              .join("")
              .trim();

            const parsed = parseJsonArray(rawText);
            if (Array.isArray(parsed)) {
              const cleanSegments = parsed
                .map((s, idx) => ({
                  id: idx + 1,
                  start: Number(((Number(s.start) || 0) + timeOffset).toFixed(2)),
                  end: Number(((Number(s.end) || Number(s.start) + 3.5) + timeOffset).toFixed(2)),
                  text: String(s.text || s.orig || s.mm || "").replace(/\r?\n/g, " ").trim(),
                }))
                .filter((s) => s.text && !isGibberishOrPlaceholder(s.text) && s.end > s.start);

              return {
                ok: true,
                engine: model,
                language: langHint,
                duration: cleanSegments.length ? cleanSegments[cleanSegments.length - 1].end : timeOffset,
                segments: cleanSegments,
              };
            }
          }
        } catch (e) {}
      }
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: false, error: "Gemini Audio ဖြင့် သီချင်းနားထောင်မှု မအောင်မြင်ပါ။" };
}

// =====================================================
// GEMINI MULTI-MODEL FALLBACK ENGINE
// =====================================================

async function callGeminiWithFallback(prompt, apiKey) {
  const errors = [];

  for (const model of GEMINI_MODELS) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.25,
            },
          }),
        }
      );

      const raw = await response.text();
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch {}

      if (response.ok) {
        const rawText = data?.candidates?.[0]?.content?.parts
          ?.filter((p) => !p.thought)
          ?.map((p) => p?.text || "")
          .join("")
          .trim();

        if (rawText) {
          return { ok: true, model, text: rawText };
        }
        errors.push({ model, status: 200, message: "Empty Gemini response" });
      } else {
        const status = response.status;
        const message = data?.error?.message || `HTTP ${status}`;
        errors.push({ model, status, message });
        continue;
      }
    } catch (error) {
      errors.push({ model, status: 0, message: error?.message || "Network error" });
      continue;
    }
  }

  return {
    ok: false,
    status: 503,
    error: "Gemini models အားလုံး ချိတ်ဆက်၍ မရနိုင်သေးပါ။",
    modelErrors: errors,
  };
}

// =====================================================
// SEC-MS-GEC TOKEN & EDGE TTS CONTROLLER
// =====================================================

async function getSecMsGec() {
  const unixSeconds = BigInt(Math.floor(Date.now() / 1000));
  const windowsEpoch = 11644473600n;
  let ticks = unixSeconds + windowsEpoch;
  ticks -= ticks % 300n;

  const integerTicks = ticks * 10000000n;
  const data = `${integerTicks.toString()}${TRUSTED_CLIENT_TOKEN}`;

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));

  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

async function generateEdgeSpeech(text, voice, rate, pitch, volume) {
  const errors = [];

  try {
    const renderResp = await fetch(`${RENDER_PYTHON_TTS_URL}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, rate, pitch }),
    });
    if (renderResp.ok) {
      const renderBuf = await renderResp.arrayBuffer();
      if (renderBuf && renderBuf.byteLength > 200) {
        return renderBuf;
      }
    } else {
      errors.push(`Render HTTP ${renderResp.status}`);
    }
  } catch (renderErr) {
    errors.push(`Render: ${renderErr.message}`);
  }

  try {
    const wsBuffer = await generateEdgeSpeechWebSocket(text, voice, rate, pitch, volume);
    if (wsBuffer && wsBuffer.byteLength > 100) {
      return wsBuffer;
    }
  } catch (wsErr) {
    errors.push(`WS: ${wsErr.message}`);
  }

  try {
    const httpBuffer = await generateEdgeSpeechDirectHttp(text, voice, rate, pitch, volume);
    if (httpBuffer && httpBuffer.byteLength > 100) {
      return httpBuffer;
    }
  } catch (httpErr) {
    errors.push(`HTTP: ${httpErr.message}`);
  }

  throw new Error(`Myanmar TTS failed (${errors.join(" | ")})`);
}

async function generateEdgeSpeechDirectHttp(text, voice, rate, pitch, volume) {
  const secMsGec = await getSecMsGec();
  const connectionId = crypto.randomUUID().replace(/-/g, "");
  const muid = crypto.randomUUID().replace(/-/g, "").toUpperCase();
  const reqId = crypto.randomUUID().replace(/-/g, "");
  const dateStr = new Date().toUTCString();
  const safeText = escapeXml(removeBadCharacters(text));

  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='my-MM'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${safeText}</prosody>` +
    `</voice>` +
    `</speak>`;

  const endpointUrl =
    `${EDGE_TTS_BASE}/edge/v1` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${connectionId}`;

  const payload =
    `X-Timestamp:${dateStr}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-RequestId:${reqId}\r\n` +
    `Path:ssml\r\n\r\n` +
    `${ssml}`;

  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      "User-Agent":
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ` +
        `AppleWebKit/537.36 (KHTML, like Gecko) ` +
        `Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 ` +
        `Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
      "Accept-Encoding": "gzip, deflate, br",
      Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      Cookie: `muid=${muid};`,
      "Sec-MS-GEC": secMsGec,
      "Sec-MS-GEC-Version": SEC_MS_GEC_VERSION,
      "Content-Type": "application/ssml+xml",
    },
    body: payload,
  });

  if (!response.ok) {
    throw new Error(`Direct HTTPS status ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const rawBytes = new Uint8Array(arrayBuffer);
  const sepBytes = new TextEncoder().encode("Path:audio\r\n");
  const sepIndex = findSubarrayIndex(rawBytes, sepBytes);

  const audioBytes = sepIndex !== -1 ? rawBytes.subarray(sepIndex + sepBytes.length) : rawBytes;
  if (!audioBytes || audioBytes.byteLength < 100) {
    throw new Error("Direct HTTPS returned empty audio");
  }

  return audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength);
}

async function generateEdgeSpeechWebSocket(text, voice, rate, pitch, volume) {
  const connectionId = crypto.randomUUID().replace(/-/g, "");
  const muid = crypto.randomUUID().replace(/-/g, "").toUpperCase();
  const secMsGec = await getSecMsGec();

  const wsUrl =
    `${EDGE_TTS_BASE}/edge/v1` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${connectionId}`;

  const response = await fetch(wsUrl, {
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "User-Agent":
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ` +
        `AppleWebKit/537.36 (KHTML, like Gecko) ` +
        `Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 ` +
        `Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
      Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      Cookie: `muid=${muid};`,
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      "Sec-MS-GEC": secMsGec,
      "Sec-MS-GEC-Version": SEC_MS_GEC_VERSION,
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const ws = response.webSocket;
  if (!ws) {
    throw new Error(`WebSocket handshake HTTP ${response.status}`);
  }

  ws.accept();

  const requestId = crypto.randomUUID().replace(/-/g, "");
  const timestamp = getEdgeTimestamp();
  const safeText = escapeXml(removeBadCharacters(text));

  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="my-MM">` +
    `<voice name="${voice}">` +
    `<prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${safeText}</prosody>` +
    `</voice>` +
    `</speak>`;

  return new Promise((resolve, reject) => {
    const audioChunks = [];
    let finished = false;
    let receivedAudio = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { ws.close(); } catch {}
      reject(new Error("Myanmar TTS timeout"));
    }, 20000);

    const finish = (error = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      if (error) return reject(error);
      if (!receivedAudio) return reject(new Error("No audio received"));
      try {
        resolve(concatAudioChunks(audioChunks));
      } catch (err) {
        reject(err);
      }
    };

    ws.addEventListener("message", async (event) => {
      try {
        const data = event.data;
        if (typeof data === "string") {
          const { headers, body } = parseEdgeTextMessage(data);
          if (headers.Path === "turn.end") finish();
          else if (headers.Path === "error") finish(new Error(body || "Edge TTS error"));
          return;
        }
        const buffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
        if (!buffer || buffer.byteLength < 2) return;
        const view = new DataView(buffer);
        const headerLength = view.getUint16(0, false);
        const dataStart = headerLength + 2;
        if (buffer.byteLength <= dataStart) return;
        const headerText = new TextDecoder().decode(buffer.slice(2, dataStart));
        const headers = parseEdgeHeaders(headerText);
        if (headers.Path === "audio") {
          const audio = buffer.slice(dataStart);
          if (audio.byteLength > 0) {
            receivedAudio = true;
            audioChunks.push(audio);
          }
        }
      } catch (err) {
        finish(err);
      }
    });

    ws.addEventListener("error", () => finish(new Error("WebSocket error")));
    ws.addEventListener("close", () => {
      if (!finished) finish(receivedAudio ? null : new Error("Connection closed"));
    });

    ws.send(
      `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                outputFormat: "audio-24khz-48kbitrate-mono-mp3",
              },
            },
          },
        })
    );

    ws.send(
      `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n${ssml}`
    );
  });
}

// =====================================================
// UTILITIES
// =====================================================

function findSubarrayIndex(haystack, needle) {
  if (!needle.length || haystack.length < needle.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function normalizeMyanmarVoice(voice) {
  return voice === MYANMAR_VOICES.female ? MYANMAR_VOICES.female : MYANMAR_VOICES.male;
}

function normalizeSpeechRate(rate) {
  return typeof rate === "string" && /^[+-]\d{1,3}%$/.test(rate) ? rate : "+0%";
}

function normalizeSpeechPitch(pitch) {
  return typeof pitch === "string" && /^[+-]\d{1,3}Hz$/.test(pitch) ? pitch : "+0Hz";
}

function normalizeSpeechVolume(volume) {
  return typeof volume === "string" && /^[+-]\d{1,3}%$/.test(volume) ? volume : "+0%";
}

function getEdgeTimestamp() {
  return new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");
}

function escapeXml(text) {
  return String(text).replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      case '"': return "&quot;";
      default: return char;
    }
  });
}

function removeBadCharacters(text) {
  return String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

function parseEdgeTextMessage(message) {
  const separator = "\r\n\r\n";
  const index = message.indexOf(separator);
  if (index === -1) {
    return { headers: parseEdgeHeaders(message), body: "" };
  }
  return {
    headers: parseEdgeHeaders(message.slice(0, index)),
    body: message.slice(index + separator.length),
  };
}

function parseEdgeHeaders(headerText) {
  const headers = {};
  const lines = String(headerText).split(/\r?\n/);
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

function concatAudioChunks(chunks) {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

function parseJsonArray(text) {
  if (!text) return null;
  let clean = text.trim();
  if (clean.startsWith("```json")) clean = clean.slice(7);
  else if (clean.startsWith("```")) clean = clean.slice(3);
  if (clean.endsWith("```")) clean = clean.slice(0, -3);
  clean = clean.trim();

  try {
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "object" && parsed !== null) {
      for (const k of ["lyrics", "translations", "lines", "story", "episodes", "scenes", "data", "recap", "segments"]) {
        if (Array.isArray(parsed[k])) return parsed[k];
      }
      for (const k in parsed) {
        if (Array.isArray(parsed[k])) return parsed[k];
      }
    }
  } catch {}

  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(clean.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  return null;
}
