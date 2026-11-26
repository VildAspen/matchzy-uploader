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

const knownSteamIds = new Map();

// Konverterar SteamID64, Steam3 ([U:1:12345]) och Steam2 (STEAM_1:0:12345) till äkta 17-siffrigt SteamID64
function normalizeToSteamId64(rawId) {
  if (!rawId) return null;
  const str = String(rawId).trim();

  // Redan SteamID64
  if (/^7656\d{13}$/.test(str)) {
    return str;
  }

  // Steam3 format: [U:1:215989239]
  const steam3Match = str.match(/^\[?U:1:(\d+)\]?$/i);
  if (steam3Match) {
    const accountId = BigInt(steam3Match[1]);
    return (76561197960265728n + accountId).toString();
  }

  // Steam2 format: STEAM_1:1:107994619
  const steam2Match = str.match(/^STEAM_[01]:([01]):(\d+)$/i);
  if (steam2Match) {
    const y = BigInt(steam2Match[1]);
    const z = BigInt(steam2Match[2]);
    return (76561197960265728n + (z * 2n) + y).toString();
  }

  return null;
}

function isValidSteamId64(id) {
  return normalizeToSteamId64(id) !== null;
}

function rememberSteamId(name, rawId) {
  const normalized = normalizeToSteamId64(rawId);
  if (!name || !normalized) return;
  knownSteamIds.set(String(name).trim().toLowerCase(), normalized);
}

function resolveSteamId(name, candidateId) {
  const normalized = normalizeToSteamId64(candidateId);
  if (normalized) {
    if (name) rememberSteamId(name, normalized);
    return normalized;
  }
  if (name) {
    const cached = knownSteamIds.get(String(name).trim().toLowerCase());
    if (cached) return cached;
  }
  return 'unknown';
}

async function warmUpSteamIdCache() {
  try {
    const res = await pool.query(`
      SELECT steamid64, MAX(name) AS name
      FROM player_stats
      WHERE steamid64 ~ '^7656[0-9]{13}$'
      GROUP BY steamid64;
    `);
    for (const row of res.rows) {
      rememberSteamId(row.name, row.steamid64);
    }
    console.log(`[Cache] Laddade in ${knownSteamIds.size} kända SteamID64 från Supabase.`);
  } catch (err) {
    console.error('[Cache] Kunde inte förladda SteamID64:', err.message);
  }
}
warmUpSteamIdCache();

function parseCS2StatusJson(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') return null;

  const firstBrace = rawOutput.indexOf('{');
  const lastBrace = rawOutput.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    const jsonStr = rawOutput.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(jsonStr);
    const srv = parsed.server || parsed;

    const currentMap = srv.map || parsed.map || 'de_dust2';
    const rawClients = Array.isArray(srv.clients)
      ? srv.clients
      : (Array.isArray(parsed.clients) ? parsed.clients : []);

    const players = [];

    for (const c of rawClients) {
      if (!c || typeof c !== 'object') continue;
      if (c.bot === true || c.is_bot === true || c.fakeplayer === true) continue;

      const rawName = String(c.name || '').trim();
      if (!rawName || rawName === 'SourceTV' || rawName === 'GOTV') continue;

      const candidateSteamId = c.steamid64 || c.steam_id_64 || c.xuid || c.steamid;
      const steamid64 = resolveSteamId(rawName, candidateSteamId);

      const ping = parseInt(c.ping ?? 0, 10);
      const timeSeconds = parseInt(c.time ?? c.connected_time ?? 0, 10);

      players.push({
        name: rawName,
        steamid64: steamid64,
        ping: isNaN(ping) ? 0 : ping,
        time: isNaN(timeSeconds) ? 0 : timeSeconds
      });
    }

    return { currentMap, players };
  } catch (err) {
    return null;
  }
}

function parseCS2StatusText(rawText) {
  const players = [];
  const lines = (rawText || '').split('\n');
  let currentMap = 'de_dust2';

  const mapMatch = rawText.match(/Map\s*:\s*([^\s\r\n"]+)/i) ||
                   rawText.match(/Map\s+"([^"]+)"/i) ||
                   rawText.match(/spawngroup\(\s*1\)\s*:\s*SV:\s*\[\d+:\s*([^\s|]+)/i);
  if (mapMatch) {
    currentMap = mapMatch[1].trim();
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

      if (trimmed.includes('BOT') || trimmed.includes("'SourceTV'")) {
        continue;
      }

      const nameMatch = trimmed.match(/'([^']+)'/);
      if (nameMatch && /^\d+\s+/.test(trimmed)) {
        const name = nameMatch[1].trim();
        if (!name || name === 'SourceTV') continue;

        const tokens = trimmed.split(/\s+/);
        const timeStr = tokens[1] || '00:00';
        const ping = parseInt(tokens[2] || '0', 10);

        let totalSeconds = 0;
        if (timeStr.includes(':')) {
          const parts = timeStr.split(':').map(Number);
          if (parts.length === 2) totalSeconds = (parts[0] || 0) * 60 + (parts[1] || 0);
          if (parts.length === 3) totalSeconds = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
        }

        const steamMatch = trimmed.match(/\b(7656\d{13})\b/) || trimmed.match(/(\[U:1:\d+\])/);
        const steamid64 = resolveSteamId(name, steamMatch ? steamMatch[1] : null);

        players.push({
          name: name,
          steamid64: steamid64,
          ping: isNaN(ping) ? 0 : ping,
          time: totalSeconds
        });
      }
    }
  }

  return { currentMap, players };
}

// Extraherar spelare oavsett struktur i MatchZy-webhooken
function extractTeamPlayers(teamObj, teamName) {
  const list = [];
  if (!teamObj) return list;

  const rawPlayers = teamObj.players || teamObj.player_stats || teamObj.members;
  if (!rawPlayers) return list;

  if (Array.isArray(rawPlayers)) {
    for (const p of rawPlayers) {
      if (p && typeof p === 'object') {
        list.push({ ...p, team: teamName });
      }
    }
  } else if (typeof rawPlayers === 'object') {
    for (const [key, val] of Object.entries(rawPlayers)) {
      if (val && typeof val === 'object') {
        list.push({
          ...val,
          steamid: val.steamid || val.steamid64 || val.xuid || key,
          team: teamName
        });
      } else if (typeof val === 'string') {
        list.push({
          steamid: key,
          name: val,
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
  if (cachedStatus && (now - lastQueryTime < 2500)) {
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
        timeout: 2200
      });

      const jsonResponse = await rcon.send('status_json');
      let parsedData = parseCS2StatusJson(jsonResponse);
      let sourceMethod = 'rcon_status_json';

      if (!parsedData) {
        const textResponse = await rcon.send('status');
        parsedData = parseCS2StatusText(textResponse);
        sourceMethod = 'rcon_status_text';
      } else {
        parsedData.players = parsedData.players.map(p => ({
          ...p,
          steamid64: resolveSteamId(p.name, p.steamid64)
        }));
      }

      await rcon.end();

      cachedStatus = {
        online: true,
        name: "GubbLir",
        map: parsedData.currentMap,
        playerCount: parsedData.players.length,
        maxPlayers: 10,
        players: parsedData.players,
        source: sourceMethod
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
      maxAttempts: 1,
      socketTimeout: 1500
    });

    const parsedPlayers = (state.players || [])
      .filter(p => p.name && p.name.trim() !== '' && p.name !== 'SourceTV')
      .map(p => {
        const cleanName = p.name.trim();
        return {
          name: cleanName,
          steamid64: resolveSteamId(cleanName, null),
          time: p.raw?.time || 0
        };
      });

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
    return res.json(cachedStatus || {
      online: true,
      map: 'de_dust2',
      playerCount: 0,
      maxPlayers: 10,
      players: [],
      source: 'none'
    });
  }
});

// 2. Webhook för MatchZy
app.post('/matchzy', async (req, res) => {
  const data = req.body;

  if (!data || !data.event) {
    return res.status(200).send('OK');
  }

  if (data.event === 'player_connect') {
    const pName = data.player?.name || data.player_name;
    const pSteam = data.player?.steamid || data.player?.steamid64 || data.player_steamid;
    if (pName && pSteam) {
      rememberSteamId(pName, pSteam);
    }
    return res.status(200).send('OK');
  }

  if (Array.isArray(data.players)) {
    for (const p of data.players) {
      if (p && p.name && (p.steamid || p.steamid64)) {
        rememberSteamId(p.name, p.steamid || p.steamid64);
      }
    }
  }

  console.log(`[MatchZy Webhook] Event: ${data.event} | Payload:`, JSON.stringify(data).slice(0, 1200));

  if (data.event === 'map_result') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const mapNum = data.map_number !== undefined ? `_${data.map_number}` : '';
      const matchId = String(data.matchid ? `${data.matchid}${mapNum}` : `match_${Date.now()}`);
      
      // Hämta kartnamn oavsett nyckelformat i MatchZy + fallback på live-serverns karta
      const resolvedMap =
        data.map_name ||
        data.mapname ||
        (typeof data.map === 'string' ? data.map : data.map?.name) ||
        cachedStatus?.map ||
        'de_dust2';

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
      `, [matchId, resolvedMap, team1Name, team1Score, team2Name, team2Score, winner]);

      const players = [
        ...extractTeamPlayers(data.team1, team1Name),
        ...extractTeamPlayers(data.team2, team2Name)
      ];

      if (players.length > 0) {
        await client.query('DELETE FROM player_stats WHERE match_id = $1;', [matchId]);
      }

      for (const p of players) {
        const name = String(p.name || 'Gubbe').trim();
        const rawCandidate = p.steamid || p.steamid64 || p.xuid || p.id;
        const steamId = resolveSteamId(name, rawCandidate);
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
      console.log(`[MatchZy Webhook] Sparade match ${matchId} (${resolvedMap} ${team1Score}-${team2Score}) och ${players.length} spelare!`);
    } catch (dbErr) {
      await client.query('ROLLBACK');
      console.error('[MatchZy Webhook] Databasfel vid sparande:', dbErr);
    } finally {
      client.release();
    }
  }

  return res.status(200).send('OK');
});

// 3. Topplista (Grupperar på SteamID64, med fallback på spelarnamn så ingen någonsin döljs)
app.get('/api/stats/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COALESCE(NULLIF(ps.steamid64, 'unknown'), ps.name) AS steamid64,
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
      GROUP BY COALESCE(NULLIF(ps.steamid64, 'unknown'), ps.name)
      ORDER BY kd_ratio DESC NULLS LAST, total_kills DESC
      LIMIT 100;
    `);

    const enriched = result.rows.map(row => {
      rememberSteamId(row.name, row.steamid64);

      const matches = row.matches_played || 0;
      const kd = parseFloat(row.kd_ratio || 1.0);
      const adr = parseFloat(row.adr || 75.0);
      const winRate = parseFloat(row.win_rate ?? 50.0);

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

// 4. MatchZy Dynamic Config Endpoint
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
    return res.status(403).json({ error: 'Ogiltigt medlemslösenord (logga ut och in igen på hemsidan)' });
  }

  const rconPassword = process.env.RCON_PASSWORD;
  if (!rconPassword) {
    return res.status(500).json({ error: 'RCON_PASSWORD saknas under Environment på Render!' });
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
      timeout: 4000
    });

    try {
      const liveJson = await rcon.send('status_json');
      parseCS2StatusJson(liveJson);
    } catch (e) {}

    const resolvedCT = teamCT.map(p => ({
      ...p,
      steamid64: resolveSteamId(p.name, p.steamid64)
    }));
    const resolvedT = teamT.map(p => ({
      ...p,
      steamid64: resolveSteamId(p.name, p.steamid64)
    }));

    const ctNames = resolvedCT.map(p => p.name).join(', ');
    const tNames = resolvedT.map(p => p.name).join(', ');

    await rcon.send(`say "=== [GubbLir Lagbalanserare] ==="`);
    await rcon.send(`say "LAG CT: ${ctNames}"`);
    await rcon.send(`say "LAG T: ${tNames}"`);

    const allPlayers = [...resolvedCT, ...resolvedT];
    const allHaveSteamId = allPlayers.length >= 2 && allPlayers.every(p => isValidSteamId64(p.steamid64));

    if (mode === 'load_match' && allHaveSteamId) {
      const ctPlayersObj = {};
      resolvedCT.forEach(p => { ctPlayersObj[String(p.steamid64)] = p.name; });

      const tPlayersObj = {};
      resolvedT.forEach(p => { tPlayersObj[String(p.steamid64)] = p.name; });

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
        players_per_team: Math.max(resolvedCT.length, resolvedT.length)
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

    if (map && map.startsWith('de_') && mode === 'load_match') {
      await rcon.send(`css_map ${map}`);
    }

    await rcon.end();
    return res.json({
      ok: true,
      method: 'chat_announce',
      message: allHaveSteamId
        ? 'Laguppställningen har postats i CS2-chatten!'
        : 'Lagen postades i CS2-chatten! (Minst en spelare är inte inne på servern än och saknar känt SteamID64).'
    });

  } catch (err) {
    if (rcon) try { await rcon.end(); } catch (e) {}
    console.error('RCON Push Error:', err);
    return res.status(500).json({ error: `RCON-fel: ${err.message || 'Kunde inte ansluta till CS2-servern'}` });
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
