'use strict';
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = parseInt(process.env.PORT, 10) || 3000;
const STATE_KEY = 'primary';

// ═══════════════════════════════════════════════
//  AUTH  (password from env, no extra packages)
// ═══════════════════════════════════════════════
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cricket123';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const AUTH_COOKIE   = 'cric_auth';

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  });
  return out;
}

function makeToken() {
  return crypto.createHmac('sha256', SESSION_SECRET).update('authenticated').digest('hex');
}

function isAuth(req) {
  return parseCookies(req)[AUTH_COOKIE] === makeToken();
}

function requireAuth(req, res, next) {
  if (isAuth(req)) return next();
  if (req.path.startsWith('/api') || req.headers['content-type'] === 'application/json') {
    return res.status(401).json({ error: 'Unauthorized — please log in at /login' });
  }
  res.redirect('/login');
}


function makeCookie(req) {
  const maxAge = 60 * 60 * 24 * 7;
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${AUTH_COOKIE}=${makeToken()}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ═══════════════════════════════════════════════
//  MIDDLEWARE & ROUTING
// ═══════════════════════════════════════════════
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Public: login page
app.get('/login', (req, res) => {
  if (isAuth(req)) return res.redirect('/admin/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie', makeCookie(req));
    return res.redirect('/admin/');
  }
  res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
  res.redirect('/login');
});

// Public: OBS overlay files (no auth — OBS browser sources have no cookies)
app.use('/overlays', express.static(path.join(__dirname, 'public', 'overlays')));

// Root → login or admin
app.get('/', (req, res) => res.redirect(isAuth(req) ? '/admin/' : '/login'));
app.get('/healthz', (_, res) => res.status(200).send('ok'));

// Protected: admin panel + all API
app.use('/admin', requireAuth, express.static(path.join(__dirname, 'public', 'admin')));
app.use('/api', (req, res, next) => {
  if (isAuth(req)) return next();
  res.status(401).json({ error: 'Unauthorized — please log in at /login' });
});

// ═══════════════════════════════════════════════
//  INITIAL STATE TEMPLATE
// ═══════════════════════════════════════════════
function freshState() {
  return {
    status: 'setup',   // setup | live | innings_break | complete
    match: {
      team1: { name: '', shortName: 'T1', color: '#00e5ff', players: [] },
      team2: { name: '', shortName: 'T2', color: '#ff4081', players: [] },
      overs: 20,
      playersPerSide: 11,
      toss: { winner: null, decision: null },
      venue: '',
      date: new Date().toLocaleDateString('en-GB'),
      style: 'big_bash',   // big_bash | classic | ipl | minimal
      activeOverlay: 'toss'
    },
    currentInnings: 0,
    innings: []
  };
}

function freshInnings(battingTeamKey, bowlingTeamKey, target) {
  return {
    battingTeamKey, bowlingTeamKey,
    target: target || null,
    score: 0, wickets: 0,
    oversCompleted: 0, currentOverBalls: 0,
    extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
    batsmen: [],
    onStrike: null, onNonStrike: null,
    xi: [],
    nextBatIndex: 2,
    bowlers: [],
    currentBowler: null,
    partnerships: [],
    currentPartnership: { runs: 0, balls: 0, bat1: null, bat2: null },
    overHistory: [],
    currentOverBallHistory: [],
    fallOfWickets: [],
    needsBowlerChange: false,
    needsNextBatsman: false,
    outPosition: null,       // 'striker' | 'nonstriker' — which crease is vacant
    undoStack: []
  };
}

// ═══════════════════════════════════════════════
//  DATABASE PERSISTENCE (Render Postgres ready)
// ═══════════════════════════════════════════════
const DATABASE_URL = process.env.DATABASE_URL || '';
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false
    })
  : null;

function shouldUseSsl(connectionString) {
  if (!connectionString) return false;
  if (connectionString.includes('localhost') || connectionString.includes('127.0.0.1')) return false;
  if (connectionString.includes('sslmode=disable')) return false;
  return true;
}

async function ensureDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_state (
      state_key TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadState() {
  if (!pool) return freshState();
  try {
    const { rows } = await pool.query('SELECT state FROM match_state WHERE state_key = $1 LIMIT 1', [STATE_KEY]);
    if (rows.length && rows[0].state) {
      const saved = rows[0].state;
      const validOverlays = ['toss','teamsheet','lower-third','scorecard','batsmen','bowling','partnerships','chase','summary','runrate','celebrations','master'];
      if (!validOverlays.includes(saved.match?.activeOverlay) && saved.match) saved.match.activeOverlay = 'toss';
      return saved;
    }
    const initialState = freshState();
    await saveState(initialState);
    return initialState;
  } catch (error) {
    console.error('⚠ Could not load saved state from database, starting fresh.', error.message);
    return freshState();
  }
}

async function saveState(state) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO match_state (state_key, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (state_key)
     DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
    [STATE_KEY, JSON.stringify(state)]
  );
}

let persistChain = Promise.resolve();
function queuePersist() {
  const snapshot = JSON.parse(JSON.stringify(S));
  persistChain = persistChain
    .then(() => saveState(snapshot))
    .catch(error => console.error('⚠ Could not persist match state.', error.message));
  return persistChain;
}

let S = freshState();

function broadcast() {
  void queuePersist();
  const msg = JSON.stringify({ type: 'state', payload: S });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function broadcastEvent(kind, data) {
  const msg = JSON.stringify({ type: 'event', payload: { kind, ...(data||{}) } });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ═══════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════
const curInn = () => S.innings[S.currentInnings - 1];

function getPlayer(teamKey, id) {
  return (S.match[teamKey]?.players || []).find(p => p.id === id);
}
function getBat(id) { return curInn()?.batsmen.find(b => b.id === id); }
function getBowl(id) { return curInn()?.bowlers.find(b => b.id === id); }

function oversStr(done, balls) { return `${done}.${balls}`; }

function computeCRR(inn) {
  const balls = inn.oversCompleted * 6 + inn.currentOverBalls;
  if (!balls) return '0.00';
  return (inn.score / balls * 6).toFixed(2);
}

function computeRRR(inn) {
  if (!inn.target) return null;
  const maxBalls = S.match.overs * 6;
  const ballsBowled = inn.oversCompleted * 6 + inn.currentOverBalls;
  const ballsLeft = maxBalls - ballsBowled;
  const needed = inn.target - inn.score;
  if (ballsLeft <= 0 || needed <= 0) return null;
  return (needed / ballsLeft * 6).toFixed(2);
}

function dismissalText(dismissal, allPlayers) {
  if (!dismissal) return 'not out';
  const how = dismissal.how;
  const bowler = allPlayers.find(p => p.id === dismissal.bowlerId)?.name || '';
  const fielder = allPlayers.find(p => p.id === dismissal.fielderId)?.name || '';
  const map = {
    'bowled': `b ${bowler}`,
    'caught': `c ${fielder} b ${bowler}`,
    'lbw': `lbw b ${bowler}`,
    'runout': `run out (${fielder})`,
    'stumped': `st ${fielder} b ${bowler}`,
    'hitwicket': `hit wicket b ${bowler}`,
    'obstructing': 'obstructing the field',
    'handled': 'handled the ball',
    'timedout': 'timed out'
  };
  return map[how] || how;
}

// ═══════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'state', payload: S }));
});

// ═══════════════════════════════════════════════
//  REST API
// ═══════════════════════════════════════════════

app.get('/api/state', (_, res) => res.json(S));

// Reset everything
app.post('/api/reset', (_, res) => {
  S = freshState();
  broadcast();
  res.json({ ok: true });
});

// Match setup (teams, overs, venue)
app.post('/api/setup', (req, res) => {
  const { team1Name, team1Short, team1Color, team2Name, team2Short, team2Color, overs, playersPerSide, venue } = req.body;
  const m = S.match;
  m.team1.name = team1Name || 'Team 1';
  m.team1.shortName = (team1Short || 'T1').substring(0, 5).toUpperCase();
  m.team1.color = team1Color || '#00e5ff';
  m.team2.name = team2Name || 'Team 2';
  m.team2.shortName = (team2Short || 'T2').substring(0, 5).toUpperCase();
  m.team2.color = team2Color || '#ff4081';
  m.overs = Math.max(1, parseInt(overs) || 20);
  m.playersPerSide = Math.max(2, parseInt(playersPerSide) || 11);
  m.venue = venue || '';
  broadcast();
  res.json({ ok: true });
});

// Set players for a team
app.post('/api/players', (req, res) => {
  const { teamKey, players } = req.body;
  if (!['team1', 'team2'].includes(teamKey)) return res.status(400).json({ error: 'Invalid team' });
  S.match[teamKey].players = (players || []).map((p, i) => ({
    id: p.id || (teamKey === 'team1' ? i + 1 : i + 101),
    name: String(p.name || `Player ${i + 1}`).trim(),
    isCaptain: !!p.isCaptain,
    isWK: !!p.isWK
  }));
  broadcast();
  res.json({ ok: true });
});

// Set toss result
app.post('/api/toss', (req, res) => {
  const { winner, decision } = req.body;
  if (!['team1', 'team2'].includes(winner)) return res.status(400).json({ error: 'Invalid toss winner' });
  if (!['bat', 'field'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
  S.match.toss = { winner, decision };
  broadcast();
  res.json({ ok: true });
});

// Start innings
app.post('/api/innings/start', (req, res) => {
  const { striker, nonStriker, bowler, xi } = req.body;
  if (!striker || !nonStriker || !bowler) return res.status(400).json({ error: 'Missing required fields' });

  let battingTeam, bowlingTeam;
  if (S.currentInnings === 0) {
    const { winner, decision } = S.match.toss;
    if (winner) {
      battingTeam = (decision === 'bat') ? winner : (winner === 'team1' ? 'team2' : 'team1');
      bowlingTeam = (battingTeam === 'team1') ? 'team2' : 'team1';
    } else {
      battingTeam = 'team1'; bowlingTeam = 'team2';
    }
  } else {
    battingTeam = S.innings[0].bowlingTeamKey;
    bowlingTeam = S.innings[0].battingTeamKey;
  }

  const target = S.currentInnings === 1 ? S.innings[0].score + 1 : null;
  const inn = freshInnings(battingTeam, bowlingTeam, target);
  inn.xi = Array.isArray(xi) ? xi : [];
  inn.onStrike = striker;
  inn.onNonStrike = nonStriker;
  inn.currentBowler = bowler;
  inn.currentPartnership = { runs: 0, balls: 0, bat1: striker, bat2: nonStriker };

  // Add opening batsmen
  [striker, nonStriker].forEach(id => {
    const p = getPlayer(battingTeam, id);
    if (p) inn.batsmen.push({ id, name: p.name, runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false, dismissal: null });
  });

  // Add first bowler
  const bowlP = getPlayer(bowlingTeam, bowler);
  if (bowlP) inn.bowlers.push({ id: bowler, name: bowlP.name, legalBalls: 0, runs: 0, wickets: 0, wides: 0, noBalls: 0, maidens: 0 });

  S.innings.push(inn);
  S.currentInnings++;
  S.status = 'live';
  broadcast();
  res.json({ ok: true });
});

// Set/change bowler
app.post('/api/bowler', (req, res) => {
  const { bowlerId } = req.body;
  const inn = curInn();
  if (!inn) return res.status(400).json({ error: 'No active innings' });

  inn.currentBowler = bowlerId;
  inn.needsBowlerChange = false;

  if (!inn.bowlers.find(b => b.id === bowlerId)) {
    const p = getPlayer(inn.bowlingTeamKey, bowlerId);
    if (p) inn.bowlers.push({ id: bowlerId, name: p.name, legalBalls: 0, runs: 0, wickets: 0, wides: 0, noBalls: 0, maidens: 0 });
  }

  S.status = 'live';
  broadcast();
  res.json({ ok: true });
});

// ───────────────────────────────────────────────
//  RECORD A BALL  (core of the system)
// ───────────────────────────────────────────────
app.post('/api/ball', (req, res) => {
  if (S.status !== 'live') return res.status(400).json({ error: `Cannot record ball in status: ${S.status}` });

  const { type = 'normal', runs = 0, isWicket = false,
          wicketHow, wicketBatsmanId, wicketBowlerId, wicketFielderId } = req.body;

  const inn = curInn();
  if (!inn) return res.status(400).json({ error: 'No active innings' });
  if (!inn.currentBowler) return res.status(400).json({ error: 'No bowler set' });
  if (inn.needsNextBatsman) return res.status(400).json({ error: 'Select the incoming batsman first' });

  // ── Snapshot for undo ──────────────────────
  const snap = JSON.parse(JSON.stringify(inn));
  delete snap.undoStack;
  inn.undoStack.push(snap);
  if (inn.undoStack.length > 60) inn.undoStack.shift();

  // ── Run accounting ─────────────────────────
  const r = parseInt(runs) || 0;
  const isLegal = type !== 'wide' && type !== 'noball';
  let batsmanRuns = 0, bowlerCharged = 0, extraRuns = 0, totalRuns = 0;

  switch (type) {
    case 'normal':  batsmanRuns = r; bowlerCharged = r; totalRuns = r; break;
    case 'noball':  batsmanRuns = r; bowlerCharged = 1 + r; extraRuns = 1; totalRuns = 1 + r; inn.extras.noBalls++; break;
    case 'wide':    batsmanRuns = 0; bowlerCharged = 1 + r; extraRuns = 1 + r; totalRuns = 1 + r; inn.extras.wides += 1 + r; break;
    case 'bye':     batsmanRuns = 0; bowlerCharged = 0; extraRuns = r; totalRuns = r; inn.extras.byes += r; break;
    case 'legbye':  batsmanRuns = 0; bowlerCharged = 0; extraRuns = r; totalRuns = r; inn.extras.legByes += r; break;
  }

  inn.score += totalRuns;

  // ── Batsman ────────────────────────────────
  const striker = getBat(inn.onStrike);
  if (striker) {
    if (isLegal) striker.balls++;
    striker.runs += batsmanRuns;
    if (batsmanRuns === 4) striker.fours++;
    if (batsmanRuns === 6) striker.sixes++;
  }

  // ── Bowler ─────────────────────────────────
  const bowler = getBowl(inn.currentBowler);
  if (bowler) {
    if (isLegal) bowler.legalBalls++;
    bowler.runs += bowlerCharged;
    if (type === 'wide') bowler.wides++;
    if (type === 'noball') bowler.noBalls++;
  }

  // ── Partnership ────────────────────────────
  inn.currentPartnership.runs += totalRuns;
  if (isLegal) inn.currentPartnership.balls++;

  // ── Ball display label ─────────────────────
  let display = String(r);
  if (isWicket) display = 'W';
  else if (type === 'wide') display = r > 0 ? `Wd+${r}` : 'Wd';
  else if (type === 'noball') display = r > 0 ? `Nb+${r}` : 'Nb';
  else if (type === 'bye') display = `${r}b`;
  else if (type === 'legbye') display = `${r}lb`;

  inn.currentOverBallHistory.push({
    type, runs: r, batsmanRuns, bowlerCharged, extraRuns, totalRuns, isWicket, display
  });

  // ── Wicket ─────────────────────────────────
  if (isWicket) {
    const outId = wicketBatsmanId || inn.onStrike;
    const outBat = getBat(outId);
    if (outBat) {
      outBat.isOut = true;
      outBat.dismissal = {
        how: wicketHow,
        bowlerId: wicketBowlerId || inn.currentBowler,
        fielderId: wicketFielderId || null
      };
    }
    inn.wickets++;

    const noBowlerW = ['runout', 'obstructing', 'handled', 'timedout'];
    if (bowler && !noBowlerW.includes(wicketHow)) bowler.wickets++;

    inn.fallOfWickets.push({
      n: inn.wickets, score: inn.score,
      over: oversStr(inn.oversCompleted, inn.currentOverBalls),
      batsmanId: outId, name: outBat?.name || ''
    });

    // Save current partnership
    inn.partnerships.push({ ...inn.currentPartnership });

    // Flag that we need the scorer to pick the next batsman
    // (only when wickets remain — last wicket ends the innings anyway)
    const maxWicketsCheck = S.match.playersPerSide - 1;
    if (inn.wickets < maxWicketsCheck) {
      inn.needsNextBatsman = true;
      inn.outPosition = (outId === inn.onStrike) ? 'striker' : 'nonstriker';
      // Temporarily clear the vacant crease so overlays don't show stale name
      if (outId === inn.onStrike) inn.onStrike = null;
      else inn.onNonStrike = null;
    }

    inn.currentPartnership = { runs: 0, balls: 0, bat1: inn.onStrike, bat2: inn.onNonStrike };
  }

  // ── Strike rotation ────────────────────────
  if (!isWicket) {
    const rotRuns = (type === 'wide' || type === 'noball') ? r : (type === 'bye' || type === 'legbye') ? r : batsmanRuns;
    if (rotRuns % 2 !== 0) [inn.onStrike, inn.onNonStrike] = [inn.onNonStrike, inn.onStrike];
  }

  // ── Legal delivery / over complete ─────────
  if (isLegal) {
    inn.currentOverBalls++;

    if (inn.currentOverBalls === 6) {
      const overTotal = inn.currentOverBallHistory.reduce((s, b) => s + b.totalRuns, 0);
      if (bowler && overTotal === 0) bowler.maidens++;

      inn.overHistory.push({
        n: inn.oversCompleted + 1,
        bowlerId: inn.currentBowler,
        balls: [...inn.currentOverBallHistory],
        total: overTotal
      });

      inn.currentOverBallHistory = [];
      inn.currentOverBalls = 0;
      inn.oversCompleted++;
      inn.currentBowler = null;
      inn.needsBowlerChange = true;
      [inn.onStrike, inn.onNonStrike] = [inn.onNonStrike, inn.onStrike];

      // If a wicket is still pending confirmation, the over-end rotation may have
      // moved the vacant crease to the other end — update outPosition accordingly.
      if (inn.needsNextBatsman) {
        inn.outPosition = inn.onStrike === null ? 'striker' : 'nonstriker';
      }
    }
  }

  // ── Check end conditions ───────────────────
  const maxWickets = S.match.playersPerSide - 1;
  const allOut = inn.wickets >= maxWickets;
  const oversUp = inn.oversCompleted >= S.match.overs;
  const won = inn.target && inn.score >= inn.target;

  if (won) {
    S.status = 'complete';
  } else if ((allOut || oversUp) && S.currentInnings === 1) {
    S.status = 'innings_break';
  } else if ((allOut || oversUp) && S.currentInnings === 2) {
    S.status = 'complete';
  }
  // else stays 'live' (needsBowlerChange flag handled by UI)

  broadcast();
  // Fire notable event so celebration overlay can react
  if (isWicket) {
    const outBat = getBat(wicketBatsmanId || curInn().onStrike);
    broadcastEvent('wicket', { batsmanName: outBat?.name || '', how: wicketHow });
  } else if (batsmanRuns === 6) {
    const striker = getBat(curInn().onStrike);
    broadcastEvent('six', { batsmanName: striker?.name || '', runs: 6 });
  } else if (batsmanRuns === 4) {
    const striker = getBat(curInn().onStrike);
    broadcastEvent('four', { batsmanName: striker?.name || '', runs: 4 });
  }
  res.json({ ok: true, state: S });
});

// Undo last ball
app.post('/api/undo', (_, res) => {
  const inn = curInn();
  if (!inn || !inn.undoStack.length) return res.status(400).json({ error: 'Nothing to undo' });

  const prev = inn.undoStack.pop();
  Object.assign(inn, prev);
  inn.undoStack = inn.undoStack || [];
  S.status = 'live';
  broadcast();
  res.json({ ok: true });
});

// End innings manually
app.post('/api/innings/end', (_, res) => {
  S.status = S.currentInnings === 1 ? 'innings_break' : 'complete';
  broadcast();
  res.json({ ok: true });
});

// Manually set batsman position
app.post('/api/batsman', (req, res) => {
  const { batsmanId, position } = req.body;
  const inn = curInn();
  if (!inn) return res.status(400).json({ error: 'No innings' });

  if (!inn.batsmen.find(b => b.id === batsmanId)) {
    const p = getPlayer(inn.battingTeamKey, batsmanId);
    if (p) inn.batsmen.push({ id: batsmanId, name: p.name, runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false, dismissal: null });
  }

  if (position === 'striker') inn.onStrike = batsmanId;
  else inn.onNonStrike = batsmanId;

  broadcast();
  res.json({ ok: true });
});

// Select the incoming batsman after a wicket
app.post('/api/next-batsman', (req, res) => {
  const { batsmanId } = req.body;
  const inn = curInn();
  if (!inn) return res.status(400).json({ error: 'No innings' });
  if (!inn.needsNextBatsman) return res.status(400).json({ error: 'No batsman selection pending' });

  const id = parseInt(batsmanId);
  const p = getPlayer(inn.battingTeamKey, id);
  if (!p) return res.status(400).json({ error: 'Player not found' });
  if (inn.batsmen.find(b => b.id === id)) return res.status(400).json({ error: 'Player already batted' });

  inn.batsmen.push({ id, name: p.name, runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false, dismissal: null });

  if (inn.outPosition === 'striker') inn.onStrike = id;
  else inn.onNonStrike = id;

  inn.needsNextBatsman = false;
  inn.outPosition = null;
  inn.currentPartnership = { runs: 0, balls: 0, bat1: inn.onStrike, bat2: inn.onNonStrike };

  broadcast();
  res.json({ ok: true });
});

// Swap striker and non-striker
app.post('/api/swap-batsmen', (_, res) => {
  const inn = curInn();
  if (!inn) return res.status(400).json({ error: 'No innings' });
  [inn.onStrike, inn.onNonStrike] = [inn.onNonStrike, inn.onStrike];
  inn.currentPartnership.bat1 = inn.onStrike;
  inn.currentPartnership.bat2 = inn.onNonStrike;
  broadcast();
  res.json({ ok: true });
});

// Set overlay style theme
app.post('/api/style', (req, res) => {
  const { style } = req.body;
  const valid = ['big_bash', 'classic', 'ipl', 'minimal'];
  if (!valid.includes(style)) return res.status(400).json({ error: 'Invalid style' });
  S.match.style = style;
  broadcast();
  res.json({ ok: true });
});

// Switch active overlay on master overlay
app.post('/api/overlay', (req, res) => {
  const { name } = req.body;
  const valid = ['toss','teamsheet','lower-third','scorecard','batsmen','bowling','partnerships','chase','summary'];
  if (!valid.includes(name)) return res.status(400).json({ error: 'Invalid overlay name' });
  S.match.activeOverlay = name;
  broadcast();
  res.json({ ok: true });
});

// Get computed stats (for graphs etc.)
app.get('/api/stats', (_, res) => {
  if (!S.innings.length) return res.json({ runs_per_over: [] });

  const inn = curInn();
  const runsPerOver = inn.overHistory.map(o => ({ over: o.n, runs: o.total }));

  // Add current incomplete over
  if (inn.currentOverBalls > 0) {
    const cur = inn.currentOverBallHistory.reduce((s, b) => s + b.totalRuns, 0);
    runsPerOver.push({ over: inn.oversCompleted + 1, runs: cur, partial: true });
  }

  res.json({
    runs_per_over: runsPerOver,
    crr: computeCRR(inn),
    rrr: computeRRR(inn),
    partnerships: inn.partnerships,
    fall_of_wickets: inn.fallOfWickets
  });
});

// ═══════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════
async function start() {
  try {
    await ensureDb();
    S = await loadState();
    server.listen(PORT, () => {
      console.log('\n╔══════════════════════════════════════════════╗');
      console.log('║      🏏  CRICKET SCORER  — SERVER READY      ║');
      console.log('╠══════════════════════════════════════════════╣');
      console.log(`║  Admin Panel:  http://localhost:${PORT}/admin/        ║`);
      console.log('╠══════════════════════════════════════════════╣');
      console.log('║  OBS Browser Source URLs:                    ║');
      console.log(`║  /overlays/lower-third.html                  ║`);
      console.log(`║  /overlays/scorecard.html                    ║`);
      console.log(`║  /overlays/batsmen.html                      ║`);
      console.log(`║  /overlays/bowling.html                      ║`);
      console.log(`║  /overlays/runrate.html                      ║`);
      console.log(`║  /overlays/partnerships.html                 ║`);
      console.log(`║  /overlays/teamsheet.html                    ║`);
      console.log(`║  /overlays/chase.html        (2nd innings)   ║`);
      console.log(`║  /overlays/celebrations.html (events)        ║`);
      console.log(`║  /overlays/summary.html      (end of match)  ║`);
      console.log('╚══════════════════════════════════════════════╝\n');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
