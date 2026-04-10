const SERVER_URL = window.location.hostname === 'localhost'
  ? 'https://strix-1xlv.onrender.com'
  : 'https://strix-1xlv.onrender.com';

// ── AUTH ──────────────────────────────────────────────────────
let authToken = localStorage.getItem('strix_token');
let currentUser = null;

function switchTab(tab) {
  document.getElementById('loginForm').style.display = tab === 'login' ? '' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('tabLogin').classList.toggle('active', tab === 'login');
  document.getElementById('tabRegister').classList.toggle('active', tab === 'register');
  document.getElementById('authError').textContent = '';
}

async function doLogin() {
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value;
  if (!u || !p) { document.getElementById('authError').textContent = 'Fill in all fields'; return; }
  try {
    const r = await fetch(SERVER_URL + '/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:u,password:p}) });
    const d = await r.json();
    if (!r.ok) { document.getElementById('authError').textContent = d.error || 'Login failed'; return; }
    onAuthSuccess(d);
  } catch (e) { document.getElementById('authError').textContent = 'Cannot connect to server'; }
}

async function doRegister() {
  const u = document.getElementById('regUser').value.trim();
  const p = document.getElementById('regPass').value;
  const p2 = document.getElementById('regPass2').value;
  if (!u || !p || !p2) { document.getElementById('authError').textContent = 'Fill in all fields'; return; }
  if (p !== p2) { document.getElementById('authError').textContent = 'Passwords do not match'; return; }
  try {
    const r = await fetch(SERVER_URL + '/auth/register', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:u,password:p}) });
    const d = await r.json();
    if (!r.ok) { document.getElementById('authError').textContent = d.error || 'Registration failed'; return; }
    onAuthSuccess(d);
  } catch (e) { document.getElementById('authError').textContent = 'Cannot connect to server'; }
}

function onAuthSuccess(data) {
  authToken = data.token;
  currentUser = { username: data.username, balance: data.balance };
  localStorage.setItem('strix_token', authToken);
  document.getElementById('authOverlay').classList.add('hidden');
  document.getElementById('usernameDisplay').textContent = data.username;
  document.getElementById('balanceDisplay').textContent = fmtBalance(data.balance);
  socket.emit('auth', authToken);
}

function logOut() {
  localStorage.removeItem('strix_token');
  location.reload();
}

function fmtBalance(n) { return Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }

// ── SOCKET ────────────────────────────────────────────────────
const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  if (authToken) socket.emit('auth', authToken);
});

socket.on('auth_ok', (data) => {
  currentUser = data;
  document.getElementById('authOverlay').classList.add('hidden');
  document.getElementById('usernameDisplay').textContent = data.username;
  document.getElementById('balanceDisplay').textContent = fmtBalance(data.balance);
  socket.emit('roulette_join');
});

socket.on('auth_error', (msg) => {
  localStorage.removeItem('strix_token');
  authToken = null;
  document.getElementById('authOverlay').classList.remove('hidden');
  document.getElementById('authError').textContent = msg;
});

// ── ROULETTE DATA ────────────────────────────────────────────
const NUMBERS = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
const BLACK = [2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35];

const CHIP_VALUES = [1, 5, 10, 25, 50, 100, 500, 1000];
let selectedChip = 10;
let currentBets = {}; // betId -> { amount, type, numbers }
let lastBets = {};
let betHistory = [];

// ── GAME STATE ────────────────────────────────────────────────
let gameState = {
  phase: 'betting', // betting, spinning, results
  timeLeft: 30,
  winningNumber: null,
  players: [],
  recentNumbers: [],
  stats: { spins: 0, totalBet: 0, lastPayout: 0 }
};

// ── INIT ──────────────────────────────────────────────────────
function init() {
  initChips();
  initWheel();
  initBettingGrid();
  
  if (!authToken) {
    document.getElementById('authOverlay').classList.remove('hidden');
  }
}

function initChips() {
  const grid = document.getElementById('chipsGrid');
  CHIP_VALUES.forEach(val => {
    const chip = document.createElement('div');
    chip.className = `chip chip-${val}`;
    if (val === selectedChip) chip.classList.add('active');
    chip.textContent = val >= 1000 ? '1K' : val;
    chip.onclick = () => selectChip(val);
    grid.appendChild(chip);
  });
}

function selectChip(val) {
  selectedChip = val;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  document.querySelector(`.chip-${val}`).classList.add('active');
}

function initWheel() {
  const wheel = document.getElementById('wheel');
  NUMBERS.forEach((num, i) => {
    const deg = (i / NUMBERS.length) * 360;
    const slot = document.createElement('div');
    slot.className = 'wheel-number';
    slot.textContent = num;
    slot.style.transform = `rotate(${deg}deg)`;
    slot.style.background = num === 0 ? '#14532d' : (RED.includes(num) ? '#7f1d1d' : '#171717');
    wheel.appendChild(slot);
  });
}

function initBettingGrid() {
  const grid = document.getElementById('bettingGrid');
  
  // Row 1: 0 and 3rd column
  const zero = createBetCell(0, 'green', 1, 1);
  zero.style.gridRow = 'span 3';
  grid.appendChild(zero);
  
  // Numbers 1-36 in 3 rows
  for (let row = 0; row < 3; row++) {
    for (let col = 1; col <= 12; col++) {
      const num = col * 3 - (2 - row);
      const color = num === 0 ? 'green' : (RED.includes(num) ? 'red' : 'black');
      grid.appendChild(createBetCell(num, color));
    }
    // Column bet
    const colBet = createBetCell(`col${row + 1}`, '', 1, 1, `2:1<br>COL ${row + 1}`);
    colBet.classList.add('outside');
    grid.appendChild(colBet);
  }
  
  // Bottom row: dozens and outside bets
  const bottomRow = document.createElement('div');
  bottomRow.style.cssText = 'grid-column:2/15;display:grid;grid-template-columns:repeat(6,1fr);gap:2px;margin-top:2px;';
  
  const outsideBets = [
    { id: '1-18', label: '1-18' },
    { id: 'even', label: 'EVEN' },
    { id: 'red', label: '♦' },
    { id: 'black', label: '♣' },
    { id: 'odd', label: 'ODD' },
    { id: '19-36', label: '19-36' }
  ];
  
  outsideBets.forEach(bet => {
    const cell = createBetCell(bet.id, '', 1, 1, bet.label);
    cell.classList.add('outside');
    if (bet.id === 'red') cell.style.color = '#ef4444';
    if (bet.id === 'black') cell.style.color = '#404040';
    bottomRow.appendChild(cell);
  });
  
  grid.appendChild(bottomRow);
  
  const dozenRow = document.createElement('div');
  dozenRow.style.cssText = 'grid-column:2/15;display:grid;grid-template-columns:repeat(3,1fr);gap:2px;margin-top:2px;';
  
  ['1st 12', '2nd 12', '3rd 12'].forEach((label, i) => {
    const cell = createBetCell(`dozen${i + 1}`, '', 1, 1, label);
    cell.classList.add('outside');
    dozenRow.appendChild(cell);
  });
  
  grid.appendChild(dozenRow);
}

function createBetCell(id, color, colspan = 1, rowspan = 1, label = null) {
  const cell = document.createElement('div');
  cell.className = `bet-cell ${color}`;
  cell.textContent = label || id;
  cell.dataset.betId = id;
  if (colspan > 1) cell.style.gridColumn = `span ${colspan}`;
  if (rowspan > 1) cell.style.gridRow = `span ${rowspan}`;
  
  cell.onclick = () => placeBet(id);
  
  const chipsContainer = document.createElement('div');
  chipsContainer.className = 'bet-chips';
  chipsContainer.id = `chips-${id}`;
  cell.appendChild(chipsContainer);
  
  return cell;
}

// ── BETTING LOGIC ─────────────────────────────────────────────
function placeBet(betId) {
  if (gameState.phase !== 'betting') return;
  if (selectedChip > currentUser.balance) {
    alert('Insufficient balance');
    return;
  }
  
  if (!currentBets[betId]) {
    currentBets[betId] = { amount: 0, numbers: getBetNumbers(betId) };
  }
  
  currentBets[betId].amount += selectedChip;
  updateBetDisplay();
}

function getBetNumbers(betId) {
  if (!isNaN(betId)) return [parseInt(betId)];
  if (betId === 'red') return RED;
  if (betId === 'black') return BLACK;
  if (betId === 'even') return [2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36];
  if (betId === 'odd') return [1,3,5,7,9,11,13,15,17,19,21,23,25,27,29,31,33,35];
  if (betId === '1-18') return Array.from({length:18},(\_,i)=>i+1);
  if (betId === '19-36') return Array.from({length:18},(\_,i)=>i+19);
  if (betId === 'dozen1') return [1,2,3,4,5,6,7,8,9,10,11,12];
  if (betId === 'dozen2') return [13,14,15,16,17,18,19,20,21,22,23,24];
  if (betId === 'dozen3') return [25,26,27,28,29,30,31,32,33,34,35,36];
  if (betId === 'col1') return [1,4,7,10,13,16,19,22,25,28,31,34];
  if (betId === 'col2') return [2,5,8,11,14,17,20,23,26,29,32,35];
  if (betId === 'col3') return [3,6,9,12,15,18,21,24,27,30,33,36];
  return [];
}

function updateBetDisplay() {
  let total = 0;
  
  Object.keys(currentBets).forEach(betId => {
    const bet = currentBets[betId];
    total += bet.amount;
    
    const container = document.getElementById(`chips-${betId}`);
    if (container) {
      container.innerHTML = '';
      const chip = document.createElement('div');
      chip.className = `mini-chip chip-${selectedChip}`;
      chip.textContent = bet.amount;
      container.appendChild(chip);
    }
  });
  
  document.getElementById('totalBet').textContent = total.toFixed(0);
}

function undoBet() {
  const keys = Object.keys(currentBets);
  if (keys.length === 0) return;
  const lastKey = keys[keys.length - 1];
  delete currentBets[lastKey];
  updateBetDisplay();
}

function clearBets() {
  currentBets = {};
  document.querySelectorAll('.bet-chips').forEach(c => c.innerHTML = '');
  document.getElementById('totalBet').textContent = '0';
}

function repeatBets() {
  if (Object.keys(lastBets).length === 0) return;
  currentBets = JSON.parse(JSON.stringify(lastBets));
  updateBetDisplay();
}

function doubleBets() {
  Object.keys(currentBets).forEach(key => {
    currentBets[key].amount *= 2;
  });
  updateBetDisplay();
}

function placeBets() {
  if (Object.keys(currentBets).length === 0) return;
  
  const totalBet = Object.values(currentBets).reduce((sum, b) => sum + b.amount, 0);
  if (totalBet > currentUser.balance) {
    alert('Insufficient balance');
    return;
  }
  
  socket.emit('roulette_place_bets', { bets: currentBets });
  lastBets = JSON.parse(JSON.stringify(currentBets));
  document.getElementById('placeBetBtn').disabled = true;
}

// ── SOCKET HANDLERS ───────────────────────────────────────────
socket.on('roulette_state', (state) => {
  gameState = state;
  updateUI();
});

socket.on('roulette_bet_confirmed', ({ balance }) => {
  currentUser.balance = balance;
  document.getElementById('balanceDisplay').textContent = fmtBalance(balance);
});

socket.on('roulette_spin_start', ({ number }) => {
  gameState.phase = 'spinning';
  gameState.winningNumber = number;
  spinWheel(number);
  clearBets();
  document.getElementById('placeBetBtn').disabled = true;
});

socket.on('roulette_result', ({ number, winnings, balance }) => {
  gameState.phase = 'results';
  currentUser.balance = balance;
  document.getElementById('balanceDisplay').textContent = fmtBalance(balance);
  
  const numEl = document.getElementById('winningNumber');
  numEl.textContent = number;
  numEl.className = 'winning-number ' + (number === 0 ? 'green' : (RED.includes(number) ? 'red' : 'black'));
  
  if (winnings > 0) {
    numEl.innerHTML += ` <span style="color:var(--lime);font-size:24px;">+$${winnings.toFixed(2)}</span>`;
  }
});

socket.on('roulette_betting_open', () => {
  gameState.phase = 'betting';
  document.getElementById('placeBetBtn').disabled = false;
  document.getElementById('winningNumber').textContent = '—';
});

socket.on('error_msg', (msg) => {
  alert(msg);
});

// ── WHEEL ANIMATION ───────────────────────────────────────────
function spinWheel(winningNum) {
  const wheel = document.getElementById('wheel');
  const ball = document.getElementById('ball');
  
  const targetIndex = NUMBERS.indexOf(winningNum);
  const targetAngle = (targetIndex / NUMBERS.length) * 360;
  const spins = 5;
  const finalAngle = spins * 360 + targetAngle + Math.random() * 10 - 5;
  
  wheel.style.transform = `rotate(${finalAngle}deg)`;
  
  // Ball animation
  let ballAngle = 0;
  const ballInterval = setInterval(() => {
    ballAngle += 15;
    const rad = (ballAngle * Math.PI) / 180;
    const x = 60 + Math.cos(rad) * 120;
    const y = 60 + Math.sin(rad) * 120;
    ball.style.left = x + 'px';
    ball.style.top = y + 'px';
  }, 50);
  
  setTimeout(() => {
    clearInterval(ballInterval);
    const rad = ((360 - targetAngle) * Math.PI) / 180;
    ball.style.left = (60 + Math.cos(rad) * 130) + 'px';
    ball.style.top = (60 + Math.sin(rad) * 130) + 'px';
  }, 5500);
}

// ── UI UPDATES ────────────────────────────────────────────────
function updateUI() {
  // Timer
  const { timeLeft, phase } = gameState;
  document.getElementById('timerText').textContent = timeLeft;
  document.getElementById('timerLabel').textContent = 
    phase === 'betting' ? 'Place Your Bets' : 
    phase === 'spinning' ? 'Spinning...' : 'Results';
  
  const fill = document.getElementById('timerFill');
  const pct = phase === 'betting' ? (timeLeft / 30) : 0;
  fill.style.strokeDashoffset = 327 * (1 - pct);
  fill.className = 'timer-fill' + (timeLeft < 10 ? ' urgent' : timeLeft < 20 ? ' warning' : '');
  
  // Players
  const playersList = document.getElementById('playersList');
  playersList.innerHTML = '';
  gameState.players.forEach(p => {
    const item = document.createElement('div');
    item.className = 'player-item' + (p.username === currentUser?.username ? ' me' : '');
    item.innerHTML = `
      <span class="player-name">${p.username}</span>
      <span class="player-bet">$${p.totalBet || 0}</span>
    `;
    playersList.appendChild(item);
  });
  
  document.getElementById('playerCount').textContent = gameState.players.length;
  
  // Recent numbers
  const recent = document.getElementById('recentNumbers');
  recent.innerHTML = '';
  gameState.recentNumbers.slice(0, 15).forEach(num => {
    const chip = document.createElement('div');
    chip.className = 'recent-num ' + (num === 0 ? 'green' : (RED.includes(num) ? 'red' : 'black'));
    chip.textContent = num;
    chip.style.background = num === 0 ? 'linear-gradient(135deg,#14532d,var(--lime))' : 
      (RED.includes(num) ? 'linear-gradient(135deg,#7f1d1d,#ef4444)' : 'linear-gradient(135deg,#171717,#404040)');
    recent.appendChild(chip);
  });
  
  // Stats
  document.getElementById('statSpins').textContent = gameState.stats.spins;
  document.getElementById('statPlayers').textContent = gameState.players.length;
  document.getElementById('statTotalBet').textContent = gameState.stats.totalBet;
  document.getElementById('statLastPayout').textContent = gameState.stats.lastPayout;
  
  // Hot/Cold
  updateHotCold();
}

function updateHotCold() {
  const counts = {};
  gameState.recentNumbers.forEach(n => {
    counts[n] = (counts[n] || 0) + 1;
  });
  
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const hot = sorted.slice(0, 5);
  const cold = sorted.slice(-5).reverse();
  
  const hotEl = document.getElementById('hotNumbers');
  hotEl.innerHTML = '';
  hot.forEach(([num, count]) => {
    const span = document.createElement('span');
    span.className = 'hot-cold-num';
    span.textContent = `${num}×${count}`;
    span.style.color = '#ef4444';
    hotEl.appendChild(span);
  });
  
  const coldEl = document.getElementById('coldNumbers');
  coldEl.innerHTML = '';
  cold.forEach(([num, count]) => {
    const span = document.createElement('span');
    span.className = 'hot-cold-num';
    span.textContent = `${num}×${count}`;
    span.style.color = '#38bdf8';
    coldEl.appendChild(span);
  });
}

// Start update loop
setInterval(() => {
  if (gameState.phase === 'betting' && gameState.timeLeft > 0) {
    updateUI();
  }
}, 1000);

init();
