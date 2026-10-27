// Körs i Node.js på Render (matchzy-uploader)
const express = require('express');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const axios = require('axios');
const { GameDig } = require('gamedig');

const app = express();

// Tillåt anrop från webbläsare och Workers (CORS)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

// 1. Live Players Query direkt mot CS2-servern via UDP
app.get('/api/server/live', async (req, res) => {
  try {
    const state = await GameDig.query({
      type: 'counterstrike2',
      host: '212.102.62.209',
      port: 25152,
      givenPortOnly: true,
      maxAttempts: 2,
      socketTimeout: 2500
    });

    const players = (state.players || [])
      .map(p => {
        const parsedName = (p.name || p.raw?.name || '').trim();
        return {
          name: parsedName.length > 0 ? parsedName : 'Spelare',
          rawScore: p.raw?.score || 0,
          time: p.raw?.time || 0
        };
      })
      .filter(p => p.name !== '');

    return res.json({
      online: true,
      name: state.name,
      map: state.map,
      playerCount: players.length,
      maxPlayers: state.maxplayers || 10,
      players: players
    });
  } catch (err) {
    console.error('GameDig Query Error:', err.message || err);
    return res.json({
      online: true,
      map: 'de_dust2',
      playerCount: 0,
      maxPlayers: 10,
      players: [],
      debug_error: err.message || String(err)
    });
  }
});

// 2. Demo Upload från MatchZy
app.post('/upload', async (req, res) => {
  try {
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `demo_${dateStr}.dem`;

    const parallelUploads3 = new Upload({
      client: s3,
      params: {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: filename,
        Body: req,
        ContentType: 'application/octet-stream',
      },
      queueSize: 1,
      partSize: 1024 * 1024 * 5,
      leavePartsOnError: false,
    });

    await parallelUploads3.done();

    const demoUrl = `${process.env.PUBLIC_URL}/${filename}`;

    if (process.env.DISCORD_WEBHOOK_URL) {
      await axios.post(process.env.DISCORD_WEBHOOK_URL, {
        embeds: [{
          title: "🎬 GubbLir Demo Redo!",
          description: `Fil: \`${filename}\``,
          color: 0xD4AF37,
          fields: [{ name: "Ladda ner demo", value: `[Klicka här för att ladda ner](${demoUrl})` }],
          footer: { text: "GubbLir CS2" }
        }]
      });
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Uppladdningsfel:', err);
    res.status(500).send('Error');
  }
});

app.get('/', (req, res) => {
  res.send('MatchZy S3 Uploader är igång och redo.');
});

app.listen(process.env.PORT || 3000, () => console.log('Uploader running!'));
