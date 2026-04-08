const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'strix-super-secret-2026-change-in-prod';
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || '*';

const io = new Server(server, {
  cors: { origin: FRONTEND_URL, methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 10000
});

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE (JSON file) ──────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'users.json');
const STATS_PATH = path.join(__dirname, 'data', 'site_stats.json');

function readDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      fs.writeFileSync(DB_PATH, JSON.stringify({ users: [] }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) { return { users: [] }; }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function readStats() {
  try {
    if (!fs.existsSync(STATS_PATH)) {
      const init = { totalWagered: 0, totalRaces: 0, activePlayers: 0, biggestWin: 0, biggestWinner: '' };
      fs.writeFileSync(STATS_PATH, JSON.stringify(init, null, 2));
      return init;
    }
    return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
  } catch (e) { return { totalWagered: 0, totalRaces: 0, activePlayers: 0, biggestWin: 0, biggestWinner: '' }; }
}

function writeStats(data) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(data, null, 2));
}

// ── AUTH ROUTES ───────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3–20 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username: letters, numbers, underscores only' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const db = readDB();
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
    return res.status(400).json({ error: 'Username already taken' });

  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(), username, password: hash,
    balance: 1000.00,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    stats: {
      racesPlayed: 0, racesWon: 0,
      totalWagered: 0, totalWon: 0,
      biggestWin: 0, biggestLoss: 0,
      winStreak: 0, currentStreak: 0
    }
  };
  db.users.push(user);
  writeDB(db);

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username, balance: user.balance, stats: user.stats });
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(400).json({ error: 'Invalid username or password' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: 'Invalid username or password' });

  user.lastSeen = new Date().toISOString();
  writeDB(db);

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username, balance: user.balance, stats: user.stats });
});

app.get('/api/leaderboard', (req, res) => {
  const db = readDB();
  const top = [...db.users]
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 20)
    .map(u => ({
      username: u.username, balance: u.balance,
      racesPlayed: u.stats.racesPlayed, racesWon: u.stats.racesWon,
      biggestWin: u.stats.biggestWin, totalWagered: u.stats.totalWagered,
      winRate: u.stats.racesPlayed > 0 ? ((u.stats.racesWon / u.stats.racesPlayed) * 100).toFixed(1) : '0.0'
    }));
  res.json(top);
});

app.get('/api/stats', (req, res) => {
  const s = readStats();
  const db = readDB();
  res.json({ ...s, totalUsers: db.users.length });
});

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch (e) { return null; }
}

// ── RACE PHYSICS ──────────────────────────────────────────────
const VBASE = 0.0020;
const AI_MIN = 0.002, AI_MAX = 0.008;
const PHI_MAX = Math.PI / 12;
const BI_MIN = -0.001, BI_MAX = 0.003;
const ALPHA_MIN = 0.008, ALPHA_MAX = 0.015;
const BETA_MIN = 0.00001, BETA_MAX = 0.00003;
const TSPRINT = 0.75, SIGMA = 0.6;
const PACK_TIGHTNESS = 0.09, PACK_END_FRACTION = 0.4;
const RANDOMNESS = 0.005;
const RACE_DISTS = { sprint: 4, distance: 14.0, derby: 27.5 };
const RACE_LABELS = { sprint: '400m Sprint', distance: '1600m Distance', derby: '2400m Grand Derby' };

const betTypeOddsBase = {
  win:     { base: 1.5, spread: 5.0 },
  top3:    { base: 1.1, spread: 2.2 },
  fastest: { base: 1.8, spread: 6.5 },
  draw:    { base: 1.2, spread: 3.0 }
};

function rng(min, max) { return min + Math.random() * (max - min); }

function createHorse(index, total) {
  return {
    x: 0.1, lane: (index + 1) / (total + 1),
    V0: VBASE * (1 + rng(-0.01, 0.01)),
    ai: rng(AI_MIN, AI_MAX), phi: rng(0, PHI_MAX),
    bi: rng(BI_MIN, BI_MAX), alpha: rng(ALPHA_MIN, ALPHA_MAX),
    beta: rng(BETA_MIN, BETA_MAX),
    tsprint: TSPRINT, sigma: SIGMA,
    speed: 0, maxSpeed: 0,
    oddsWin: 1, oddsTop3: 1, oddsFastest: 1, oddsDraw: 1
  };
}

function computeSpeed(h, tNorm) {
  const si = h.ai * Math.sin(Math.PI * tNorm + h.phi) + h.bi * tNorm;
  const fs = 1 - h.alpha * tNorm;
  const fe = 1 + h.beta * Math.exp(-Math.pow(tNorm - h.tsprint, 2) / (2 * h.sigma * h.sigma));
  return h.V0 * (1 + si) * fs * fe;
}

function calculateOdds(horses) {
  const strengths = horses.map(h => {
    const speed = h.V0 * 100000;
    const fatigue = (h.alpha - ALPHA_MIN) / (ALPHA_MAX - ALPHA_MIN);
    const boost = (h.beta - BETA_MIN) / (BETA_MAX - BETA_MIN);
    const tactical = (h.bi - BI_MIN) / (BI_MAX - BI_MIN);
    return speed * 0.4 + boost * 100 * 0.2 + tactical * 100 * 0.2 + (1 - fatigue) * 100 * 0.2;
  });
  const speedScores = horses.map(h => {
    const speed = h.V0 * 100000; const boost = (h.beta - BETA_MIN) / (BETA_MAX - BETA_MIN);
    return speed * 0.7 + boost * 100 * 0.3;
  });
  function computeSet(scores, cfg) {
    const max = Math.max(...scores), min = Math.min(...scores), range = max - min || 1;
    return scores.map(s => parseFloat(Math.max(1.05, cfg.base + (1 - (s - min) / range) * cfg.spread + (Math.random() - 0.5) * 0.3).toFixed(2)));
  }
  const wO = computeSet(strengths, betTypeOddsBase.win);
  const t3O = computeSet(strengths, betTypeOddsBase.top3);
  const fO = computeSet(speedScores, betTypeOddsBase.fastest);
  const dO = computeSet(strengths, betTypeOddsBase.draw);
  horses.forEach((h, i) => { h.oddsWin = wO[i]; h.oddsTop3 = t3O[i]; h.oddsFastest = fO[i]; h.oddsDraw = dO[i]; });
}

function getOdds(h, type) {
  return { win: h.oddsWin, top3: h.oddsTop3, fastest: h.oddsFastest, draw: h.oddsDraw }[type] || h.oddsWin;
}

// ── RACE ROOMS ────────────────────────────────────────────────
const MAX_RACES = 5;
const BETTING_WINDOW = 60000;  // 60 seconds for multi-player
const CANCEL_WINDOW = 5000;    // 5 second cancel period
const RESULTS_SHOW = 10000;    // show results for 10s before reset
const TICK_INTERVAL = 50;      // ms between server ticks (20fps)

const races = {};
const recentResults = []; // global feed

function createRaceRoom(id) {
  const types = ['sprint', 'distance', 'derby'];
  const raceType = types[Math.floor(Math.random() * types.length)];
  const count = raceType === 'sprint' ? 6 : 14;
  const horses = Array.from({ length: count }, (_, i) => createHorse(i, count));
  calculateOdds(horses);
  const raceDist = RACE_DISTS[raceType];
  return {
    id, raceType, state: 'open', horses, raceDist,
    finishX: 0.1 + raceDist,
    players: {},       // socketId -> player data
    betTimer: null, cancelTimer: null, tickTimer: null, resultTimer: null,
    startTime: null, raceCount: 0, bettingStartedAt: null,
    bettingTimeLeft: 0
  };
}

for (let i = 1; i <= MAX_RACES; i++) races[i] = createRaceRoom(i);

function publicRace(race) {
  return {
    id: race.id, state: race.state, raceType: race.raceType,
    raceLabel: RACE_LABELS[race.raceType],
    horses: race.horses.map((h, i) => ({
      index: i, x: h.x, lane: h.lane, speed: h.speed, maxSpeed: h.maxSpeed,
      oddsWin: h.oddsWin, oddsTop3: h.oddsTop3, oddsFastest: h.oddsFastest, oddsDraw: h.oddsDraw,
      V0: h.V0, ai: h.ai, phi: h.phi, bi: h.bi, alpha: h.alpha, beta: h.beta,
      tsprint: h.tsprint, sigma: h.sigma
    })),
    players: Object.values(race.players).map(p => ({
      username: p.username, hasBet: p.bet > 0,
      betHorse: p.hasBet ? p.betHorse : null, betType: p.hasBet ? p.betType : null
    })),
    playerCount: Object.keys(race.players).length,
    finishX: race.finishX, raceDist: race.raceDist,
    bettingTimeLeft: race.bettingTimeLeft
  };
}

function lobbyItem(race) {
  return {
    id: race.id, state: race.state, raceType: race.raceType,
    raceLabel: RACE_LABELS[race.raceType],
    playerCount: Object.keys(race.players).length
  };
}

function broadcastLobby() {
  io.emit('lobby_update', Object.values(races).map(lobbyItem));
}

function broadcastRace(race) {
  io.to('race_' + race.id).emit('race_state', publicRace(race));
}

function clearTimers(race) {
  if (race.betTimer)    { clearTimeout(race.betTimer);    race.betTimer = null; }
  if (race.cancelTimer) { clearTimeout(race.cancelTimer); race.cancelTimer = null; }
  if (race.tickTimer)   { clearInterval(race.tickTimer);  race.tickTimer = null; }
  if (race.resultTimer) { clearTimeout(race.resultTimer); race.resultTimer = null; }
}

function resetRace(race) {
  clearTimers(race);
  // Refund any open bets
  const db = readDB();
  let changed = false;
  for (const p of Object.values(race.players)) {
    if (p.bet > 0 && (race.state === 'open' || race.state === 'countdown')) {
      const u = db.users.find(u => u.id === p.userId);
      if (u) { u.balance += p.bet; changed = true; }
    }
  }
  if (changed) writeDB(db);

  const types = ['sprint', 'distance', 'derby'];
  const raceType = types[Math.floor(Math.random() * types.length)];
  const count = raceType === 'sprint' ? 6 : 14;
  const horses = Array.from({ length: count }, (_, i) => createHorse(i, count));
  calculateOdds(horses);

  race.raceType = raceType;
  race.horses = horses;
  race.raceDist = RACE_DISTS[raceType];
  race.finishX = 0.1 + race.raceDist;
  race.state = 'open';
  race.players = {};
  race.startTime = null;
  race.bettingStartedAt = null;
  race.bettingTimeLeft = 0;

  io.to('race_' + race.id).emit('race_reset', publicRace(race));
  broadcastLobby();
}

function startBettingTimer(race) {
  if (race.betTimer) return; // already running
  const playerCount = Object.keys(race.players).length;
  if (playerCount < 2) return; // single player: immediate on bet

  race.bettingStartedAt = Date.now();
  race.bettingTimeLeft = BETTING_WINDOW;

  io.to('race_' + race.id).emit('betting_timer', { seconds: 60 });

  // Tick down timer every second
  const timerTick = setInterval(() => {
    race.bettingTimeLeft = Math.max(0, BETTING_WINDOW - (Date.now() - race.bettingStartedAt));
    io.to('race_' + race.id).emit('betting_tick', { ms: race.bettingTimeLeft });
  }, 1000);

  race.betTimer = setTimeout(() => {
    clearInterval(timerTick);
    race.betTimer = null;
    const bettors = Object.values(race.players).filter(p => p.bet > 0);
    if (bettors.length === 0) { resetRace(race); return; }
    startCountdown(race);
  }, BETTING_WINDOW);

  // Store tick interval ref for cleanup
  race._bettingTick = timerTick;
}

function startCountdown(race) {
  if (race._bettingTick) { clearInterval(race._bettingTick); race._bettingTick = null; }
  if (race.betTimer) { clearTimeout(race.betTimer); race.betTimer = null; }
  race.state = 'countdown';
  race.bettingTimeLeft = 0;
  broadcastRace(race);
  broadcastLobby();
  io.to('race_' + race.id).emit('countdown_start', { seconds: 5 });

  // Tick down cancel window
  let remaining = 5;
  const cdTick = setInterval(() => {
    remaining--;
    io.to('race_' + race.id).emit('countdown_tick', { seconds: remaining });
    if (remaining <= 0) clearInterval(cdTick);
  }, 1000);

  race.cancelTimer = setTimeout(() => {
    clearInterval(cdTick);
    race.cancelTimer = null;
    beginRace(race);
  }, CANCEL_WINDOW);
}

function beginRace(race) {
  // Lock all non-bettors out: remove players with no bet
  for (const [sid, p] of Object.entries(race.players)) {
    if (p.bet <= 0) delete race.players[sid];
  }

  race.state = 'racing';
  race.startTime = Date.now();
  race.raceCount++;
  broadcastRace(race);
  broadcastLobby();
  io.to('race_' + race.id).emit('race_started', { raceType: race.raceType, label: RACE_LABELS[race.raceType] });

  // Update global stats
  const stats = readStats();
  stats.totalRaces++;
  writeStats(stats);

  race.tickTimer = setInterval(() => stepRace(race), TICK_INTERVAL);
}

function stepRace(race) {
  const leaderX = Math.max(...race.horses.map(h => h.x));
  const tNorm = Math.min((leaderX - 0.1) / race.raceDist, 1);

  race.horses.forEach(h => {
    h.speed = computeSpeed(h, tNorm);
    h.x += h.speed * (1 + (Math.random() * RANDOMNESS - RANDOMNESS / 2));
    h.maxSpeed = Math.max(h.maxSpeed, h.speed);
  });

  if (tNorm < PACK_END_FRACTION) {
    const gc = race.horses.reduce((s, h) => s + h.x, 0) / race.horses.length;
    race.horses.forEach(h => { h.x += (gc - h.x) * PACK_TIGHTNESS; });
  }

  io.to('race_' + race.id).emit('race_tick', {
    horses: race.horses.map((h, i) => ({ i, x: h.x, speed: h.speed })),
    tNorm
  });

  if (Math.max(...race.horses.map(h => h.x)) >= race.finishX) {
    clearInterval(race.tickTimer); race.tickTimer = null;
    finishRace(race);
  }
}

async function finishRace(race) {
  race.state = 'results';
  const raceTimeMs = Date.now() - race.startTime;

  const byPos = [...race.horses].map((h, i) => ({ h, i })).sort((a, b) => b.h.x - a.h.x);
  const bySpeed = [...race.horses].map((h, i) => ({ h, i })).sort((a, b) => b.h.maxSpeed - a.h.maxSpeed);
  const winnerIdx = byPos[0].i;
  const fastestIdx = bySpeed[0].i;
  const top3 = byPos.slice(0, 3).map(e => e.i);

  const results = {
    winner: winnerIdx, top3, fastest: fastestIdx,
    podium: byPos.slice(0, 3).map(e => e.i + 1),
    raceType: race.raceType, raceLabel: RACE_LABELS[race.raceType],
    raceTimeMs
  };

  const db = readDB();
  const stats = readStats();
  const payouts = [];

  for (const [socketId, player] of Object.entries(race.players)) {
    if (player.bet <= 0) continue;
    const user = db.users.find(u => u.id === player.userId);
    if (!user) continue;

    const bet = player.bet, betType = player.betType, betHorse = player.betHorse;
    const odds = getOdds(race.horses[betHorse], betType);

    let win = false;
    if (betType === 'win'     && betHorse === winnerIdx)     win = true;
    if (betType === 'top3'    && top3.includes(betHorse))    win = true;
    if (betType === 'fastest' && betHorse === fastestIdx)    win = true;

    let netProfit = 0;
    if (win) {
      const totalReturn = parseFloat((bet * odds).toFixed(2));
      netProfit = parseFloat((totalReturn - bet).toFixed(2));
      user.balance = parseFloat((user.balance + totalReturn).toFixed(2));
      user.stats.racesWon++;
      user.stats.totalWon += netProfit;
      user.stats.biggestWin = Math.max(user.stats.biggestWin, netProfit);
      user.stats.currentStreak = (user.stats.currentStreak || 0) + 1;
      user.stats.winStreak = Math.max(user.stats.winStreak, user.stats.currentStreak);
      stats.totalWagered += bet;
      if (netProfit > stats.biggestWin) { stats.biggestWin = netProfit; stats.biggestWinner = user.username; }
    } else {
      user.stats.biggestLoss = Math.max(user.stats.biggestLoss, bet);
      user.stats.currentStreak = 0;
      stats.totalWagered += bet;
    }

    user.stats.racesPlayed++;
    user.stats.totalWagered += bet;
    user.lastSeen = new Date().toISOString();

    payouts.push({
      socketId, userId: player.userId, username: player.username,
      betHorse, betType, bet, odds, win, netProfit,
      balance: user.balance
    });
  }

  writeDB(db);
  writeStats(stats);

  // Add to recent results feed
  recentResults.unshift({
    raceId: race.id, raceType: race.raceType,
    winner: winnerIdx + 1, fastest: fastestIdx + 1,
    playerCount: payouts.length, timestamp: new Date().toISOString(),
    payouts: payouts.map(p => ({ username: p.username, win: p.win, netProfit: p.netProfit, bet: p.bet }))
  });
  if (recentResults.length > 50) recentResults.pop();

  io.to('race_' + race.id).emit('race_results', { results, payouts: payouts.map(p => ({ ...p, socketId: undefined })) });

  // Send personal balances
  payouts.forEach(p => {
    io.to(p.socketId).emit('personal_result', {
      win: p.win, bet: p.bet, odds: p.odds, netProfit: p.netProfit, balance: p.balance
    });
  });

  // Broadcast live feed to everyone
  io.emit('live_feed', recentResults.slice(0, 10));
  io.emit('global_stats', { ...stats, totalUsers: db.users.length });

  broadcastLobby();

  race.resultTimer = setTimeout(() => resetRace(race), RESULTS_SHOW);
}

// ── SOCKET.IO ─────────────────────────────────────────────────
const connectedUsers = new Map(); // socketId -> { username, raceId }

io.on('connection', (socket) => {
  let currentUser = null;
  let currentRaceId = null;

  socket.emit('lobby_state', Object.values(races).map(lobbyItem));
  socket.emit('live_feed', recentResults.slice(0, 10));
  socket.emit('global_stats', { ...readStats(), totalUsers: readDB().users.length });

  socket.on('auth', (token) => {
    const decoded = verifyToken(token);
    if (!decoded) { socket.emit('auth_error', 'Session expired — please log in again'); return; }
    const db = readDB();
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) { socket.emit('auth_error', 'Account not found'); return; }

    currentUser = { id: user.id, username: user.username };
    connectedUsers.set(socket.id, { username: user.username, raceId: null });

    socket.emit('auth_ok', {
      username: user.username, balance: user.balance, stats: user.stats, id: user.id
    });
    io.emit('active_count', connectedUsers.size);
  });

  socket.on('join_race', (raceId) => {
    if (!currentUser) { socket.emit('error_msg', 'Please log in first'); return; }
    const race = races[raceId];
    if (!race) { socket.emit('error_msg', 'Race not found'); return; }

    // Leave current race
    if (currentRaceId && currentRaceId !== raceId) {
      leaveRace(socket, currentRaceId, currentUser);
    }

    socket.join('race_' + raceId);
    currentRaceId = raceId;
    if (connectedUsers.has(socket.id)) connectedUsers.get(socket.id).raceId = raceId;

    // Add as player (spectator until bet placed) only if race is open
    if (race.state === 'open' || race.state === 'countdown') {
      if (!race.players[socket.id]) {
        race.players[socket.id] = {
          userId: currentUser.id, username: currentUser.username,
          bet: 0, betHorse: 0, betType: 'win', hasBet: false
        };
      }
    }

    socket.emit('joined_race', { raceId, state: publicRace(race) });
    broadcastRace(race);
    broadcastLobby();
  });

  socket.on('place_bet', ({ bet, betHorse, betType }) => {
    if (!currentUser || !currentRaceId) return;
    const race = races[currentRaceId];
    if (!race) return;
    if (race.state !== 'open') { socket.emit('error_msg', 'Betting is closed for this race'); return; }

    bet = parseFloat(bet);
    if (!Number.isFinite(bet) || bet < 5) { socket.emit('error_msg', 'Minimum bet is $5'); return; }
    if (!['win','top3','fastest','draw'].includes(betType)) { socket.emit('error_msg', 'Invalid bet type'); return; }
    betHorse = parseInt(betHorse);
    if (betHorse < 0 || betHorse >= race.horses.length) { socket.emit('error_msg', 'Invalid horse selection'); return; }

    const db = readDB();
    const user = db.users.find(u => u.id === currentUser.id);
    if (!user) return;

    const player = race.players[socket.id];
    // Refund previous bet if changing
    if (player && player.bet > 0) user.balance += player.bet;

    bet = Math.min(bet, user.balance);
    bet = Math.floor(bet * 100) / 100; // 2dp
    if (bet < 5) { socket.emit('error_msg', 'Insufficient balance for minimum bet of $5'); return; }

    user.balance = parseFloat((user.balance - bet).toFixed(2));
    writeDB(db);

    race.players[socket.id] = {
      userId: currentUser.id, username: currentUser.username,
      bet, betHorse, betType, hasBet: true
    };

    socket.emit('bet_confirmed', { bet, betHorse, betType, balance: user.balance });
    broadcastRace(race);

    const bettors = Object.values(race.players).filter(p => p.hasBet);
    const total = Object.keys(race.players).length;

    if (total === 1 && bettors.length === 1) {
      // Solo player: start countdown immediately
      startCountdown(race);
    } else if (bettors.length === 1 && !race.betTimer) {
      // First bet in multi-player: start 60s timer
      startBettingTimer(race);
    }
    broadcastLobby();
  });

  socket.on('cancel_bet', () => {
    if (!currentUser || !currentRaceId) return;
    const race = races[currentRaceId];
    if (!race || race.state !== 'countdown') return;

    const player = race.players[socket.id];
    if (!player || !player.hasBet) return;

    const db = readDB();
    const user = db.users.find(u => u.id === currentUser.id);
    if (user) {
      user.balance = parseFloat((user.balance + player.bet).toFixed(2));
      writeDB(db);
    }
    player.bet = 0; player.hasBet = false;
    socket.emit('bet_cancelled', { balance: user ? user.balance : null });
    broadcastRace(race);
  });

  socket.on('get_leaderboard', () => {
    const db = readDB();
    const top = [...db.users]
      .sort((a, b) => b.balance - a.balance).slice(0, 50)
      .map(u => ({
        username: u.username, balance: u.balance,
        racesPlayed: u.stats.racesPlayed, racesWon: u.stats.racesWon,
        biggestWin: u.stats.biggestWin, totalWagered: u.stats.totalWagered,
        winRate: u.stats.racesPlayed > 0 ? ((u.stats.racesWon / u.stats.racesPlayed) * 100).toFixed(1) : '0.0'
      }));
    socket.emit('leaderboard', top);
  });

  socket.on('disconnect', () => {
    if (currentRaceId) leaveRace(socket, currentRaceId, currentUser);
    connectedUsers.delete(socket.id);
    io.emit('active_count', connectedUsers.size);
  });

  function leaveRace(sock, raceId, user) {
    const race = races[raceId];
    if (!race) return;
    const player = race.players[sock.id];
    if (player && player.hasBet && (race.state === 'open')) {
      // Refund if race hasn't started
      const db = readDB();
      const u = db.users.find(u => u.id === user?.id);
      if (u) { u.balance += player.bet; writeDB(db); sock.emit('balance_update', { balance: u.balance }); }
    }
    delete race.players[sock.id];
    sock.leave('race_' + raceId);
    if (connectedUsers.has(sock.id)) connectedUsers.get(sock.id).raceId = null;
    broadcastRace(race);
    broadcastLobby();
  }
});

server.listen(PORT, () => {
  console.log(`🏇 Strix server running on port ${PORT}`);
  if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
});