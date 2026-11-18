// Körs i Node.js på Render (matchzy-uploader)
const express = require('express');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const axios = require('axios');
const { GameDig } = require('gamedig');
const { Rcon } = require('rcon-client');
const { Pool } = require('pg');

const app = express();

// Parsa JSON-bodies för MatchZy webhooks
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Databasanslutning (Supabase PostgreSQL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

let cachedStatus = null;
let lastQueryTime = 0;

// Exakt parser för Source 2 / CS2 status
function parseCS2Status(rawText) {
  const players = [];
  const lines = rawText.split('\n');

  let currentMap = 'de_dust2';

  const mapMatch = rawText.match(/Map\s+"([^"]+)"/i) || rawText.match(/spawngroup\(\s*1\)\s*:\s*SV:\s*\[\d+:\s*([^\s|]+)/i);
  if (mapMatch) {
    currentMap = mapMatch[1];
  }

  let inPlayerSection = false;

  for (let line of lines) {
    const trimmed = line.trim();

    if (trimmed.includes('---------players--------')) {
      inPlayerSection = true;
      continue;
    }

    if (inPlayerSection) {
      if (trimmed === '#end' || trimmed.startsWith('--- SourceTV')) {
        inPlayerSection = false;
        break;
      }

      const match = trimmed.match(/^(\d+)\s+([^\s]+)\s+(\d+)\s+(\d+)\s+([^\s]+)\s+(\d+)\s+([^\s]+)\s+'([^']+)'$/);

      if (match) {
        const timeStr = match[2];
        const ping = parseInt(match[3], 10);
        const name = match[8];

        if (timeStr === 'BOT' || name === 'SourceTV' || name === '') {
          continue;
        }

        let totalSeconds = 0;
        if (timeStr.includes(':')) {
          const parts = timeStr.split(':').map(Number);
          if (parts.length === 2) totalSeconds = parts[0] * 60 + parts[1];
          if (parts.length === 3) totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }

        players.push({
          name: name,
          ping: ping,
          time: totalSeconds
        });
      }
    }
  }

  return { currentMap, players };
}

// Hjälpfunktion för att extrahera spelare oavsett om MatchZy skickar Array eller Object
function extractTeamPlayers(teamObj, teamName) {
  const list = [];
  if (!teamObj || !teamObj.players) return list;

  if (Array.isArray(teamObj.players)) {
    for (const p of teamObj.players) {
      list.push({ ...p, team: teamName });
    }
  } else if (typeof teamObj.players === 'object') {
    for (const [steamKey, p] of Object.entries(teamObj.players)) {
      if (p && typeof p === 'object') {
        list.push({
          ...p,
          steamid: p.steamid || p.steamid64 || steamKey,
          team: teamName
        });
      }
    }
  }
  return list;
}

// 1. Live Players Query via RCON
app.get('/api/server/live', async (req, res) => {
  const now = Date.now();
  if (cachedStatus && (now - lastQueryTime < 3000)) {
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
        players: players,
        source: 'rcon'
      };
      lastQueryTime = now;
      return res.json(cachedStatus);

    } catch (rconErr) {
      if (rcon) try { await rcon.end(); } catch (e) {}
      console.error('RCON Error, fallback till GameDig:', rconErr.message || rconErr);
    }
  }

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
      players: parsedPlayers,
      source: 'gamedig'
    };
    lastQueryTime = now;
    return res.json(cachedStatus);
  } catch (err) {
    return res.json({
      online: true,
      map: 'de_dust2',
      playerCount: 0,
      maxPlayers: 10,
      players: [],
      source: 'none'
    });
  }
});

// 2. Webhook för MatchZy Match- och Spelarstatistik
app.post('/matchzy', async (req, res) => {
  const data = req.body;

  if (!data || !data.event) {
    return res.status(200).send('OK');
  }

  console.log(`[MatchZy Webhook] Event: ${data.event}`, JSON.stringify(data).slice(0, 600));

  // Spara enbart vid map_result (där kartnamn, rundpoäng och spelarstats finns)
  if (data.event === 'map_result') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const mapNum = data.map_number !== undefined ? `_${data.map_number}` : '';
      const matchId = String(data.matchid ? `${data.matchid}${mapNum}` : `match_${Date.now()}`);
      const mapName = data.map_name || data.mapname || 'de_unknown';
      const team1Name = data.team1?.name || 'Team 1';
      const team1Score = parseInt(data.team1?.score ?? 0, 10);
      const team2Name = data.team2?.name || 'Team 2';
      const team2Score = parseInt(data.team2?.score ?? 0, 10);

      let winner = data.winner?.name;
      if (!winner) {
        if (data.winner?.team === 'team1' || team1Score > team2Score) winner = team1Name;
        else if (data.winner?.team === 'team2' || team2Score > team1Score) winner = team2Name;
        else winner = 'Oavgjort';
      }

      // Spara eller uppdatera matchen
      await client.query(`
        INSERT INTO matches (match_id, map_name, team1_name, team1_score, team2_name, team2_score, winner)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (match_id) DO UPDATE SET
          map_name = EXCLUDED.map_name,
          team1_name = EXCLUDED.team1_name,
          team1_score = EXCLUDED.team1_score,
          team2_name = EXCLUDED.team2_name,
          team2_score = EXCLUDED.team2_score,
          winner = EXCLUDED.winner;
      `, [matchId, mapName, team1Name, team1Score, team2Name, team2Score, winner]);

      // Samla alla spelare från båda lagen (stödjer både Array och Object)
      const players = [
        ...extractTeamPlayers(data.team1, team1Name),
        ...extractTeamPlayers(data.team2, team2Name)
      ];

      // Rensa eventuella gamla rader för samma match_id vid omskickning
      if (players.length > 0) {
        await client.query('DELETE FROM player_stats WHERE match_id = $1;', [matchId]);
      }

      for (const p of players) {
        const steamId = String(p.steamid || p.steamid64 || p.id || 'unknown');
        const name = p.name || 'Gubbe';
        const s = p.stats || p;

        const kills = parseInt(s.kills ?? 0, 10);
        const deaths = parseInt(s.deaths ?? 0, 10);
        const assists = parseInt(s.assists ?? 0, 10);
        const headshots = parseInt(s.headshot_kills ?? s.headshots ?? 0, 10);
        const damage = parseInt(s.damage ?? 0, 10);
        const rounds = parseInt(s.rounds_played ?? s.roundsplayed ?? (team1Score + team2Score), 10);
        const mvps = parseInt(s.mvp ?? s.mvps ?? 0, 10);

        await client.query(`
          INSERT INTO player_stats (match_id, steamid64, name, team, kills, deaths, assists, headshots, damage, rounds_played, mvps)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
        `, [matchId, steamId, name, p.team, kills, deaths, assists, headshots, damage, rounds, mvps]);
      }

      await client.query('COMMIT');
      console.log(`[MatchZy Webhook] Sparade match ${matchId} (${mapName} ${team1Score}-${team2Score}) och ${players.length} spelare!`);
    } catch (dbErr) {
      await client.query('ROLLBACK');
      console.error('[MatchZy Webhook] Databasfel vid sparande:', dbErr);
    } finally {
      client.release();
    }
  }

  return res.status(200).send('OK');
});

// 3. API Endpoints för Frontend / Leaderboard
app.get('/api/stats/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        steamid64,
        MAX(name) AS name,
        COUNT(DISTINCT match_id)::int AS matches_played,
        SUM(kills)::int AS total_kills,
        SUM(deaths)::int AS total_deaths,
        SUM(assists)::int AS total_assists,
        SUM(headshots)::int AS total_headshots,
        SUM(damage)::int AS total_damage,
        SUM(rounds_played)::int AS total_rounds,
        SUM(mvps)::int AS total_mvps,
        ROUND(SUM(kills)::numeric / NULLIF(SUM(deaths), 0), 2) AS kd_ratio,
        ROUND((SUM(headshots)::numeric / NULLIF(SUM(kills), 0)) * 100, 1) AS hs_percentage
      FROM player_stats
      WHERE steamid64 != 'unknown'
      GROUP BY steamid64
      ORDER BY kd_ratio DESC NULLS LAST, total_kills DESC
      LIMIT 100;
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Kunde inte hämta leaderboard:', err);
    res.status(500).json({ error: 'Kunde inte hämta leaderboard' });
  }
});

app.get('/api/stats/matches', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM matches 
      ORDER BY played_at DESC 
      LIMIT 20;
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Kunde inte hämta matcher:', err);
    res.status(500).json({ error: 'Kunde inte hämta matcher' });
  }
});

// 4. Demo Upload från MatchZy
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
  res.send('MatchZy S3 Uploader & Stats Backend är igång och redo.');
});

app.listen(process.env.PORT || 3000, () => console.log('Uploader running!'));
