const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health Check
app.get('/', (req, res) => {
  res.send('Myanmar TTS Server is Running (Updated Security!)');
});

// Microsoft Edge Security Token Generator
function getSecMsGec() {
  const unixSeconds = Math.floor(Date.now() / 1000);
  const fileTimeSeconds = BigInt(unixSeconds) + 11644473600n;
  let ticks = fileTimeSeconds * 10000000n;
  ticks -= (ticks % 3000000000n);
  const strToHash = ticks.toString() + "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  return crypto.createHash('sha256').update(strToHash).digest('hex').toUpperCase();
}

// Edge TTS API Endpoint
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'my-MM-NilarNeural', rate = '+0%', pitch = '+0Hz', volume = '+50%' } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const connectionId = crypto.randomUUID().replace(/-/g, "");
    const secMsGec = getSecMsGec();
    
    // Bypass Security with Direct WebSocket
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-131.0.2903.86&ConnectionId=${connectionId}`;

    const ws = new WebSocket(wsUrl);
    const audioChunks = [];
    let isDone = false;

    // Timeout Fallback
    const timer = setTimeout(() => {
      if (!isDone) {
        isDone = true;
        ws.close();
        res.status(504).json({ error: 'TTS Timeout' });
      }
    }, 15000);

    ws.on('open', () => {
      const dateStr = new Date().toString();
      const reqId = crypto.randomUUID().replace(/-/g, "");
      const cleanText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='my-MM'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${cleanText}</prosody></voice></speak>`;

      ws.send(`X-Timestamp:${dateStr}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
      ws.send(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${dateStr}\r\nPath:ssml\r\n\r\n${ssml}`);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (data.length > 2) {
          const headerLen = data.readUInt16BE(0);
          if (data.length > headerLen + 2) {
            const headerText = data.toString('utf8', 2, headerLen + 2);
            if (headerText.includes("Path:audio")) {
              audioChunks.push(data.slice(headerLen + 2));
            }
          }
        }
      } else {
        const str = data.toString();
        if (str.includes("Path:turn.end")) {
          if (!isDone) {
            isDone = true;
            clearTimeout(timer);
            ws.close();
            const audioBuffer = Buffer.concat(audioChunks);
            res.set({
              'Content-Type': 'audio/mpeg',
              'Content-Length': audioBuffer.length
            });
            res.send(audioBuffer);
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      if (!isDone) {
        isDone = true;
        clearTimeout(timer);
        res.status(500).json({ error: 'WebSocket Streaming Error' });
      }
    });

  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ error: error.message || 'Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
