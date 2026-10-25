const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health Check (မူရင်း Route နှင့် Health Route နှစ်ခုလုံး ထည့်ပေးထားပါသည်)
app.get('/', (req, res) => {
  res.send('Myanmar TTS Server is Running (Direct HTTPS + Edge Spoofing Active!)');
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'burmese-tts-http-ws', status: 'online' });
});

// Windows FileTime based Sec-MS-GEC Token Generator (BigInt Precision)
function getSecMsGec() {
  const unixSeconds = Math.floor(Date.now() / 1000);
  const fileTimeSeconds = BigInt(unixSeconds) + 11644473600n;
  let ticks = fileTimeSeconds * 10000000n;
  ticks -= (ticks % 3000000000n);
  const strToHash = ticks.toString() + TRUSTED_CLIENT_TOKEN;
  return crypto.createHash('sha256').update(strToHash).digest('hex').toUpperCase();
}

function escapeXml(text) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeRate(rate) {
  if (typeof rate === 'string' && /^[+-]\d{1,3}%$/.test(rate.trim())) return rate.trim();
  return '+0%';
}

function normalizePitch(pitch) {
  if (typeof pitch === 'string' && /^[+-]\d{1,3}Hz$/.test(pitch.trim())) return pitch.trim();
  return '+0Hz';
}

function normalizeVolume(volume) {
  if (typeof volume === 'string' && /^[+-]\d{1,3}%$/.test(volume.trim())) return volume.trim();
  return '+50%';
}

function buildSsml(text, voice, rate, pitch, volume) {
  const cleanText = escapeXml(text.trim());
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='my-MM'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${cleanText}</prosody>` +
    `</voice>` +
    `</speak>`
  );
}

// =========================================================================
// ENGINE 1: Direct HTTPS POST Request (WebSocket Handshake မလိုသော နည်းလမ်း)
// =========================================================================
async function synthesizeViaDirectHttps(ssml) {
  const secMsGec = getSecMsGec();
  const connectionId = crypto.randomUUID().replace(/-/g, '');
  const muid = crypto.randomUUID().replace(/-/g, '').toUpperCase();

  const endpointUrl =
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${connectionId}`;

  const dateStr = new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
  const reqId = crypto.randomUUID().replace(/-/g, '');

  const payload =
    `X-Timestamp:${dateStr}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-RequestId:${reqId}\r\n` +
    `Path:ssml\r\n\r\n` +
    `${ssml}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 14000);

  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Cookie': `muid=${muid};`,
        'Sec-MS-GEC': secMsGec,
        'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
        'X-MSEdge-IAA': '1',
        'Content-Type': 'application/ssml+xml',
      },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Direct HTTPS returned HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const headerSeparator = Buffer.from('Path:audio\r\n');
    const sepIndex = buffer.indexOf(headerSeparator);

    let audioData = buffer;
    if (sepIndex !== -1) {
      audioData = buffer.subarray(sepIndex + headerSeparator.length);
    }

    if (!audioData || audioData.length < 100) {
      throw new Error('Direct HTTPS returned empty audio data');
    }

    return audioData;
  } finally {
    clearTimeout(timeout);
  }
}

// =========================================================================
// ENGINE 2: Upgraded WebSocket Streaming (MUID Cookie + Close Handler)
// =========================================================================
function synthesizeViaWebSocket(ssml) {
  return new Promise((resolve, reject) => {
    const connectionId = crypto.randomUUID().replace(/-/g, '');
    const muid = crypto.randomUUID().replace(/-/g, '').toUpperCase();
    const secMsGec = getSecMsGec();

    const wsUrl =
      `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
      `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${secMsGec}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
      `&ConnectionId=${connectionId}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
        'Cookie': `muid=${muid};`,
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Sec-MS-GEC': secMsGec,
        'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const audioChunks = [];
    let isDone = false;

    const finish = (err, buffer) => {
      if (isDone) return;
      isDone = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      if (err) return reject(err);
      resolve(buffer);
    };

    const timer = setTimeout(() => {
      finish(new Error('WebSocket TTS Timeout'));
    }, 15000);

    ws.on('open', () => {
      const dateStr = new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
      const reqId = crypto.randomUUID().replace(/-/g, '');

      ws.send(
        `X-Timestamp:${dateStr}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
      );

      ws.send(
        `X-RequestId:${reqId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${dateStr}\r\n` +
        `Path:ssml\r\n\r\n` +
        `${ssml}`
      );
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (data.length > 2) {
          const headerLen = data.readUInt16BE(0);
          if (data.length > headerLen + 2) {
            const headerText = data.toString('utf8', 2, headerLen + 2);
            if (headerText.includes('Path:audio')) {
              audioChunks.push(data.slice(headerLen + 2));
            }
          }
        }
      } else {
        const str = data.toString();
        if (str.includes('Path:turn.end')) {
          if (audioChunks.length === 0) {
            return finish(new Error('WebSocket ended with 0 audio chunks'));
          }
          finish(null, Buffer.concat(audioChunks));
        }
      }
    });

    ws.on('error', (err) => {
      finish(new Error(`WebSocket error: ${err.message}`));
    });

    ws.on('close', (code) => {
      if (!isDone) {
        if (audioChunks.length > 0) {
          finish(null, Buffer.concat(audioChunks));
        } else {
          finish(new Error(`WebSocket closed prematurely (code ${code})`));
        }
      }
    });
  });
}

// =========================================================================
// MAIN TTS HANDLER (Supports /api/tts, /api/synthesize, and /tts)
// =========================================================================
async function handleTtsRequest(req, res) {
  try {
    const {
      text,
      voice = 'my-MM-NilarNeural',
      rate = '+0%',
      pitch = '+0Hz',
      volume = '+50%',
    } = req.body || {};

    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const safeVoice = voice === 'my-MM-ThihaNeural' ? 'my-MM-ThihaNeural' : 'my-MM-NilarNeural';
    const safeRate = normalizeRate(rate);
    const safePitch = normalizePitch(pitch);
    const safeVolume = normalizeVolume(volume);

    const ssml = buildSsml(text, safeVoice, safeRate, safePitch, safeVolume);

    let audioBuffer = null;
    const errors = [];

    // 1. Try WebSocket Engine First (with updated Chromium 143 + MUID Cookie)
    try {
      audioBuffer = await synthesizeViaWebSocket(ssml);
    } catch (wsErr) {
      errors.push(wsErr.message);
      console.warn('WebSocket Engine failed, trying Direct HTTPS POST:', wsErr.message);
    }

    // 2. Fallback to Direct HTTPS POST Engine
    if (!audioBuffer || audioBuffer.length < 100) {
      try {
        audioBuffer = await synthesizeViaDirectHttps(ssml);
      } catch (httpErr) {
        errors.push(httpErr.message);
        console.error('Direct HTTPS POST Engine also failed:', httpErr.message);
      }
    }

    if (!audioBuffer || audioBuffer.length < 100) {
      return res.status(502).json({
        error: 'TTS Synthesis failed on both WebSocket and Direct HTTPS engines.',
        details: errors.join(' | '),
      });
    }

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'Cache-Control': 'public, max-age=86400',
      'X-TTS-Voice': safeVoice,
    });

    return res.send(audioBuffer);
  } catch (error) {
    console.error('TTS error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Server Error' });
    }
  }
}

app.post('/api/tts', handleTtsRequest);
app.post('/api/synthesize', handleTtsRequest);
app.post('/tts', handleTtsRequest);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
