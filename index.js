// Körs i Node.js på Render (matchzy-uploader)
const express = require('express');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const axios = require('axios');
const { GameDig } = require('gamedig');
const { Rcon } = require('rcon-client');

const app = express();

// Tillåt anrop från webbläsare och Cloudflare Workers (CORS)
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

// Cache för att inte överbelasta servern med RCON vid tät polling
let cachedStatus = null;
let lastQueryTime = 0;

// Parser för CS2 "status"-utskrift
function parseCS2Status(rawText) {
  const players = [];
  const lines = rawText.split('\n');

  let currentMap = 'de_dust2';
  for (const line of lines) {
    if (line.includes('map :')) {
      const match = line.match(/map\s*:\s*([^\s]+)/i);
      if (match) currentMap = match[1];
    }
    // CS2 status format: # 2 1 "Aspen" STEAM_1:0:123456 04:12 45 0 active
    // Matchar rader som börjar med # [userid] [slot] "[name]"
    const playerMatch = line.match(/^#\s+\d+\s+\d+\s+"([^"]+)"\s+(STEAM_[^\s]+|\[U:[^\s]+\])\s+([^\s]+)/);
    if (playerMatch) {
      const name = playerMatch[1];
      const timeStr = playerMatch[3];
      
      // Räkna om tidsträng (mm:ss) till sekunder
      let totalSeconds = 0;
      if (timeStr && timeStr.includes(':')) {
        const parts = timeStr.split(':').map(Number);
        if (parts.length === 2) totalSeconds = parts[0] * 60 + parts[1];
        if (parts.length === 3) totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      }

      // Filtrera bort BOTs och GOTV
      if (!name.toLowerCase().includes('bot') && !name.toLowerCase().includes('gotv')) {
        players.push({
          name: name,
          time: totalSeconds
        });
      }
    }
  }

  return { currentMap, players };
}

// 1. Live Players Query via RCON (med GameDig fallback)
app.get('/api/server/live', async (req, res) => {
  const now = Date.now();
  // Returnera cache om förfrågan sker inom 5 sekunder
  if (cachedStatus && (now - lastQueryTime < 5000)) {
    return res.json(cachedStatus);
  }

  const rconPassword = process.env.RCON_PASSWORD;

  if (rconPassword) {
    let rcon;
    try {
      rcon = await Rcon.connect({
        host: '212.102.62.209',
        port: 25152,
        password: rconPassword,
        timeout: 2500
      });

      const response = await rcon.send('status');
      await rcon.end();

      const { currentMap, players } = parseCS2Status(response);

      cachedStatus = {
        online: true,
        name: "GubbLir",
        map: currentMap,
        playerCount: players.length,
        maxPlayers: 10,
        players: players
      };
      lastQueryTime = now;
      return res.json(cachedStatus);

    } catch (rconErr) {
      if (rcon) try { await rcon.end(); } catch (e) {}
      console.error('RCON Error, fallback till GameDig:', rconErr.message || rconErr);
    }
  }

  // Fallback: GameDig
  try {
    const state = await GameDig.query({
      type: 'counterstrike2',
      host: '212.102.62.209',
      port: 25152,
      givenPortOnly: true,
      maxAttempts: 2,
      socketTimeout: 2000
    });

    const parsedPlayers = (state.players || []).map(p => ({
      name: p.name && p.name.trim() !== '' ? p.name : 'Spelare',
      time: p.raw?.time || 0
    }));

    cachedStatus = {
      online: true,
      name: state.name || "GubbLir",
      map: state.map || "de_dust2",
      playerCount: parsedPlayers.length,
      maxPlayers: state.maxplayers || 10,
      players: parsedPlayers
    };
    lastQueryTime = now;
    return res.json(cachedStatus);
  } catch (err) {
    return res.json({
      online: true,
      map: 'de_dust2',
      playerCount: 0,
      maxPlayers: 10,
      players: []
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
