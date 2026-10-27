import os
import re
import json
import base64
import tempfile
import urllib.parse
import aiohttp
import edge_tts
from typing import Optional, List, Any
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI()

# Frontend များမှ လွတ်လပ်စွာ လှမ်းခေါ်နိုင်ရန် CORS ဖွင့်ခြင်း
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =====================================================
# REQUEST MODELS
# =====================================================

class TTSRequest(BaseModel):
    text: str
    voice: str = "my-MM-NilarNeural"
    rate: str = "+0%"
    pitch: str = "+0Hz"

class TranslateRequest(BaseModel):
    texts: List[str] = []
    targetLang: str = "my"
    concise: bool = True

class SongSegmentItem(BaseModel):
    start: float = 0.0
    end: float = 3.0
    text: Optional[str] = ""
    orig: Optional[str] = ""

class SongRequest(BaseModel):
    segments: List[SongSegmentItem] = []
    conciseMM: bool = True

class LyricsLookupRequest(BaseModel):
    song_title: str
    lang: str = "my"

class StoryRequest(BaseModel):
    topic: str
    duration: Any = 1
    type: str = "single"
    category: str = "horror"
    episodes: int = 2

class RecapRequest(BaseModel):
    segments: List[Any] = []
    tone: str = "narrator"
    duration: Optional[float] = 60.0

# =====================================================
# CONFIG & API KEY HELPERS
# =====================================================

GEMINI_MODELS = [
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
]

def get_oxion_keys() -> List[str]:
    raw = [
        os.getenv("OXION_API_KEY_1", ""),
        os.getenv("OXION_API_KEY_2", ""),
        os.getenv("OXION_API_KEY", ""),
    ]
    keys = []
    for item in raw:
        for part in item.split(","):
            k = part.strip()
            if k and k not in keys:
                keys.append(k)
    return keys

def get_gemini_keys() -> List[str]:
    raw = [
        os.getenv("GEMINI_API_KEY", ""),
        os.getenv("GEMINI_API_KEY_1", ""),
        os.getenv("GEMINI_API_KEY_2", ""),
    ]
    keys = []
    for item in raw:
        for part in item.split(","):
            k = part.strip()
            if k and k not in keys:
                keys.append(k)
    return keys

def get_groq_key() -> str:
    return os.getenv("GROQ_API_KEY", "").strip()

def clean_song_title_from_filename(raw_name: str) -> str:
    if not raw_name:
        return ""
    s = re.sub(r"\.[a-zA-Z0-9]{2,4}$", "", str(raw_name).strip())
    s = re.sub(
        r"(?i)\b(official\s*mv|official\s*video|music\s*video|lyric\s*video|lyrics|audio|karaoke|hd|fhd|4k|1080p|720p|mp4|mp3|vocals?|mv)\b",
        " ",
        s,
    )
    s = re.sub(r"[\[\(\{]\s*[\]\)\}]", " ", s)
    s = re.sub(r"[_]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip(" -_.")
    return s

def is_gibberish_text(text: str) -> bool:
    s = str(text or "").strip()
    if not s:
        return True
    if re.search(r"random\s+gibberish|random\s+text|အဓိပ္ပာယ်မရှိသော\s*စာသား|prooh", s, re.I):
        return True
    if re.search(r"[\u10A0-\u10FF\u0530-\u058F\u0590-\u05FF]", s):
        return True
    return False

def has_myanmar_script(text: str) -> bool:
    return bool(re.search(r"[\u1000-\u109F]", str(text or "")))

async def server_side_translate_gtx(text: str, target_lang: str = "my") -> str:
    clean = str(text or "").strip()
    if not clean:
        return ""
    try:
        q = urllib.parse.quote(clean)
        url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={target_lang}&dt=t&q={q}"
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers={"User-Agent": "Mozilla/5.0"}) as resp:
                if resp.status == 200:
                    data = await resp.json(content_type=None)
                    if isinstance(data, list) and len(data) > 0 and isinstance(data[0], list):
                        return "".join(str(item[0] or "") for item in data[0] if isinstance(item, list) and len(item) > 0).strip()
    except Exception:
        pass
    return clean

def parse_json_array(raw_text: str) -> Optional[List[Any]]:
    if not raw_text:
        return None
    clean = raw_text.strip()
    if clean.startswith("```json"):
        clean = clean[7:]
    elif clean.startswith("```"):
        clean = clean[3:]
    if clean.endswith("```"):
        clean = clean[:-3]
    clean = clean.strip()

    try:
        parsed = json.loads(clean)
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict):
            for k in ["lyrics", "translations", "segments", "lines", "story", "recap", "data", "episodes", "scenes"]:
                if isinstance(parsed.get(k), list):
                    return parsed[k]
            for v in parsed.values():
                if isinstance(v, list):
                    return v
    except Exception:
        pass

    start = clean.find("[")
    end = clean.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(clean[start : end + 1])
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass
    return None

# =====================================================
# PURE BINARY MULTIPART PARSER (NO EXTRA PIP DEPENDENCY)
# =====================================================

async def parse_incoming_form(request: Request) -> dict:
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            return await request.json()
        except Exception:
            return {}

    body = await request.body()
    if not body:
        return {}

    boundary_match = re.search(r"boundary=([^;\s]+)", content_type)
    if not boundary_match:
        return {}

    boundary_str = boundary_match.group(1).strip('"')
    boundary_bytes = ("--" + boundary_str).encode("utf-8")
    parts = body.split(boundary_bytes)

    result = {}
    for part in parts:
        if not part or part in (b"--\r\n", b"--", b"\r\n"):
            continue
        if part.startswith(b"\r\n"):
            part = part[2:]
        if part.endswith(b"\r\n"):
            part = part[:-2]
        if part.endswith(b"--"):
            part = part[:-2]

        sep_idx = part.find(b"\r\n\r\n")
        if sep_idx == -1:
            continue

        header_block = part[:sep_idx].decode("utf-8", errors="replace")
        content_bytes = part[sep_idx + 4 :]
        if content_bytes.endswith(b"\r\n"):
            content_bytes = content_bytes[:-2]

        name_m = re.search(r'name="([^"]+)"', header_block)
        if not name_m:
            continue
        field_name = name_m.group(1)
        file_m = re.search(r'filename="([^"]*)"', header_block)
        ct_m = re.search(r"Content-Type:\s*([^\r\n;]+)", header_block, re.I)

        if file_m:
            result[field_name] = {
                "filename": file_m.group(1) or "audio.wav",
                "content_type": ct_m.group(1).strip() if ct_m else "audio/wav",
                "bytes": content_bytes,
            }
        else:
            result[field_name] = content_bytes.decode("utf-8", errors="replace").strip()

    return result

# =====================================================
# MASTER AI ROUTER (GEMINI-3.8-FLASH + OXION 1 & 2 + GROQ)
# =====================================================

async def call_master_ai(prompt: str, max_timeout: int = 45) -> dict:
    oxion_keys = get_oxion_keys()
    gemini_keys = get_gemini_keys()
    groq_key = get_groq_key()
    errors = []

    timeout = aiohttp.ClientTimeout(total=max_timeout)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        # 1. Try Gemini Direct Keys First (gemini-3.8-flash -> gemini-3.5-flash-lite -> gemini-3.6-flash)
        for g_key in gemini_keys:
            for model in GEMINI_MODELS:
                try:
                    url = f"[https://generativelanguage.googleapis.com/v1beta/models/](https://generativelanguage.googleapis.com/v1beta/models/){model}:generateContent"
                    async with session.post(
                        url,
                        headers={
                            "Content-Type": "application/json",
                            "x-goog-api-key": g_key,
                        },
                        json={
                            "contents": [{"parts": [{"text": prompt}]}],
                            "generationConfig": {
                                "responseMimeType": "application/json",
                                "temperature": 0.25,
                            },
                        },
                    ) as resp:
                        if resp.status == 200:
                            data = await resp.json(content_type=None)
                            parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                            text = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
                            if text:
                                return {"ok": True, "provider": model, "text": text}
                        else:
                            errors.append(f"{model}:{resp.status}")
                            continue
                except Exception as e:
                    errors.append(f"{model}:{str(e)}")
                    continue

        # 2. Try Oxion AI Keys (Key 1 -> Key 2)
        oxion_endpoints = [
            "[https://api.oxionai.com/v1/chat/completions](https://api.oxionai.com/v1/chat/completions)",
            "[https://oxionai.com/api/v1/chat/completions](https://oxionai.com/api/v1/chat/completions)",
        ]
        oxion_models = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gpt-4o-mini"]

        for idx, ox_key in enumerate(oxion_keys):
            for ep in oxion_endpoints:
                for model in oxion_models:
                    try:
                        async with session.post(
                            ep,
                            headers={
                                "Content-Type": "application/json",
                                "Authorization": f"Bearer {ox_key}",
                                "x-api-key": ox_key,
                            },
                            json={
                                "model": model,
                                "messages": [
                                    {"role": "system", "content": "Output ONLY valid JSON without markdown."},
                                    {"role": "user", "content": prompt},
                                ],
                                "temperature": 0.25,
                            },
                        ) as resp:
                            if resp.status == 200:
                                data = await resp.json(content_type=None)
                                text = (
                                    data.get("choices", [{}])[0].get("message", {}).get("content", "")
                                    or data.get("text", "")
                                ).strip()
                                if text:
                                    return {"ok": True, "provider": f"oxion-key-{idx+1}", "text": text}
                            else:
                                errors.append(f"oxion-{idx+1}-{model}:{resp.status}")
                                if resp.status in (401, 402, 403):
                                    break
                    except Exception as e:
                        errors.append(f"oxion-{idx+1}:{str(e)}")
                        break

        # 3. Fallback to Groq Llama-3.3-70b
        if groq_key:
            try:
                async with session.post(
                    "[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)",
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {groq_key}",
                    },
                    json={
                        "model": "llama-3.3-70b-versatile",
                        "messages": [
                            {"role": "system", "content": "Output valid JSON only."},
                            {"role": "user", "content": prompt},
                        ],
                        "temperature": 0.25,
                    },
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json(content_type=None)
                        text = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
                        if text:
                            return {"ok": True, "provider": "groq-llama", "text": text}
            except Exception as e:
                errors.append(f"groq:{str(e)}")

    return {"ok": False, "error": "AI Models အားလုံး ချိတ်ဆက်မရပါ: " + ", ".join(errors[:6])}

# =====================================================
# GEMINI MULTIMODAL AUDIO ENGINE (FAST CHUNK & FULL AUDIO)
# =====================================================

async def transcribe_or_align_audio_gemini(
    audio_bytes: bytes,
    mime_type: str,
    lang: str = "my",
    song_title: str = "",
    reference_lyrics: str = "",
    time_offset: float = 0.0,
) -> dict:
    gemini_keys = get_gemini_keys()
    if not gemini_keys:
        return {"ok": False, "error": "Render Server တွင် GEMINI_API_KEY မထည့်ရသေးပါ။"}

    b64_audio = base64.b64encode(audio_bytes).decode("ascii")
    if not mime_type or not mime_type.startswith("audio/"):
        mime_type = "audio/wav"

    clean_title = clean_song_title_from_filename(song_title)
    title_context = f'သီချင်းအမည်/အဆိုတော်: "{clean_title}"\n' if clean_title else ""
    lyrics_context = (
        f"အောက်ပါ မူရင်းသီချင်းစာသားအမှန်ထဲမှ ဤအသံပိုင်းတွင် သီဆိုနေသော စာကြောင်းများကို အသံချိန် (start နှင့် end စက္ကန့်) အတိအကျဖြင့် ချိန်ညှိပေးပါ:\n{reference_lyrics}\n"
        if reference_lyrics
        else ""
    )

    if lang == "my":
        prompt = f"""
သင်သည် မြန်မာသီချင်း ကာရာအိုကေ စာတန်းထိုးနှင့် အသံအချိန်ညှိပညာရှင် ဖြစ်သည်။
{title_context}{lyrics_context}
ဤအသံဖိုင်ထဲရှိ နောက်ခံတီးလုံးသံများ (Guitar, Drums, Intro/Outro Music) ကို ကျော်ပြီး အဆိုတော် သီဆိုနေသော မြန်မာသီချင်းစာသားများကို နားထောင်ကာ စာကြောင်းတစ်ကြောင်းချင်းစီ၏ စချိန် (start) နှင့် ဆုံးချိန် (end) စက္ကန့်များကို အတိအကျ ထုတ်ပေးပါ။
အကယ်၍ ဤအသံပိုင်းတွင် လူဆိုသံ လုံးဝမပါဘဲ တီးလုံးသက်သက်သာ ဖြစ်နေပါက [] (Empty array) သာ ပြန်ပေးပါ။

စည်းမျဉ်းများ:
1. အဆိုတော် စဆိုသည့် စက္ကန့်အတိအကျကို "start" တွင်ထားပြီး စာကြောင်းဆုံးသည့် စက္ကန့်ကို "end" တွင် ထားပါ (ဤအသံဖိုင်၏ 0.0 စက္ကန့်မှ စတင်တွက်ချက်ပါ)။
2. စာကြောင်းတစ်ကြောင်းလျှင် စက္ကန့် ၂.၅ မှ ၄.၅ စက္ကန့်စာခန့် ပိုင်းဖြတ်ပေးပါ။
3. Output MUST be ONLY a valid JSON array:
[
  {{ "id": 1, "start": 2.0, "end": 5.8, "text": "မြန်မာသီချင်းစာသား..." }}
]
"""
    else:
        prompt = f"""
Listen carefully to the singing voice in this song audio clip and transcribe/align every sung lyric line with accurate start and end timestamps in seconds relative to the start of this clip (0.0s).
{title_context}{lyrics_context}
If there are no vocals in this clip, output [].
Output ONLY a valid JSON array:
[
  {{ "id": 1, "start": 2.5, "end": 6.2, "text": "Original sung lyric line..." }}
]
"""

    timeout = aiohttp.ClientTimeout(total=120)
    errors = []

    async with aiohttp.ClientSession(timeout=timeout) as session:
        for api_key in gemini_keys:
            for model in GEMINI_MODELS:
                try:
                    url = f"[https://generativelanguage.googleapis.com/v1beta/models/](https://generativelanguage.googleapis.com/v1beta/models/){model}:generateContent"
                    payload = {
                        "contents": [
                            {
                                "parts": [
                                    {"inlineData": {"mimeType": mime_type, "data": b64_audio}},
                                    {"text": prompt},
                                ]
                            }
                        ],
                        "generationConfig": {
                            "responseMimeType": "application/json",
                            "temperature": 0.1,
                        },
                    }
                    async with session.post(
                        url,
                        headers={
                            "Content-Type": "application/json",
                            "x-goog-api-key": api_key,
                        },
                        json=payload,
                    ) as resp:
                        if resp.status == 200:
                            data = await resp.json(content_type=None)
                            parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                            raw_text = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
                            parsed = parse_json_array(raw_text)
                            if isinstance(parsed, list):
                                clean_segments = []
                                for item in parsed:
                                    if not isinstance(item, dict):
                                        continue
                                    txt = str(item.get("text") or item.get("mm") or item.get("orig") or "").replace("\n", " ").strip()
                                    st = float(item.get("start") or 0.0) + time_offset
                                    en = float(item.get("end") or ( float(item.get("start") or 0.0) + 3.5 )) + time_offset
                                    if txt and not is_gibberish_text(txt) and en > st:
                                        clean_segments.append({
                                            "id": len(clean_segments) + 1,
                                            "start": round(st, 2),
                                            "end": round(en, 2),
                                            "text": txt,
                                        })
                                return {
                                    "ok": True,
                                    "engine": f"render-{model}",
                                    "language": lang,
                                    "duration": clean_segments[-1]["end"] if clean_segments else time_offset,
                                    "segments": clean_segments,
                                }
                        else:
                            errors.append(f"{model}:{resp.status}")
                            continue
                except Exception as e:
                    errors.append(f"{model}:{str(e)}")
                    continue

    return {"ok": False, "error": "Gemini Audio နားထောင်မှု မအောင်မြင်ပါ (" + ", ".join(errors[:4]) + ")"}

# =====================================================
# ORIGINAL ROUTES: HEALTH & EDGE TTS
# =====================================================

@app.get("/")
async def root():
    return {
        "ok": True,
        "service": "burmese-edge-tts-python",
        "status": "online",
        "primary_gemini_model": GEMINI_MODELS[0],
        "oxion_keys": len(get_oxion_keys()),
        "gemini_keys": len(get_gemini_keys()),
        "groq_configured": bool(get_groq_key()),
    }

@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "status": "online",
        "primary_gemini_model": GEMINI_MODELS[0],
        "oxion_keys": len(get_oxion_keys()),
        "gemini_keys": len(get_gemini_keys()),
        "groq_configured": bool(get_groq_key()),
    }

# မူရင်း Endpoint (၂) ခုလုံးအပြင် /tts ဖြင့်ပါ လက်ခံနိုင်ရန် လမ်းကြောင်းပေးထားခြင်း
@app.post("/api/synthesize")
@app.post("/api/tts")
@app.post("/tts")
async def synthesize_speech(req: TTSRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")

    output_path = tempfile.mktemp(suffix=".mp3")

    try:
        communicate = edge_tts.Communicate(
            text=req.text.strip(),
            voice=req.voice,
            rate=req.rate,
            pitch=req.pitch
        )
        await communicate.save(output_path)
        return FileResponse(output_path, media_type="audio/mpeg", filename="myanmar-tts.mp3")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# =====================================================
# ROUTE 1: FETCH LYRICS BY SONG TITLE OR VIDEO FILENAME
# =====================================================

@app.post("/api/fetch-lyrics")
async def fetch_lyrics_by_title(req: LyricsLookupRequest):
    cleaned_title = clean_song_title_from_filename(req.song_title)
    if not cleaned_title:
        raise HTTPException(status_code=400, detail="သီချင်းအမည် ရိုက်ထည့်ပေးပါ။")

    prompt = f"""
သင်သည် မြန်မာသီချင်းနှင့် နိုင်ငံတကာသီချင်းစာသားများကို အတိအကျ သိရှိသော သီချင်းစာသားဘဏ် (Lyrics Database) ဖြစ်သည်။
ရှာဖွေလိုသော သီချင်းအမည် / ဖိုင်အမည်: "{cleaned_title}"

အထက်ပါ သီချင်း၏ စာသားအပြည့်အစုံကို ကာရာအိုကေ စာတန်းထိုးရန်အတွက် တစ်ကြောင်းချင်းစီ အစဉ်လိုက် ထုတ်ပေးပါ။
Output MUST be ONLY a valid JSON array of strings:
[
  "ပထမ စာကြောင်း...",
  "ဒုတိယ စာကြောင်း..."
]
"""
    res = await call_master_ai(prompt, max_timeout=25)
    if not res.get("ok"):
        raise HTTPException(status_code=503, detail=res.get("error", "Lyrics ရှာမတွေ့ပါ"))

    lines = parse_json_array(res.get("text", ""))
    if not isinstance(lines, list) or not lines:
        raise HTTPException(status_code=422, detail="သီချင်းစာသား ဖတ်မရပါ။")

    clean_lines = [str(l).strip() for l in lines if str(l).strip() and not is_gibberish_text(str(l))]
    return {
        "ok": True,
        "song_title": cleaned_title,
        "lyrics_text": "\n".join(clean_lines),
        "lines": clean_lines,
    }

# =====================================================
# ROUTE 2: FAST AUDIO TRANSCRIBE & KARAOKE ALIGNMENT
# =====================================================

@app.post("/transcribe")
@app.post("/api/karaoke")
async def transcribe_and_align_karaoke(request: Request):
    form = await parse_incoming_form(request)

    file_obj = form.get("file")
    audio_bytes = b""
    mime_type = "audio/wav"
    filename = "audio.wav"

    if isinstance(file_obj, dict):
        audio_bytes = file_obj.get("bytes", b"")
        mime_type = file_obj.get("content_type", "audio/wav")
        filename = file_obj.get("filename", "audio.wav")
    elif isinstance(form.get("audio_base64"), str) and form.get("audio_base64"):
        audio_bytes = base64.b64decode(form["audio_base64"])
        mime_type = form.get("mime_type", "audio/wav")
        filename = str(form.get("filename") or "audio.wav")

    if not audio_bytes:
        return JSONResponse({"error": "Audio file မတွေ့ရှိပါ။"}, status_code=400)

    lang = str(form.get("lang") or "my").lower()
    mode = str(form.get("mode") or "").lower()
    time_offset = max(0.0, float(form.get("time_offset") or 0.0))

    raw_song_title = str(form.get("song_title") or filename or "").strip()
    song_title = clean_song_title_from_filename(raw_song_title)
    if re.match(r"^(vocal_isolated|chunk_\d+|audio|video|vid_\d+|lv_\d+|capcut.*|inshot.*|\d+)$", song_title, re.I):
        song_title = ""

    custom_lyrics = str(form.get("lyrics") or "").strip()
    is_myanmar = lang in ("my", "myanmar") or mode == "myanmar_gemini_only"

    # MYANMAR SONG MODE -> Direct Single-Pass Gemini Multimodal Audio (No extra blocking lookups!)
    if is_myanmar:
        gem_res = await transcribe_or_align_audio_gemini(
            audio_bytes=audio_bytes,
            mime_type=mime_type,
            lang="my",
            song_title=song_title,
            reference_lyrics=custom_lyrics,
            time_offset=time_offset,
        )
        if gem_res.get("ok"):
            segs = gem_res.get("segments", [])
            return JSONResponse({
                "ok": True,
                "engine": gem_res.get("engine", "render-gemini-3.8-flash"),
                "language": "my",
                "duration": gem_res.get("duration", time_offset),
                "text": " ".join(s["text"] for s in segs),
                "segments": segs,
            })
        return JSONResponse(
            {"error": gem_res.get("error", "မြန်မာသီချင်းဆိုသံကို နားထောင်ရာတွင် အဆင်မပြေပါ။")},
            status_code=422,
        )

    # FOREIGN SONG MODE -> Fast Groq Whisper First (2-4 seconds!)
    groq_key = get_groq_key()
    if groq_key:
        try:
            timeout = aiohttp.ClientTimeout(total=60)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                fd = aiohttp.FormData()
                fd.add_field("file", audio_bytes, filename=filename, content_type=mime_type)
                fd.add_field("model", "whisper-large-v3-turbo")
                fd.add_field("response_format", "verbose_json")
                fd.add_field("timestamp_granularities[]", "segment")
                fd.add_field("temperature", "0")

                async with session.post(
                    "[https://api.groq.com/openai/v1/audio/transcriptions](https://api.groq.com/openai/v1/audio/transcriptions)",
                    headers={"Authorization": f"Bearer {groq_key}"},
                    data=fd,
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json(content_type=None)
                        raw_segs = data.get("segments") or []
                        clean_segs = []
                        for s in raw_segs:
                            txt = str(s.get("text") or "").strip()
                            st = float(s.get("start") or 0.0) + time_offset
                            en = float(s.get("end") or 0.0) + time_offset
                            if txt and not is_gibberish_text(txt) and en > st:
                                clean_segs.append({
                                    "id": len(clean_segs) + 1,
                                    "start": round(st, 2),
                                    "end": round(en, 2),
                                    "text": txt,
                                })
                        if clean_segs:
                            return JSONResponse({
                                "ok": True,
                                "engine": "render-groq-whisper",
                                "language": data.get("language", "auto"),
                                "duration": float(data.get("duration") or 0.0) + time_offset,
                                "text": " ".join(x["text"] for x in clean_segs),
                                "segments": clean_segs,
                            })
        except Exception:
            pass

    # Fallback to Gemini Audio for foreign songs
    gem_fallback = await transcribe_or_align_audio_gemini(
        audio_bytes=audio_bytes,
        mime_type=mime_type,
        lang="auto",
        song_title=song_title,
        reference_lyrics=custom_lyrics,
        time_offset=time_offset,
    )
    if gem_fallback.get("ok") and gem_fallback.get("segments"):
        return JSONResponse(gem_fallback)

    return JSONResponse({"error": "အသံဖိုင်ထဲမှ သီချင်းစာသား ထုတ်ယူမရနိုင်ပါ။"}, status_code=422)

# =====================================================
# ROUTE 3: FOREIGN SONG CONCISE MYANMAR TRANSLATION (100% GUARANTEED)
# =====================================================

@app.post("/song")
async def translate_song_lyrics(req: SongRequest):
    if not req.segments:
        return {"ok": True, "lyrics": []}

    batch_size = 28
    all_lyrics = []

    for start_idx in range(0, len(req.segments), batch_size):
        batch = req.segments[start_idx : start_idx + batch_size]
        payload = [
            {"idx": i, "text": str(s.text or s.orig or "").replace("\n", " ").strip()}
            for i, s in enumerate(batch)
        ]

        prompt = f"""
သင်သည် နိုင်ငံတကာသီချင်းများကို မြန်မာကာရာအိုကေ စာတန်းထိုးအဖြစ် ဘာသာပြန်ပေးသော ပညာရှင် ဖြစ်သည်။
အောက်ပါ သီချင်းစာကြောင်း တစ်ကြောင်းချင်းစီအတွက် မူရင်းစာသား (orig)၊ အင်္ဂလိပ်ဘာသာပြန် (en) နှင့် အလွန်ကျစ်လျစ်တိုတောင်းသော မြန်မာဘာသာပြန် (mm) တို့ကို ထုတ်ပေးပါ။

အလွန်အရေးကြီးသော စည်းမျဉ်းများ:
1. "mm" သည် မြန်မာဘာသာစစ်စစ် ဖြစ်ရမည် (အင်္ဂလိပ်စာသား ပြန်မထည့်ရပါ)။
2. "mm" (မြန်မာစာတန်း) သည် ဗီဒီယိုပေါ်တွင် (၁) ကြောင်းတည်း လှပစွာ ပေါ်စေရန် အလွန်တိုတိုနှင့် အဓိပ္ပာယ်ထိမိသော သီချင်းစာသားစတိုင် (စကားလုံး ၄ လုံး မှ ၆ လုံးခန့်သာ) ရေးပေးရမည်။
3. "ကျွန်တော်/ကျွန်မ/ခင်ဗျား/သင်" အစား သီချင်းဆန်သော "ကိုယ်/ငါ/မင်း/တို့" ကိုသာ သုံးပါ။
4. စာကြောင်းအရေအတွက် ({len(payload)} ကြောင်း) နှင့် အစီအစဉ် (idx) အတိအကျ တူညီရမည်။
5. Output MUST be ONLY a valid JSON array:
[
  {{ "idx": 0, "orig": "မူရင်းစာသား", "en": "Short English lyric", "mm": "တိုတိုကျစ်လျစ်သော မြန်မာစာတန်း" }}
]

Input:
{json.dumps(payload, ensure_ascii=False)}
"""
        res = await call_master_ai(prompt)
        parsed = parse_json_array(res.get("text", "")) if res.get("ok") else None

        for i, seg in enumerate(batch):
            orig_clean = str(seg.text or seg.orig or "").replace("\n", " ").strip()
            found = {}
            if isinstance(parsed, list):
                for item in parsed:
                    if isinstance(item, dict) and item.get("idx") == i:
                        found = item
                        break
                if not found and i < len(parsed) and isinstance(parsed[i], dict):
                    found = parsed[i]

            mm_val = str(found.get("mm") or "").replace("\n", " ").strip()
            if not mm_val or is_gibberish_text(mm_val) or (not has_myanmar_script(mm_val) and re.search(r"[a-zA-Z]", mm_val)):
                mm_val = await server_side_translate_gtx(orig_clean, "my")

            all_lyrics.append({
                "id": start_idx + i + 1,
                "start": seg.start,
                "end": seg.end,
                "orig": str(found.get("orig") or orig_clean).replace("\n", " ").strip(),
                "en": str(found.get("en") or orig_clean).replace("\n", " ").strip(),
                "mm": mm_val or orig_clean,
            })

    return {"ok": True, "lyrics": all_lyrics}

@app.post("/translate")
async def translate_batch(req: TranslateRequest):
    if not req.texts:
        return {"ok": True, "translations": []}

    is_en = req.targetLang == "en"
    target_desc = (
        "clear, natural poetic English"
        if is_en
        else "ULTRA-SHORT, concise poetic Myanmar Burmese (only 4 to 6 words per line for song subtitles)"
    )

    prompt = f"""
Translate every line in the JSON array into {target_desc}.
Keep EXACTLY {len(req.texts)} items in the exact same order.
Output ONLY a valid JSON array of strings.

Input:
{json.dumps(req.texts, ensure_ascii=False)}
"""
    res = await call_master_ai(prompt)
    parsed = parse_json_array(res.get("text", "")) if res.get("ok") else None

    out = []
    for i, orig in enumerate(req.texts):
        orig_str = str(orig or "").strip()
        tr = parsed[i] if isinstance(parsed, list) and i < len(parsed) and isinstance(parsed[i], str) else ""
        tr = tr.replace("\n", " ").strip()

        if not is_en and (not tr or not has_myanmar_script(tr) or is_gibberish_text(tr)):
            tr = await server_side_translate_gtx(orig_str, "my")
        elif is_en and (not tr or is_gibberish_text(tr)):
            tr = await server_side_translate_gtx(orig_str, "en")

        out.append(tr or orig_str)
    return {"ok": True, "translations": out}

# =====================================================
# ROUTE 4: STORY MAKER & STORY TO VIDEO (CAPTIVATING HOOK!)
# =====================================================

@app.post("/story")
async def generate_captivating_story(req: StoryRequest):
    topic = (req.topic or "").strip()
    if not topic:
        raise HTTPException(status_code=400, detail="Story topic လိုအပ်ပါသည်။")

    category = req.category or "horror"
    story_type = req.type or "single"

    hook_instruction = """
🔥 အလွန်အရေးကြီးသော အဖွင့်ပိုင်း (SCENE 1 HOOK RULE):
- ပထမဆုံး အခန်း (Scene 1) ကို "တစ်ခါတုန်းက..." သို့မဟုတ် ရိုးရှင်းသော မိတ်ဆက်စကားဖြင့် လုံးဝ မစရပါ!
- ပထမဆုံး စက္ကန့်ပိုင်းအတွင်း နားထောင်သူ ကြက်သီးထသွားစေမည့်၊ သိချင်စိတ် ပြင်းပြသွားစေမည့် (Scroll-Stopping Dramatic Hook / ထူးဆန်းထိတ်လန့်ဖွယ် အဖြစ်အပျက် သို့မဟုတ် မေးခွန်းထုတ်ချက်) ဖြင့် ချက်ချင်း ဆွဲဆောင်မှုရှိရှိ စတင်ရေးသားပါ။
- အခန်းတိုင်းကို စကားပြောဟန် သဘာဝကျကျ၊ ရုပ်ရှင်ဆန်ဆန် စိတ်ဝင်စားဖွယ် အရှိန်အဟုန်မပြတ် စီးဆင်းအောင် ရေးသားပါ။
"""

    if story_type == "series":
        ep_count = min(6, max(2, int(req.episodes or 2)))
        prompt = f"""
သင်သည် ပရိသတ် သန်းချီကြည့်ရှုသော Viral Short Video ဇာတ်လမ်းရေးဆရာ ဖြစ်သည်။
အောက်ပါ ခေါင်းစဉ်ကို အခြေခံ၍ စုစုပေါင်း {ep_count} ပိုင်း (Episode 1 မှ Episode {ep_count} အထိ) ပါဝင်သော ဇာတ်လမ်းတွဲကို ရေးပေးပါ။

ခေါင်းစဉ်: "{topic}"
အမျိုးအစား: {category}
အပိုင်း အရေအတွက်: စုစုပေါင်း {ep_count} ပိုင်း (တစ်ပိုင်းလျှင် အခန်း ၁၅ ခန်း အတိအကျ)

{hook_instruction}

စည်းမျဉ်းများ:
1. Episode တစ်ခုစီ၏ Scene 1 တိုင်းတွင် ပရိသတ် ဆက်မကြည့်ဘဲ မနေနိုင်အောင် ဆွဲဆောင်နိုင်သည့် အဖွင့် Hook ဖြင့် စတင်ပြီး၊ အပိုင်းအဆုံး (Scene 15) တွင် နောက်တစ်ပိုင်း ဆက်ကြည့်ချင်လာအောင် Cliffhanger ဖြင့် အဆုံးသတ်ပါ။
2. Scene တစ်ခုစီ၏ မြန်မာစာသား (text_mm) သည် စကားလုံးရေ ၃၅ လုံးမှ ၄၅ လုံးခန့် ရှိရမည်။
3. image_prompt_en ကို Cinematic English visual prompt အဖြစ် အသေးစိတ် ရေးပါ။
4. Output MUST be ONLY a valid JSON array:
[
  {{
    "episode": 1,
    "scene": 1,
    "text_mm": "ညသန်းခေါင် ၁၂ နာရီတိတိမှာ သင့်အိပ်ခန်းတံခါးကို အပြင်ကမဟုတ်ဘဲ အထဲကနေ လာခေါက်နေသံ ကြားလိုက်ရရင် သင်ဘာလုပ်မလဲ...",
    "image_prompt_en": "Eerie bedroom door at midnight, dramatic shadows, cinematic horror lighting, 8k"
  }}
]
"""
    else:
        num_dur = int(req.duration or 1)
        scene_count = 8 if num_dur == 1 else (15 if num_dur == 2 else (20 if num_dur == 3 else 32))
        prompt = f"""
သင်သည် ပရိသတ် သန်းချီကြည့်ရှုသော Viral Faceless AI Video ဇာတ်လမ်းရေးဆရာ ဖြစ်သည်။
ခေါင်းစဉ်: "{topic}"
အမျိုးအစား: {category}
ကြာချိန်: {num_dur} မိနစ် (စုစုပေါင်း အခန်း {scene_count} ခန်း အတိအကျ)

{hook_instruction}

စည်းမျဉ်းများ:
1. Scene 1 ကို ပရိသတ် ဖုန်းပွတ်နေရာမှ ရပ်ပြီး နားထောင်ချင်လာစေမည့် အပြင်းထန်ဆုံး စိတ်ဝင်စားဖွယ် Hook ဖြင့် စတင်ပါ။
2. Scene တစ်ခုစီ၏ မြန်မာစာသား (text_mm) သည် စကားလုံးရေ ၃၅ လုံးမှ ၄၅ လုံးခန့် ရှိရမည်။
3. image_prompt_en ကို Cinematic English visual prompt အဖြစ် ရေးပါ။
4. Output MUST be ONLY a valid JSON array:
[
  {{
    "episode": 1,
    "scene": 1,
    "text_mm": "လူတိုင်း မေ့ပျောက်ထားကြတဲ့ ဒီရွာပျက်ကြီးထဲကို ခြေချမိသူတိုင်း ဘာကြောင့် မနက်မိုးလင်းတာနဲ့ ပျောက်ဆုံးသွားကြရတာလဲ...",
    "image_prompt_en": "Abandoned mysterious village in deep fog, cinematic dramatic lighting, 8k resolution"
  }}
]
"""

    res = await call_master_ai(prompt, max_timeout=60)
    if not res.get("ok"):
        raise HTTPException(status_code=503, detail=res.get("error", "Story generation failed"))

    parsed_story = parse_json_array(res.get("text", ""))
    if not isinstance(parsed_story, list) or not parsed_story:
        raise HTTPException(status_code=502, detail="Story JSON array ဖတ်မရပါ။")

    return {"ok": True, "story": parsed_story}

# =====================================================
# ROUTE 5: MOVIE RECAPS
# =====================================================

@app.post("/recap")
async def generate_movie_recap(req: RecapRequest):
    if not req.segments:
        raise HTTPException(status_code=400, detail="Segments မပါရှိပါ။")

    video_dur = float(req.duration or 60.0)
    prompt = f"""
သင်သည် မြန်မာ Movie Recap Channel အတွက် ကျွမ်းကျင်သော ဇာတ်ကြောင်းပြော စာရေးဆရာ ဖြစ်သည်။
ဗီဒီယို စုစုပေါင်း ကြာချိန်: {round(video_dur)} စက္ကန့်။
ပထမဆုံး စာကြောင်း (id: 1) တွင် ပရိသတ် စိတ်ဝင်စားသွားစေမည့် ဆွဲဆောင်မှုရှိသော အဖွင့်စကားဖြင့် စတင်ပြီး 0 စက္ကန့်မှ {round(video_dur)} စက္ကန့်အထိ ဇာတ်ကြောင်းပြော စာတန်းထိုးများ ရေးပေးပါ။
Output MUST be ONLY valid JSON array:
[
  {{ "id": 1, "start": 0.0, "end": 4.5, "recap_mm": "ဆွဲဆောင်မှုရှိသော အဖွင့်စာသား..." }}
]
SOURCE SEGMENTS:
{json.dumps(req.segments[:150], ensure_ascii=False)}
"""
    res = await call_master_ai(prompt, max_timeout=60)
    if not res.get("ok"):
        raise HTTPException(status_code=503, detail=res.get("error", "Recap generation failed"))

    parsed = parse_json_array(res.get("text", ""))
    if not isinstance(parsed, list):
        raise HTTPException(status_code=502, detail="Recap JSON ဖတ်မရပါ။")

    return {"ok": True, "recap": parsed}
