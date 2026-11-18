// Körs i Node.js på Render (Repo: matchzy-uploader / Fil: index.js)
// Krav på Environment Variables i Render: DATABASE_URL, RCON_PASSWORD
const express = require('express');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const axios = require('axios');
const { GameDig } = require('gamedig');
const { Rcon } = require('rcon-client');
const { Pool } = require('pg');

const app = express();

app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

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
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  },
});

let cachedStatus = null;
let lastQueryTime = 0;
let latestBalancedMatchConfig = null;

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

  console.log(`[MatchZy Webhook] Event: ${data.event}`);

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

      const players = [
        ...extractTeamPlayers(data.team1, team1Name),
        ...extractTeamPlayers(data.team2, team2Name)
      ];

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

// 3. Topplista med självkalibrerande GubbLir Skill Rating (K/D + ADR + Winrate)
app.get('/api/stats/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        ps.steamid64,
        MAX(ps.name) AS name,
        COUNT(DISTINCT ps.match_id)::int AS matches_played,
        COUNT(DISTINCT CASE WHEN m.winner = ps.team THEN ps.match_id END)::int AS matches_won,
        ROUND(
          (COUNT(DISTINCT CASE WHEN m.winner = ps.team THEN ps.match_id END)::numeric / NULLIF(COUNT(DISTINCT ps.match_id), 0)) * 100,
          0
        )::int AS win_rate,
        SUM(ps.kills)::int AS total_kills,
        SUM(ps.deaths)::int AS total_deaths,
        SUM(ps.assists)::int AS total_assists,
        SUM(ps.headshots)::int AS total_headshots,
        SUM(ps.damage)::int AS total_damage,
        SUM(ps.rounds_played)::int AS total_rounds,
        SUM(ps.mvps)::int AS total_mvps,
        ROUND(SUM(ps.kills)::numeric / NULLIF(SUM(ps.deaths), 0), 2) AS kd_ratio,
        ROUND(SUM(ps.damage)::numeric / NULLIF(SUM(ps.rounds_played), 0), 1) AS adr,
        ROUND((SUM(ps.headshots)::numeric / NULLIF(SUM(ps.kills), 0)) * 100, 1) AS hs_percentage
      FROM player_stats ps
      LEFT JOIN matches m ON ps.match_id = m.match_id
      WHERE ps.steamid64 != 'unknown'
      GROUP BY ps.steamid64
      ORDER BY kd_ratio DESC NULLS LAST, total_kills DESC
      LIMIT 100;
    `);

    // Beräkna Bayesian-viktad GubbLir Rating (1000 = basnivå)
    const enriched = result.rows.map(row => {
      const matches = row.matches_played || 0;
      const kd = parseFloat(row.kd_ratio || 1.0);
      const adr = parseFloat(row.adr || 75.0);
      const winRate = parseFloat(row.win_rate ?? 50.0);

      // Confidence factor: når full styrka (1.0) vid 5 spelade matcher
      const confidence = Math.min(matches / 5.0, 1.0);
      const rawDelta = ((kd - 1.0) * 350) + ((adr - 75.0) * 4.5) + ((winRate - 50.0) * 3.0);
      const skillRating = Math.round(1000 + (rawDelta * confidence));

      return {
        ...row,
        skill_rating: Math.max(400, skillRating)
      };
    });

    res.json(enriched);
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

// 4. MatchZy Dynamic Config Endpoint (Anropas av CS2-servern vid matchzy_loadmatch_url)
app.get('/api/match/latest-config.json', (req, res) => {
  if (!latestBalancedMatchConfig) {
    return res.status(404).json({ error: 'Ingen aktiv matchkonfiguration sparad' });
  }
  res.json(latestBalancedMatchConfig);
});

// 5. Pusha balanserade lag & karta direkt till CS2-servern via RCON
app.post('/api/match/push-to-server', async (req, res) => {
  const { password, mode, map, teamCT, teamT } = req.body || {};
  const expectedPassword = process.env.CS2_SERVER_PASSWORD || 'gubbe1337';

  if (!password || password !== expectedPassword) {
    return res.status(403).json({ error: 'Ogiltigt medlemslösenord' });
  }

  const rconPassword = process.env.RCON_PASSWORD;
  if (!rconPassword) {
    return res.status(500).json({ error: 'RCON_PASSWORD saknas på Render-servern' });
  }

  if (!Array.isArray(teamCT) || !Array.isArray(teamT) || teamCT.length === 0 || teamT.length === 0) {
    return res.status(400).json({ error: 'Ogiltiga laguppställningar' });
  }

  let rcon;
  try {
    rcon = await Rcon.connect({
      host: '212.102.62.209',
      port: 25152,
      password: rconPassword,
      timeout: 3500
    });

    const ctNames = teamCT.map(p => p.name).join(', ');
    const tNames = teamT.map(p => p.name).join(', ');

    // Annonsera de balanserade lagen tydligt i CS2-chatten
    await rcon.send(`say "=== [GubbLir Lagbalanserare] ==="`);
    await rcon.send(`say "LAG CT: ${ctNames}"`);
    await rcon.send(`say "LAG T: ${tNames}"`);

    const allPlayers = [...teamCT, ...teamT];
    const allHaveSteamId = allPlayers.length >= 2 && allPlayers.every(p => p.steamid64 && p.steamid64 !== 'unknown');

    // Om användaren valde att ladda full MatchZy-konfig och alla har SteamID64 i databasen
    if (mode === 'load_match' && allHaveSteamId) {
      const ctPlayersObj = {};
      teamCT.forEach(p => { ctPlayersObj[String(p.steamid64)] = p.name; });

      const tPlayersObj = {};
      teamT.forEach(p => { tPlayersObj[String(p.steamid64)] = p.name; });

      const chosenMap = (map && map.startsWith('de_')) ? map : 'de_mirage';

      latestBalancedMatchConfig = {
        matchid: Math.floor(Date.now() / 1000),
        team1: {
          name: "Lag CT",
          players: ctPlayersObj
        },
        team2: {
          name: "Lag T",
          players: tPlayersObj
        },
        num_maps: 1,
        maplist: [chosenMap],
        map_sides: ["team1_ct"],
        clinch_series: true,
        players_per_team: Math.max(teamCT.length, teamT.length)
      };

      const selfUrl = process.env.RENDER_EXTERNAL_URL || 'https://matchzy-uploader.onrender.com';
      await rcon.send(`matchzy_loadmatch_url "${selfUrl}/api/match/latest-config.json"`);
      await rcon.end();

      return res.json({
        ok: true,
        method: 'matchzy_loadmatch_url',
        message: 'Lagen och kartan har laddats in automatiskt i MatchZy på servern!'
      });
    }

    // Om en specifik karta valdes men någon spelare är helt ny (saknar SteamID64 i DB):
    if (map && map.startsWith('de_') && mode === 'load_match') {
      await rcon.send(`css_map ${map}`);
    }

    await rcon.end();
    return res.json({
      ok: true,
      method: 'chat_announce',
      message: allHaveSteamId
        ? 'Laguppställningen har skickats ut i CS2-chatten!'
        : 'Lagen har postats i CS2-chatten! (Någon spelare är ny och saknar SteamID i databasen för auto-flytt, men kommer registreras efter denna match).'
    });

  } catch (err) {
    if (rcon) try { await rcon.end(); } catch (e) {}
    console.error('RCON Push Error:', err);
    return res.status(500).json({ error: 'Kunde inte nå CS2-servern via RCON' });
  }
});

// 6. Demo Upload från MatchZy
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
