/**
 * AI Studio All-in-One Master Backend Worker
 * - Dual Oxion AI API Keys (OXION_API_KEY_1 -> OXION_API_KEY_2 Auto-Failover)
 * - Dedicated Gemini Multimodal Audio Engine for Myanmar Songs (No Whisper Gibberish)
 * - Concise Poetic Myanmar Lyric Translation for Foreign Songs
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
// API KEY COLLECTORS (AUTO-ROTATION HELPER)
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

function isGibberishOrPlaceholder(str) {
  const s = String(str || "").trim();
  if (!s) return true;
  if (/random\s+gibberish|random\s+text|အဓိပ္ပာယ်မရှိသော\s*စာသား|prooh/i.test(s)) return true;
  if (/[\u10A0-\u10FF\u0530-\u058F\u0590-\u05FF]/.test(s)) return true;
  return false;
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
            "POST /transcribe",
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
      // 1. AUDIO TRANSCRIPTION
      // - Myanmar Song Mode -> STRICTLY Gemini Multimodal Audio (Never Whisper!)
      // - Foreign / Recap Mode -> Groq Whisper + Gemini Audio Fallback
      // =================================================
      if (url.pathname === "/transcribe" && request.method === "POST") {
        const incoming = await request.formData();
        const file = incoming.get("file");
        const songLangHint = String(incoming.get("lang") || "").toLowerCase();
        const modeHint = String(incoming.get("mode") || "").toLowerCase();

        if (!file || typeof file === "string") {
          return json({ error: "Video သို့မဟုတ် Audio file မတွေ့ရှိပါ။" }, 400);
        }

        const isMyanmarSongMode =
          modeHint === "myanmar_gemini_only" ||
          songLangHint === "my" ||
          songLangHint === "myanmar";

        // MYANMAR SONG MODE: Use Gemini Multimodal Audio ONLY (Never fall back to Groq Whisper!)
        if (isMyanmarSongMode) {
          if (geminiKeys.length === 0) {
            return json(
              { error: "မြန်မာသီချင်း နားထောင်ရန် GEMINI_API_KEY လိုအပ်ပါသည်။ Cloudflare Secrets တွင် စစ်ဆေးပါ။" },
              500
            );
          }

          const geminiAudioResult = await transcribeAudioWithGemini(file, geminiKeys, "my");
          if (geminiAudioResult.ok && geminiAudioResult.segments.length > 0) {
            return json({
              ok: true,
              engine: "gemini-audio-myanmar",
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
                "မြန်မာသီချင်းဆိုသံကို Gemini Audio ဖြင့် နားထောင်ရာတွင် စာသားမတွေ့ရှိပါ (သို့မဟုတ် ဖိုင်ဆိုဒ်ကြီးနေပါသည်)။",
            },
            422
          );
        }

        // FOREIGN SONG / MOVIE RECAP MODE: Try Groq Whisper first for timestamps
        if (!env.GROQ_API_KEY && geminiKeys.length === 0) {
          return json({ error: "GROQ_API_KEY သို့မဟုတ် GEMINI_API_KEY မထည့်ရသေးပါ။" }, 500);
        }

        if (env.GROQ_API_KEY) {
          const formData = new FormData();
          formData.append("file", file, file.name || "audio.mp4");
          formData.append("model", "whisper-large-v3-turbo");
          formData.append("response_format", "verbose_json");
          formData.append("timestamp_granularities[]", "segment");
          formData.append("temperature", "0");

          const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
            body: formData,
          });

          const raw = await response.text();
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            data = { error: raw };
          }

          if (response.ok && Array.isArray(data?.segments) && data.segments.length > 0) {
            const cleanSegments = data.segments
              .map((s, index) => ({
                id: index + 1,
                start: Number(s.start) || 0,
                end: Number(s.end) || 0,
                text: String(s.text || "").trim(),
              }))
              .filter((s) => s.text && !isGibberishOrPlaceholder(s.text) && s.end > s.start);

            if (cleanSegments.length > 0) {
              return json({
                ok: true,
                engine: "groq-whisper",
                language: data?.language || null,
                duration: Number(data?.duration) || null,
                text: cleanSegments.map((s) => s.text).join(" "),
                segments: cleanSegments,
              });
            }
          }
        }

        // Fallback to Gemini Audio Transcription for foreign songs if Whisper failed
        if (geminiKeys.length > 0) {
          const fallbackAudio = await transcribeAudioWithGemini(file, geminiKeys, "auto");
          if (fallbackAudio.ok && fallbackAudio.segments.length > 0) {
            return json({
              ok: true,
              engine: "gemini-audio-fallback",
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
      // 2. BATCH TRANSLATION (CONCISE MYANMAR & ENGLISH)
      // =================================================
      if (url.pathname === "/translate" && request.method === "POST") {
        if (oxionKeys.length === 0 && geminiKeys.length === 0 && !env.GROQ_API_KEY) {
          return json({ error: "API Key (Oxion သို့မဟုတ် Gemini) မထည့်ရသေးပါ။" }, 500);
        }

        const body = await request.json().catch(() => ({}));
        const texts = body?.texts;
        const isTargetEn = body?.targetLang === "en";
        const targetLangDesc = isTargetEn
          ? "clear, natural, poetic English"
          : "VERY SHORT, concise, poetic Myanmar Burmese (maximum 4 to 7 Burmese words per line so it fits on 1 short subtitle line)";

        if (!Array.isArray(texts) || texts.length === 0) {
          return json({ ok: true, translations: [] });
        }

        if (texts.length > 500) {
          return json({ error: "Subtitle lines အရမ်းများပါသည်။ Max 500 lines." }, 400);
        }

        const BATCH_SIZE = 35;
        const allTranslations = [];

        for (let start = 0; start < texts.length; start += BATCH_SIZE) {
          const batch = texts.slice(start, start + BATCH_SIZE);
          const prompt = `
You are an expert subtitle and song lyric translator for Myanmar and English.
Translate every line in the input JSON array into ${targetLangDesc}.

CRITICAL RULES:
1. When translating into Myanmar Burmese, make each line ULTRA-CONCISE and poetic (only 4 to 7 words/phrases). Never write long, wordy prose sentences. Use short pronouns like "ကိုယ်", "မင်း", "တို့" instead of "ကျွန်တော်", "ခင်ဗျား".
2. Never output placeholder text like "random text", "gibberish", or "အဓိပ္ပာယ်မရှိသော စာသား".
3. Keep EXACTLY ${batch.length} items in the exact same order.
4. Each item must be a single line string without newline characters.
5. Output ONLY a valid JSON array of strings. No markdown, no explanation.

Input:
${JSON.stringify(batch)}
`;

          const result = await callMasterAIWithFailover(prompt, env);
          if (!result.ok) {
            return json(
              { error: result.error, modelErrors: result.modelErrors || [] },
              result.status || 503
            );
          }

          const batchTranslations = parseJsonArray(result.text);
          if (!Array.isArray(batchTranslations)) {
            return json({ error: "Translation JSON ဖတ်မရပါ။", raw: result.text }, 502);
          }

          const normalized = batch.map((orig, i) => {
            const tr = batchTranslations[i];
            if (typeof tr === "string" && tr.trim() && !isGibberishOrPlaceholder(tr)) {
              return tr.replace(/\r?\n/g, " ").trim();
            }
            return String(orig);
          });

          allTranslations.push(...normalized);
        }

        return json({
          ok: true,
          translations: allTranslations,
        });
      }

      // =================================================
      // 2B. SONG & KARAOKE TRANSLATOR (ULTRA-SHORT CONCISE MYANMAR)
      // =================================================
      if (url.pathname === "/song" && request.method === "POST") {
        if (oxionKeys.length === 0 && geminiKeys.length === 0 && !env.GROQ_API_KEY) {
          return json({ error: "API Key (Oxion သို့မဟုတ် Gemini) မထည့်ရသေးပါ။" }, 500);
        }

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
1. "mm" (မြန်မာစာတန်း) သည် ဗီဒီယိုပေါ်တွင် (၁) ကြောင်းတည်း လှပစွာ ပေါ်စေရန် အလွန်တိုတိုနှင့် အဓိပ္ပာယ်ထိမိသော သီချင်းစာသားစတိုင် (စကားလုံး ၄ လုံး မှ ၇ လုံးခန့်သာ) ရေးပေးရမည်။ စာကြောင်းအရှည်ကြီး လုံးဝ မရေးရပါ။
   - ဥပမာ - "But I know the truth, you're just in love with yourself" ဆိုပါက "ဒါပေမဲ့ ငါသိပါတယ်၊ မင်းက မင်းကိုယ်မင်းပဲ ချစ်နေတာပါ" ဟု အရှည်ကြီး မရေးဘဲ "မင်းက ကိုယ့်ကိုယ်ကိုယ်ပဲ ချစ်သူပါ" သို့မဟုတ် "ငါသိတယ် မင်းက အတ္တသမားပါ" ဟု တိုတိုကျစ်လျစ်စွာ ရေးပါ။
2. "ကျွန်တော်/ကျွန်မ/ခင်ဗျား/သင်" အစား သီချင်းဆန်သော "ကိုယ်/ငါ/မင်း/တို့" ကိုသာ သုံးပါ။
3. မည်သည့်အခါမှ "random text", "gibberish", "အဓိပ္ပာယ်မရှိသော စာသား" ဟု မရေးရပါ။
4. စာကြောင်းအရေအတွက် (${inputPayload.length} ကြောင်း) နှင့် အစီအစဉ် (idx) အတိအကျ တူညီရမည်။ (\n မပါရ)။
5. Output MUST be ONLY a valid JSON array in this exact format:
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

          const result = await callMasterAIWithFailover(prompt, env);
          if (!result.ok) {
            return json(
              { error: result.error, modelErrors: result.modelErrors || [] },
              result.status || 503
            );
          }

          const parsedBatch = parseJsonArray(result.text);
          if (!Array.isArray(parsedBatch)) {
            return json({ error: "Song translation JSON ဖတ်မရပါ။", raw: result.text }, 502);
          }

          for (let i = 0; i < batch.length; i++) {
            const seg = batch[i];
            const origClean = String(seg.text || seg.orig || "").replace(/\r?\n/g, " ").trim();
            const found = parsedBatch.find((item) => Number(item?.idx) === i) || parsedBatch[i] || {};

            const mmClean = !isGibberishOrPlaceholder(found.mm)
              ? String(found.mm).replace(/\r?\n/g, " ").trim()
              : origClean;

            allLyrics.push({
              id: start + i + 1,
              start: Number(seg.start) || 0,
              end: Number(seg.end) || 0,
              orig: String(found.orig || origClean).replace(/\r?\n/g, " ").trim(),
              en: String(found.en || origClean).replace(/\r?\n/g, " ").trim(),
              mm: mmClean,
            });
          }
        }

        return json({
          ok: true,
          lyrics: allLyrics,
        });
      }

      // =================================================
      // 3. MOVIE RECAP (FULL TIMELINE COVERAGE)
      // =================================================
      if (url.pathname === "/recap" && request.method === "POST") {
        if (oxionKeys.length === 0 && geminiKeys.length === 0 && !env.GROQ_API_KEY) {
          return json({ error: "API Key (Oxion သို့မဟုတ် Gemini) မထည့်ရသေးပါ။" }, 500);
        }

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
1. Myanmar Burmese စကားပြောစစ်စစ်ဖြင့် ရေးပါ။
2. Narration timestamps (start/end) များကို 0 စက္ကန့်မှ စတင်၍ ဗီဒီယိုအဆုံး ${Math.round(videoDuration)} စက္ကန့်အထိ ညီညီညာညာ ဖြန့်ခွဲရေးပေးရမည်။
3. စာကြောင်းတစ်ခုလျှင် ဖတ်ရလွယ်စေရန် တိုတိုရှင်းရှင်း (စကားလုံး ၆ လုံး မှ ၁၀ လုံးခန့်သာ) ရေးပါ။
4. Output MUST be ONLY valid JSON array:

[
  {
    "id": 1,
    "start": 0.0,
    "end": 4.5,
    "recap_mm": "ဇာတ်လမ်းစစချင်းမှာတော့..."
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
      // 4. STORY GENERATOR
      // =================================================
      if (url.pathname === "/story" && request.method === "POST") {
        if (oxionKeys.length === 0 && geminiKeys.length === 0 && !env.GROQ_API_KEY) {
          return json({ error: "API Key (Oxion သို့မဟုတ် Gemini) မထည့်ရသေးပါ။" }, 500);
        }

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

        let prompt = "";

        if (type === "series") {
          const epCount = Math.min(6, Math.max(2, Number(episodes) || 2));
          prompt = `
သင်သည် နာမည်ကြီး Social Media Short Series ရေးသားသူ ပုံပြင်နှင့် ဇာတ်လမ်းရေးဆရာ ဖြစ်သည်။
အောက်ပါ ခေါင်းစဉ်ကို အခြေခံ၍ စုစုပေါင်း ${epCount} ပိုင်း (Episode 1 မှ Episode ${epCount} အထိ) ပါဝင်သော ဇာတ်လမ်းတွဲကို ရေးပေးပါ။

ခေါင်းစဉ်: "${topic}"
အမျိုးအစား: ${category}
အပိုင်း အရေအတွက်: စုစုပေါင်း ${epCount} ပိုင်း (တစ်ပိုင်းလျှင် အခန်း ၁၅ ခန်း အတိအကျ)

စည်းမျဉ်းများ:
1. Episode တစ်ခုစီတွင် scene 1 မှ scene 15 အထိ အခန်း ၁၅ ခန်း အတိအကျ ပါဝင်ရမည်။
2. Scene တစ်ခုစီ၏ မြန်မာစာသား (text_mm) သည် စကားလုံးရေ ၃၅ လုံးမှ ၄၅ လုံးခန့် ရှိရမည်။
3. image_prompt_en ကို Cinematic English visual prompt အဖြစ် ရေးပါ။
4. Output MUST be ONLY valid JSON array:
[
  {
    "episode": 1,
    "scene": 1,
    "text_mm": "ညဉ့်နက်သန်းခေါင်ယံ တောနက်ကြီးတစ်ခုအတွင်းမှာ...",
    "image_prompt_en": "Dark foggy mysterious forest at midnight, cinematic lighting, 8k"
  }
]
`;
        } else {
          const numDur = Number(duration);
          const sceneCount = numDur === 1 ? 8 : (numDur === 2 ? 15 : (numDur === 3 ? 20 : 32));
          prompt = `
Write a cinematic scene-by-scene complete story for Faceless AI Video.
Topic: "${topic}"
Category: ${category}
Duration: ${numDur} Minutes
Scenes: Exactly ${sceneCount} scenes.

Rules:
1. Each scene's narration (text_mm) MUST be 35 to 45 Burmese words long in natural spoken Myanmar Burmese.
2. image_prompt_en MUST be English and highly cinematic.
3. Output ONLY valid JSON array:
[
  {
    "episode": 1,
    "scene": 1,
    "text_mm": "ညဉ့်နက်သန်းခေါင်ယံ တောနက်ကြီးတစ်ခုအတွင်းမှာ...",
    "image_prompt_en": "Cinematic opening scene, atmospheric lighting, 8k"
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
// 1. OXION_API_KEY_1 -> 2. OXION_API_KEY_2 -> 3. GEMINI -> 4. GROQ
// =====================================================

async function callMasterAIWithFailover(prompt, env) {
  const allErrors = [];
  const oxionKeys = getOxionApiKeys(env);
  const geminiKeys = getGeminiApiKeys(env);

  for (let kIdx = 0; kIdx < oxionKeys.length; kIdx++) {
    const oxKey = oxionKeys[kIdx];
    const oxRes = await callOxionSingleKey(prompt, oxKey, env.OXION_BASE_URL, env.OXION_MODEL, kIdx + 1);
    if (oxRes.ok && oxRes.text) {
      return oxRes;
    }
    allErrors.push(...(oxRes.errors || []));
  }

  for (let gIdx = 0; gIdx < geminiKeys.length; gIdx++) {
    const gemKey = geminiKeys[gIdx];
    const gemRes = await callGeminiWithFallback(prompt, gemKey);
    if (gemRes.ok && gemRes.text) {
      return gemRes;
    }
    allErrors.push(...(gemRes.modelErrors || []));
  }

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
          temperature: 0.2,
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
    error: "AI Models (Oxion Key 1, Key 2 & Gemini) အားလုံး ချိတ်ဆက်၍ မရနိုင်သေးပါ။",
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
    : ["gemini-2.5-flash", "gemini-2.0-flash", "gpt-4o-mini"];

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
            temperature: 0.2,
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

          if ([401, 402, 403, 429].includes(status)) {
            return { ok: false, errors };
          }
          if (status === 404) break;
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
// GEMINI MULTIMODAL AUDIO TRANSCRIPTION (FOR MYANMAR SONGS)
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

async function transcribeAudioWithGemini(fileBlob, geminiKeys, langHint = "my") {
  try {
    const arrayBuf = await fileBlob.arrayBuffer();
    if (arrayBuf.byteLength > 19 * 1024 * 1024) {
      return { ok: false, error: "အသံဖိုင်ဆိုဒ် အရမ်းကြီးနေပါသည် (Max 19MB)။" };
    }

    const base64Audio = arrayBufferToBase64(arrayBuf);
    const mimeType = fileBlob.type && fileBlob.type.startsWith("audio/") ? fileBlob.type : "audio/wav";

    const prompt =
      langHint === "my"
        ? `
သင်သည် မြန်မာသီချင်းများကို နားထောင်ပြီး စာသားနှင့် အချိန် (Timestamps) အတိအကျ ထုတ်ပေးသော ပညာရှင် ဖြစ်သည်။
ဤအသံဖိုင်ထဲရှိ နောက်ခံတီးလုံးသံများ (Guitar, Drums, Music) ကို လုံးဝ လျစ်လျူရှုပြီး အဆိုတော် သီဆိုနေသော မြန်မာသီချင်းစာသား အစစ်အမှန်ကိုသာ နားထောင်၍ မြန်မာယူနီကုဒ်စာသားဖြင့် ထုတ်ပေးပါ။

အလွန်အရေးကြီးသော စည်းမျဉ်းများ:
1. အဆိုတော် စတင်သီဆိုသည့် စက္ကန့်အတိအကျကို "start" တွင်ထားပြီး စာကြောင်းဆုံးသည့် စက္ကန့်ကို "end" တွင် ထားပါ။ တီးလုံးသီးသန့် လာနေချိန်များကို မထည့်ရပါ။
2. စာကြောင်းတစ်ကြောင်းလျှင် ကာရာအိုကေ စာတန်းထိုးရန် သင့်တော်သော အရှည် (စက္ကန့် ၂.၅ မှ ၄.၅ စက္ကန့်စာခန့်) ပိုင်းဖြတ်ပေးပါ။
3. မည်သည့်အခါမှ "random gibberish", "random text", "အဓိပ္ပာယ်မရှိသော စာသား" သို့မဟုတ် အခြားဘာသာစကား အမှားများ လုံးဝ မထည့်ရပါ။ မြန်မာသီချင်းစာသား စစ်စစ်ကိုသာ ရေးပါ။
4. Output MUST be ONLY a valid JSON array in this exact format:
[
  { "id": 1, "start": 10.5, "end": 14.2, "text": "မြန်မာသီချင်းစာသား..." }
]
`
        : `
Listen carefully to the singing voice in this audio file (ignoring background instrumentals) and transcribe every sung lyric line with accurate start and end timestamps in seconds.
Output ONLY a valid JSON array:
[
  { "id": 1, "start": 10.5, "end": 14.2, "text": "Lyric line..." }
]
`;

    const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"];

    for (const apiKey of geminiKeys) {
      for (const model of models) {
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
            const rawText = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("").trim();
            const parsed = parseJsonArray(rawText);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const cleanSegments = parsed
                .map((s, idx) => ({
                  id: idx + 1,
                  start: Number(s.start) || 0,
                  end: Number(s.end) || Number(s.start) + 3.5,
                  text: String(s.text || s.orig || s.mm || "").replace(/\r?\n/g, " ").trim(),
                }))
                .filter((s) => s.text && !isGibberishOrPlaceholder(s.text) && s.end > s.start);

              if (cleanSegments.length > 0) {
                return {
                  ok: true,
                  language: langHint,
                  duration: cleanSegments[cleanSegments.length - 1].end,
                  segments: cleanSegments,
                };
              }
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
  const models = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
  ];

  const errors = [];

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
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
                temperature: 0.2,
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
            ?.map((p) => p?.text || "")
            .join("")
            .trim();

          if (rawText) {
            return { ok: true, model, text: rawText };
          }

          errors.push({ model, attempt, status: 200, message: "Empty Gemini response" });
        } else {
          const status = response.status;
          const message = data?.error?.message || `HTTP ${status}`;
          errors.push({ model, attempt, status, message });

          if (status === 404) break;

          const retryable = [429, 500, 502, 503, 504].includes(status);
          if (!retryable) break;

          if (attempt === 1) await sleep(500);
        }
      } catch (error) {
        errors.push({ model, attempt, status: 0, message: error?.message || "Network error" });
        if (attempt === 1) await sleep(500);
      }
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
      for (const k of ["lyrics", "translations", "story", "episodes", "scenes", "data", "recap", "segments"]) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
