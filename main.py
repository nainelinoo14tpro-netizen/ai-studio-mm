import os
import tempfile
import edge_tts
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
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

class TTSRequest(BaseModel):
    text: str
    voice: str = "my-MM-NilarNeural"
    rate: str = "+0%"
    pitch: str = "+0Hz"

@app.get("/")
async def root():
    return {"ok": True, "service": "burmese-edge-tts-python", "status": "online"}

@app.get("/api/health")
async def health():
    return {"ok": True, "status": "online"}

# Endpoint (၂) ခုလုံးဖြင့် လက်ခံနိုင်ရန် လမ်းကြောင်းပေးထားခြင်း
@app.post("/api/synthesize")
@app.post("/api/tts")
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
