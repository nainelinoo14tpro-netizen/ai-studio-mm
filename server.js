const express = require('express');
const cors = require('cors');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health Check
app.get('/', (req, res) => {
  res.send('Myanmar TTS Server is Running!');
});

// Edge TTS API Endpoint
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'my-MM-NilarNeural', rate = '+0%', pitch = '+0Hz', volume = '+50%' } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const readable = tts.toStream(text.trim(), {
      rate: rate,
      pitch: pitch,
      volume: volume
    });

    const chunks = [];
    readable.on('data', chunk => chunks.push(chunk));
    readable.on('end', () => {
      const audioBuffer = Buffer.concat(chunks);
      res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length
      });
      res.send(audioBuffer);
    });

    readable.on('error', err => {
      console.error('Stream error:', err);
      res.status(500).json({ error: 'TTS Streaming Error' });
    });
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ error: error.message || 'Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
