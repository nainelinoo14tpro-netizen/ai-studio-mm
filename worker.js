/**
 * AI Studio All-in-One Master Backend Worker
 * (Fixed BigInt Precision for Edge TTS + Trilingual Song Karaoke & Multi-Endpoint Engine)
 */

// =====================================================
// CONFIG
// =====================================================

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const EDGE_TTS_BASE = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud";

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
  "Access-Control-Expose-Headers": "X-TTS-Voice",
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
// MAIN WORKER FETCH
// =====================================================

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders,
        });
      }

      const url = new URL(request.url);

      // Health Check
      if (url.pathname === "/" && request.method === "GET") {
        return json({
          ok: true,
          service: "ai-studio-backend-master",
          status: "online",
          groq_key_configured: !!env.GROQ_API_KEY,
          gemini_key_configured: !!env.GEMINI_API_KEY,
          hf_token_configured: !!env.HF_TOKEN,
          tts: {
            enabled: true,
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
      // 1. GROQ WHISPER TRANSCRIPTION
      // =================================================
      if (url.pathname === "/transcribe" && request.method === "POST") {
        if (!env.GROQ_API_KEY) {
          return json({ error: "GROQ_API_KEY မထည့်ရသေးပါ။ Cloudflare Secrets ကိုစစ်ပါ။" }, 500);
        }

        const incoming = await request.formData();
        const file = incoming.get("file");

        if (!file || typeof file === "string") {
          return json({ error: "Video သို့မဟုတ် Audio file မတွေ့ရှိပါ။" }, 400);
        }

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

        if (!response.ok) {
          return json(
            { error: data?.error?.message || data?.error || `Groq error HTTP ${response.status}` },
            response.status
          );
        }

        const segments = Array.isArray(data?.segments) ? data.segments : [];
        if (!segments.length) {
          return json({ error: "Whisper က Subtitle segments မပြန်ပေးပါ။", text: data?.text || "" }, 422);
        }

        const cleanSegments = segments
          .map((s, index) => ({
            id: index + 1,
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
            text: String(s.text || "").trim(),
          }))
          .filter((s) => s.text && s.end > s.start);

        return json({
          ok: true,
          language: data?.language || null,
          duration: Number(data?.duration) || null,
          text: data?.text || "",
          segments: cleanSegments,
        });
      }

      // =================================================
      // 2. GEMINI BATCH TRANSLATION (SUPPORTS MYANMAR & ENGLISH)
      // =================================================
      if (url.pathname === "/translate" && request.method === "POST") {
        if (!env.GEMINI_API_KEY) {
          return json({ error: "GEMINI_API_KEY မထည့်ရသေးပါ။ Cloudflare Secrets ကိုစစ်ပါ။" }, 500);
        }

        const body = await request.json().catch(() => ({}));
        const texts = body?.texts;
        const targetLang = body?.targetLang === "en" ? "English" : "natural spoken Myanmar Burmese";

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
You are a professional subtitle & song lyric translator.
Translate every line in the input array into ${targetLang}.

CRITICAL RULES:
- Even if a line contains 2 mixed languages (e.g., Thai + English, Hindi/Urdu + English, Korean + English, Chinese + English), translate the ENTIRE meaning completely into ${targetLang}.
- Never return the untranslated original foreign script when translating to Myanmar Burmese.
- Keep EXACTLY the same number of items (${batch.length} items).
- Keep EXACTLY the same order.
- Do NOT merge lines and do NOT split lines (keep each item on 1 single line without newline characters).
- Make the translation natural, poetic, and fitting for songs/movies.
- Output ONLY a valid JSON array of strings. No markdown, no explanation.

Input:
${JSON.stringify(batch)}
`;

          const result = await callGeminiWithFallback(prompt, env.GEMINI_API_KEY);
          if (!result.ok) {
            return json(
              { error: result.error, modelErrors: result.modelErrors || [] },
              result.status || 503
            );
          }

          const batchTranslations = parseJsonArray(result.text);
          if (!Array.isArray(batchTranslations)) {
            return json({ error: "Gemini translation JSON ဖတ်မရပါ။", raw: result.text }, 502);
          }

          const normalized = batch.map((orig, i) => {
            const tr = batchTranslations[i];
            if (typeof tr === "string" && tr.trim()) {
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
      // 2B. GEMINI SONG & KARAOKE TRILINGUAL TRANSLATOR (ORIG + EN + MM)
      // =================================================
      if (url.pathname === "/song" && request.method === "POST") {
        if (!env.GEMINI_API_KEY) {
          return json({ error: "GEMINI_API_KEY မထည့်ရသေးပါ။ Cloudflare Secrets ကိုစစ်ပါ။" }, 500);
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
သင်သည် ဘာသာစကားမျိုးစုံ ကျွမ်းကျင်သော သီချင်းစာသား (Song Lyrics & Karaoke) ဘာသာပြန်ပညာရှင် ဖြစ်သည်။

အောက်ပါ သီချင်းစာကြောင်း တစ်ကြောင်းချင်းစီကို စစ်ဆေးပြီး မူရင်းဘာသာစာသား (orig)၊ အင်္ဂလိပ်ဘာသာပြန် (en) နှင့် သီချင်းအဓိပ္ပာယ်နှင့် လိုက်ဖက်သော မြန်မာဘာသာပြန် (mm) တို့ကို ပြန်ထုတ်ပေးပါ။

အလွန်အရေးကြီးသော စည်းမျဉ်းများ:
1. သီချင်းစာကြောင်းထဲတွင် ဘာသာစကား (၂) မျိုး ရောနှောပါဝင်နေပါက (ဥပမာ - ထိုင်း + English၊ အူရဒူ/ဟိန္ဒီ + English၊ ကိုရီးယား + English၊ တရုတ် + English) ဘာသာစကား (၂) မျိုးစလုံး၏ အဓိပ္ပာယ်ကို အပြည့်အဝ ဘာသာပြန်ပေးရမည်။
2. "mm" အကွက်တွင် မူရင်းနိုင်ငံခြားစာသားအတိုင်း လုံးဝ ပြန်မထည့်ရပါ။ သီချင်းနှင့် လိုက်ဖက်ပြီး နားထောင်ကောင်းသော မြန်မာစာသားစစ်စစ်ဖြင့်သာ ရေးပေးရမည်။
3. "en" အကွက်တွင် အဓိပ္ပာယ်မှန်ကန်သော English စာသားသီးသန့် ရေးပေးရမည်။
4. စာကြောင်းအရေအတွက် (${inputPayload.length} ကြောင်း) နှင့် အစီအစဉ် (idx) အတိအကျ တူညီရမည်။ စာကြောင်းတစ်ကြောင်းကို (၁) ကြောင်းတည်းသာ ထားရမည် (\n မပါရ)။
5. Output MUST be ONLY a valid JSON array in this exact format:
[
  {
    "idx": 0,
    "orig": "မူရင်းစာသား",
    "en": "English lyric translation",
    "mm": "သီချင်းနှင့်လိုက်ဖက်သော မြန်မာဘာသာပြန်စာသား"
  }
]

Input Lyrics:
${JSON.stringify(inputPayload)}
`;

          const result = await callGeminiWithFallback(prompt, env.GEMINI_API_KEY);
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

            allLyrics.push({
              id: start + i + 1,
              start: Number(seg.start) || 0,
              end: Number(seg.end) || 0,
              orig: String(found.orig || origClean).replace(/\r?\n/g, " ").trim(),
              en: String(found.en || origClean).replace(/\r?\n/g, " ").trim(),
              mm: String(found.mm || origClean).replace(/\r?\n/g, " ").trim(),
            });
          }
        }

        return json({
          ok: true,
          lyrics: allLyrics,
        });
      }

      // =================================================
      // 3. GEMINI MOVIE RECAP (FULL TIMELINE COVERAGE)
      // =================================================
      if (url.pathname === "/recap" && request.method === "POST") {
        if (!env.GEMINI_API_KEY) {
          return json({ error: "GEMINI_API_KEY မထည့်ရသေးပါ။" }, 500);
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
2. အရေးကြီးဆုံးအချက်: Narration timestamps (start/end) များကို 0 စက္ကန့်မှ စတင်၍ ဗီဒီယိုအဆုံး ${Math.round(videoDuration)} စက္ကန့်အထိ ဗီဒီယိုတစ်ခုလုံး အစ၊ အလယ်၊ အဆုံး ညီညီညာညာ ဖြန့်ခွဲရေးပေးရမည်။ ဗီဒီယိုအလယ်ပိုင်းတွင် ဇာတ်ကြောင်းပြော ရပ်တန့်မသွားစေရ။
3. စာကြောင်းတစ်ခုလျှင် ဖတ်ရလွယ်စေရန် တိုတိုရှင်းရှင်း (စကားလုံး ၆ လုံး မှ ၁၀ လုံးခန့်သာ) ရေးပါ။
4. Output MUST be ONLY valid JSON array (No markdown, no backticks, no explanation):

Format:
[
  {
    "id": 1,
    "start": 0.0,
    "end": 4.5,
    "recap_mm": "ဇာတ်လမ်းစစချင်းမှာတော့..."
  }
]

SOURCE SEGMENTS (TIMELINE ACROSS VIDEO):
${JSON.stringify(sampledSegments)}
`;

        const result = await callGeminiWithFallback(prompt, env.GEMINI_API_KEY);
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
      // 4. GEMINI STORY GENERATOR (UPDATED: 8s-10s Scenes & 15 Scenes per Ep/2Mins)
      // =================================================
      if (url.pathname === "/story" && request.method === "POST") {
        if (!env.GEMINI_API_KEY) {
          return json({ error: "GEMINI_API_KEY မထည့်ရသေးပါ။" }, 500);
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
အောက်ပါ ခေါင်းစဉ်ကို အခြေခံ၍ စုစုပေါင်း ${epCount} ပိုင်း (Episode 1 မှ Episode ${epCount} အထိ) ပါဝင်သော ဇာတ်လမ်းတွဲ (Multi-Episode Series) ကို တစ်ပြိုင်နက် ရေးပေးပါ။

ခေါင်းစဉ်: "${topic}"
အမျိုးအစား: ${category}
အပိုင်း အရေအတွက်: စုစုပေါင်း ${epCount} ပိုင်း (Ep 1 to Ep ${epCount})
အပိုင်း ၁ ပိုင်း ကြာချိန်: အနည်းဆုံး ၂ မိနစ်စာ (တစ်ပိုင်းလျှင် အခန်း ၁၅ ခန်း အတိအကျ ပါဝင်ရမည်)

အလွန်အရေးကြီးသော စည်းမျဉ်းများ:
1. Episode တစ်ခုစီတွင် scene 1 မှ scene 15 အထိ အခန်းပေါင်း ၁၅ ခန်း အတိအကျ ရေးပေးရမည်။ (စုစုပေါင်း အခန်း = ${epCount * 15} ခန်း)။
2. အရေးကြီးဆုံးအချက်: Scene တစ်ခုစီ၏ မြန်မာစာသား (text_mm) ကို အသံထွက်ဖတ်ပါက ၈ စက္ကန့် မှ ၁၀ စက္ကန့် (8 to 10 seconds) ကြာမြင့်စေရန် စကားလုံးရေ ၃၅ လုံးမှ ၄၅ လုံးခန့် အပြည့်အစုံ ရေးပေးရမည်။ စာကြောင်း တိုတိုလေး မရေးရပါ။
3. အပိုင်းတစ်ခုစီ၏ နောက်ဆုံးအခန်း (Scene 15) တိုင်းတွင် နောက်တစ်ပိုင်းကို မဖြစ်မနေ ဆက်ကြည့်ချင်လာအောင် အသည်းယားစရာ၊ ရင်ခုန်စရာ အချိတ်အဆက် (Intense Cliffhanger Hook) ဖြင့် အဆုံးသတ်ပေးရမည်။
4. နောက်ဆုံး Episode ${epCount} ၏ Scene 15 တွင်သာ ဇာတ်သိမ်းအပြီးသတ် ပေးရမည်။
5. မြန်မာစကားပြော (text_mm) ကို နားထောင်ကောင်းပြီး ဆွဲဆောင်မှုရှိသော သဘာဝကျသည့် မြန်မာစကားပြောစစ်စစ်ဖြင့် ရေးပါ။
6. ရုပ်ပုံဆွဲရန် အင်္ဂလိပ် Prompt (image_prompt_en) ကို Cinematic, Highly detailed visual အဖြစ် ရေးပါ။
7. Output MUST be ONLY valid JSON array (No markdown, no explanation):

[
  {
    "episode": 1,
    "scene": 1,
    "text_mm": "ညဉ့်နက်သန်းခေါင်ယံ တောနက်ကြီးတစ်ခုအတွင်းမှာ လေပြင်းတွေ တဝူးဝူးတိုက်ခတ်နေပြီး သစ်ရွက်ခြောက်တွေ ကြွေကျနေခဲ့ပါတယ်။ ပတ်ဝန်းကျင်တစ်ခုလုံး မြူနှင်းတွေဖုံးလွှမ်းနေပြီး အလွန်အေးစက်တိတ်ဆိတ်နေတဲ့အချိန်ပေါ့။",
    "image_prompt_en": "Dark foggy mysterious forest at midnight, cinematic atmospheric lighting, 8k"
  },
  {
    "episode": 1,
    "scene": 15,
    "text_mm": "အိမ်ကြီးရဲ့ သစ်သားတံခါးကြီး ဖြည်းဖြည်းချင်းပွင့်သွားပြီး အမှောင်ထုထဲကနေ ကြောက်မက်ဖွယ်မျက်လုံးနီနီကြီးတွေ ပေါ်ထွက်လာချိန်မှာတော့... (အပိုင်း ၂ တွင် ဆက်လက်စောင့်မျှော်ကြည့်ရှုပါ)",
    "image_prompt_en": "Terrifying glowing red eyes emerging from dark wooden doorway, extreme dramatic cliffhanger shot, 8k"
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
Format: Complete Single Story
Duration: ${numDur} Minutes
Scenes: Exactly ${sceneCount} scenes.

Important Rules:
1. Scene Duration: Each scene's narration (text_mm) MUST be 35 to 45 Burmese words long so that it takes between 8 to 10 seconds to speak out loud. DO NOT write short sentences.
2. text_mm MUST be natural spoken Myanmar Burmese.
3. image_prompt_en MUST be English and highly cinematic.
4. Output ONLY valid JSON array (No markdown, no explanation):
[
  {
    "episode": 1,
    "scene": 1,
    "text_mm": "ညဉ့်နက်သန်းခေါင်ယံ တောနက်ကြီးတစ်ခုအတွင်းမှာ လေပြင်းတွေ တဝူးဝူးတိုက်ခတ်နေပြီး သစ်ရွက်ခြောက်တွေ ကြွေကျနေခဲ့ပါတယ်။ ပတ်ဝန်းကျင်တစ်ခုလုံး မြူနှင်းတွေဖုံးလွှမ်းနေပြီး အလွန်အေးစက်တိတ်ဆိတ်နေတဲ့အချိန်ပေါ့။",
    "image_prompt_en": "Cinematic opening scene, atmospheric lighting, 8k"
  }
]
`;
        }

        const result = await callGeminiWithFallback(prompt, env.GEMINI_API_KEY);
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
      // 5. MYANMAR EDGE TTS (ORIGINAL VERIFIED ENGINE)
      // =================================================
      if (url.pathname === "/tts" && request.method === "POST") {
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

        // LAYER 1: Cloudflare Native SDXL Lightning
        if ((engine === "auto" || engine === "cf") && env.AI) {
          try {
            const cfResp = await env.AI.run(
              "@cf/bytedance/stable-diffusion-xl-lightning",
              { prompt: cleanPrompt, num_steps: 4 }
            );
            if (cfResp) {
              buffer = await new Response(cfResp).arrayBuffer();
            }
          } catch (e) {
            console.warn("Cloudflare Workers AI failed or quota reached:", e.message);
          }
        }

        // LAYER 2: Hugging Face Router API
        if (!buffer && (engine === "auto" || engine === "hf")) {
          const hfToken = env.HF_TOKEN || "";
          if (hfToken) {
            try {
              const hfResp = await fetch(
                "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell",
                {
                  method: "POST",
                  headers: {
                    "Authorization": `Bearer ${hfToken}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ inputs: cleanPrompt }),
                }
              );
              if (hfResp.ok) {
                buffer = await hfResp.arrayBuffer();
              }
            } catch (e) {
              console.warn("Hugging Face API failed:", e.message);
            }
          }
        }

        // LAYER 3: Stable Fallback Proxy
        if (!buffer && engine === "auto") {
          try {
            const seed = Math.floor(Math.random() * 899999) + 100000;
            const fallbackUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt.slice(0, 180))}?width=1024&height=576&nologo=true&seed=${seed}`;
            const fbResp = await fetch(fallbackUrl, {
              headers: { "User-Agent": "Mozilla/5.0", "Accept": "image/*" }
            });
            if (fbResp.ok) {
              const tempBuf = await fbResp.arrayBuffer();
              if (tempBuf.byteLength > 1000) buffer = tempBuf;
            }
          } catch(e) {}
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

        return json({ error: "Worker engines exhausted. Switch to Client-side mode.", code: "FALLBACK_TO_CLIENT" }, 429);
      }

      // =================================================
      // 7. ZEROGPU BURMESE VOICE CLONE (GRADIO TUPLE RETURN RESOLVED)
      // =================================================
      if (url.pathname === "/clone-tts" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        const style = body?.style || "News anchor, formal";
        const hfToken = env.HF_TOKEN || "";

        if (!text) {
          return json({ error: "Text လိုအပ်ပါသည်။" }, 400);
        }

        const hfHeaders = {
          "Content-Type": "application/json",
        };
        if (hfToken) {
          hfHeaders["Authorization"] = `Bearer ${hfToken}`;
        }

        const hfCallResp = await fetch("https://nlopro-clone-burmese-tts.hf.space/gradio_api/call/prompt_voice", {
          method: "POST",
          headers: hfHeaders,
          body: JSON.stringify({
            data: [text, style]
          })
        });

        if (!hfCallResp.ok) {
          const errText = await hfCallResp.text().catch(() => "");
          return json({ error: `ZeroGPU Queue Error HTTP ${hfCallResp.status}: ${errText || hfCallResp.statusText}` }, hfCallResp.status);
        }

        const callData = await hfCallResp.json().catch(() => ({}));
        const eventId = callData?.event_id;

        if (!eventId) {
          return json({ error: "ZeroGPU ထံမှ event_id မရရှိပါ" }, 502);
        }

        const sseResp = await fetch(`https://nlopro-clone-burmese-tts.hf.space/gradio_api/call/prompt_voice/${eventId}`, {
          headers: hfHeaders
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
                  if (audioObj.url) {
                    resultAudioUrl = audioObj.url;
                  } else if (audioObj.path) {
                    resultAudioUrl = `https://nlopro-clone-burmese-tts.hf.space/gradio_api/file=${audioObj.path}`;
                  }
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
          return json({ 
            error: "ZeroGPU Audio data ထုတ်ယူမရရှိပါ", 
            raw: sseText.slice(0, 350) 
          }, 500);
        }

        return json({
          ok: true,
          url: resultAudioUrl
        });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (error) {
      console.error("Worker error:", error);
      return json({ ok: false, error: error?.message || "Internal Worker error." }, 500);
    }
  },
};

// =====================================================
// GEMINI MULTI-MODEL FALLBACK ENGINE
// =====================================================

async function callGeminiWithFallback(prompt, apiKey) {
  const models = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.8-flash",
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

          if (attempt === 1) await sleep(600);
        }
      } catch (error) {
        errors.push({ model, attempt, status: 0, message: error?.message || "Network error" });
        if (attempt === 1) await sleep(600);
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
// SEC-MS-GEC TOKEN (FIXED BIGINT PRECISION)
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

// =====================================================
// EDGE TTS (FIXED MUID COOKIE & HANDSHAKE)
// =====================================================

async function generateEdgeSpeech(text, voice, rate, pitch, volume) {
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
    const body = await response.text().catch(() => "");
    throw new Error(
      `Myanmar TTS WebSocket handshake မအောင်မြင်ပါ (HTTP ${response.status}): ${body || "No WebSocket"}`
    );
  }

  ws.accept();

  const requestId = crypto.randomUUID().replace(/-/g, "");
  const timestamp = getEdgeTimestamp();
  const safeText = escapeXml(removeBadCharacters(text));

  const ssml =
    `<speak version="1.0" ` +
    `xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="http://www.w3.org/2001/mstts" ` +
    `xml:lang="my-MM">` +
    `<voice name="${voice}">` +
    `<prosody rate="${rate}" pitch="${pitch}" volume="${volume}">` +
    `${safeText}` +
    `</prosody>` +
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
      reject(new Error("Myanmar TTS အချိန်ကျော်သွားပါသည်။"));
    }, 20000);

    const finish = (error = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}

      if (error) {
        reject(error);
        return;
      }

      if (!receivedAudio) {
        reject(new Error("Myanmar TTS မှ audio data မရရှိပါ။"));
        return;
      }

      try {
        resolve(concatAudioChunks(audioChunks));
      } catch (err) {
        reject(err);
      }
    };

    const handleStringMessage = (message) => {
      const { headers, body } = parseEdgeTextMessage(message);
      const path = headers.Path;

      if (path === "turn.end") {
        finish();
        return;
      }

      if (path === "response" || path === "turn.start" || path === "audio.metadata") {
        return;
      }

      if (path === "error") {
        finish(new Error(body || "Edge TTS server error"));
      }
    };

    const handleBinary = (buffer) => {
      try {
        if (!buffer || buffer.byteLength < 2) return;
        const view = new DataView(buffer);
        const headerLength = view.getUint16(0, false);
        const dataStart = headerLength + 2;

        if (buffer.byteLength <= dataStart) return;

        const headerBytes = buffer.slice(2, dataStart);
        const headerText = new TextDecoder().decode(headerBytes);
        const headers = parseEdgeHeaders(headerText);

        if (headers.Path !== "audio") return;

        const audio = buffer.slice(dataStart);
        if (audio.byteLength > 0) {
          receivedAudio = true;
          audioChunks.push(audio);
        }
      } catch (error) {
        finish(new Error("Edge TTS audio packet ဖတ်မရပါ: " + error.message));
      }
    };

    ws.addEventListener("message", async (event) => {
      try {
        const data = event.data;
        if (typeof data === "string") {
          handleStringMessage(data);
          return;
        }
        if (data instanceof ArrayBuffer) {
          handleBinary(data);
          return;
        }
        if (typeof Blob !== "undefined" && data instanceof Blob) {
          const buffer = await data.arrayBuffer();
          handleBinary(buffer);
        }
      } catch (error) {
        finish(error);
      }
    });

    ws.addEventListener("error", () => {
      finish(new Error("Myanmar TTS WebSocket error ဖြစ်နေပါသည်။"));
    });

    ws.addEventListener("close", () => {
      if (finished) return;
      if (receivedAudio) {
        finish();
      } else {
        finish(new Error("Myanmar TTS audio မရရှိဘဲ connection ပိတ်သွားပါသည်။"));
      }
    });

    ws.send(
      `X-Timestamp:${timestamp}\r\n` +
      `Content-Type:application/json; charset=utf-8\r\n` +
      `Path:speech.config\r\n\r\n` +
      JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: "false",
                wordBoundaryEnabled: "false",
              },
              outputFormat: "audio-24khz-48kbitrate-mono-mp3",
            },
          },
        },
      })
    );

    ws.send(
      `X-RequestId:${requestId}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${timestamp}\r\n` +
      `Path:ssml\r\n\r\n` +
      ssml
    );
  });
}

// =====================================================
// UTILITIES
// =====================================================

function normalizeMyanmarVoice(voice) {
  if (voice === MYANMAR_VOICES.female) {
    return MYANMAR_VOICES.female;
  }
  return MYANMAR_VOICES.male;
}

function normalizeSpeechRate(rate) {
  if (typeof rate !== "string") return "+0%";
  if (/^[+-]\d{1,3}%$/.test(rate)) return rate;
  return "+0%";
}

function normalizeSpeechPitch(pitch) {
  if (typeof pitch !== "string") return "+0Hz";
  if (/^[+-]\d{1,3}Hz$/.test(pitch)) return pitch;
  return "+0Hz";
}

function normalizeSpeechVolume(volume) {
  if (typeof volume !== "string") return "+0%";
  if (/^[+-]\d{1,3}%$/.test(volume)) return volume;
  return "+0%";
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
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error("Audio chunks မရှိပါ။");
  }
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
      for (const k of ["lyrics", "translations", "story", "episodes", "scenes", "data"]) {
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

  const objStart = clean.indexOf("{");
  const objEnd = clean.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    try {
      const parsed = JSON.parse(clean.slice(objStart, objEnd + 1));
      for (const k of ["lyrics", "translations", "story", "episodes", "scenes", "data"]) {
        if (Array.isArray(parsed[k])) return parsed[k];
      }
      for (const k in parsed) {
        if (Array.isArray(parsed[k])) return parsed[k];
      }
    } catch {}
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
