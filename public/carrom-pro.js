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
});

socket.on('auth_error', (msg) => {
  localStorage.removeItem('strix_token');
  authToken = null;
  document.getElementById('authOverlay').classList.remove('hidden');
  document.getElementById('authError').textContent = msg;
});

// ── MATCHMAKING ───────────────────────────────────────────────
let gameState = null;
let myPlayerNum = null;

function setBet(amount) {
  document.getElementById('betInput').value = amount;
}

function findMatch() {
  const bet = parseFloat(document.getElementById('betInput').value);
  if (!bet || bet < 10) { alert('Minimum bet is $10'); return; }
  if (bet > currentUser.balance) { alert('Insufficient balance'); return; }
  socket.emit('carrom_find_match', { bet });
  document.getElementById('findMatchBtn').style.display = 'none';
  document.getElementById('cancelMatchBtn').style.display = 'block';
  document.getElementById('statusMsg').textContent = 'Searching for opponent...';
  document.getElementById('statusMsg').className = 'status-msg waiting';
}

function cancelMatch() {
  socket.emit('carrom_cancel_match');
  document.getElementById('findMatchBtn').style.display = 'block';
  document.getElementById('cancelMatchBtn').style.display = 'none';
  document.getElementById('statusMsg').textContent = 'Search cancelled';
  document.getElementById('statusMsg').className = 'status-msg';
}

socket.on('carrom_match_found', ({ gameId, playerNum, state }) => {
  gameState = state;
  myPlayerNum = playerNum;
  document.getElementById('matchmakingPanel').style.display = 'none';
  document.getElementById('gameInfoPanel').style.display = 'block';
  document.getElementById('potAmount').textContent = '$' + (state.pot || 0);
  document.getElementById('yourBet').textContent = '$' + (state.bet || 0);
  updateGameUI(state);
  addLog(`Match found! You are <strong>${playerNum === 1 ? 'WHITE' : 'BLACK'}</strong> pucks`);
  initBoard(state);
});

socket.on('carrom_state', (state) => {
  gameState = state;
  updateGameUI(state);
  renderBoard(state);
});

socket.on('carrom_game_over', ({ winner, pot, balance }) => {
  const won = winner === myPlayerNum;
  document.getElementById('balanceDisplay').textContent = fmtBalance(balance);
  currentUser.balance = balance;
  showResult(won, pot);
  addLog(won ? `🏆 <strong>YOU WON!</strong> +$${pot}` : `You lost -$${gameState.bet}`, won ? 'win' : 'lose');
});

socket.on('carrom_opponent_left', () => {
  addLog('Opponent disconnected — you win by default!');
  setTimeout(() => location.reload(), 3000);
});

socket.on('carrom_collision', () => {
  playSound('hit');
});

socket.on('carrom_pocketed', ({ type, owner }) => {
  playSound('hole');
  const typeLabel = type === 'red' ? '👑 <strong>QUEEN</strong>' : (owner === 1 ? 'WHITE' : 'BLACK') + ' puck';
  addLog(`${typeLabel} pocketed!`, type === 'red' ? 'queen' : '');
});

socket.on('error_msg', (msg) => {
  alert(msg);
});

// ── GAME UI ───────────────────────────────────────────────────
function updateGameUI(state) {
  const p1 = state.players[1];
  const p2 = state.players[2];
  document.getElementById('player1Name').textContent = p1 ? p1.username : 'Waiting...';
  document.getElementById('player2Name').textContent = p2 ? p2.username : 'Waiting...';
  
  const p1Pucks = state.pucks.filter(p => p.owner === 1 && !p.pocketed).length;
  const p2Pucks = state.pucks.filter(p => p.owner === 2 && !p.pocketed).length;
  document.getElementById('player1Pucks').innerHTML = `<span class="puck-indicator" style="background:#fff;"></span> ${p1Pucks} white pucks${state.players[1]?.hasQueen ? ' 👑' : ''}`;
  document.getElementById('player2Pucks').innerHTML = `<span class="puck-indicator" style="background:#000;"></span> ${p2Pucks} black pucks${state.players[2]?.hasQueen ? ' 👑' : ''}`;
  
  document.getElementById('player1Card').classList.toggle('active', state.turn === 1);
  document.getElementById('player2Card').classList.toggle('active', state.turn === 2);
  
  const turnInd = document.getElementById('turnIndicator');
  if (state.turn === myPlayerNum) {
    turnInd.textContent = 'YOUR TURN — Drag striker to aim & shoot';
    turnInd.className = 'turn-indicator my-turn';
  } else {
    turnInd.textContent = "Opponent's Turn — Please wait";
    turnInd.className = 'turn-indicator opponent-turn';
  }
}

function addLog(msg, type = '') {
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  entry.innerHTML = msg;
  document.getElementById('logPanel').prepend(entry);
  const panel = document.getElementById('logPanel');
  if (panel.children.length > 50) panel.lastChild.remove();
}

function showResult(won, amount) {
  const box = document.getElementById('resultBox');
  box.className = 'result-box ' + (won ? 'win-box' : 'loss-box');
  document.getElementById('resultLabel').textContent = won ? 'VICTORY' : 'DEFEAT';
  document.getElementById('resultHeadline').textContent = won ? 'YOU WIN' : 'YOU LOSE';
  document.getElementById('resultAmount').textContent = won ? '+$' + amount : '-$' + gameState.bet;
  document.getElementById('resultOverlay').classList.add('show');
}

document.getElementById('continueBtn').addEventListener('click', () => {
  location.href = 'index.html';
});

// ── BOARD & PHYSICS ───────────────────────────────────────────
const canvas = document.getElementById('carromCanvas');
const ctx = canvas.getContext('2d');
const BOARD_SIZE = 900;
const MARGIN = 60;
const PLAY_AREA = BOARD_SIZE - MARGIN * 2;
const POCKET_SIZE = 50; // Triangular pocket size
const PUCK_RADIUS = 18;
const STRIKER_RADIUS = 26; // BIGGER striker
const FRICTION = 0.985;
const RESTITUTION = 0.88;
const BASELINE_Y = MARGIN + 80;

let striker = null;
let isDragging = false;
let dragStart = null;
let aimLine = null;

const images = {
  striker: new Image(),
  pukWhite: new Image(),
  pukBlack: new Image(),
  pukRed: new Image()
};
images.striker.src = 'Carrom/disk_white.png';
images.pukWhite.src = 'Carrom/Puks/puk_white.png';
images.pukBlack.src = 'Carrom/Puks/puk_black.png';
images.pukRed.src = 'Carrom/Puks/puk_red.png';

const sounds = {
  hit: new Audio('Carrom/hit_carrom_vfx.flac'),
  hole: new Audio('Carrom/hole_carrom_vfx.flac')
};

function playSound(name) {
  if (sounds[name]) {
    sounds[name].currentTime = 0;
    sounds[name].play().catch(() => {});
  }
}

function initBoard(state) {
  renderBoard(state);
  
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
}

function renderBoard(state) {
  if (!state) return;
  
  const centerX = BOARD_SIZE / 2;
  const centerY = BOARD_SIZE / 2;
  
  // Clear
  ctx.clearRect(0, 0, BOARD_SIZE, BOARD_SIZE);
  
  // Wood background
  const woodGrad = ctx.createLinearGradient(0, 0, BOARD_SIZE, BOARD_SIZE);
  woodGrad.addColorStop(0, '#d4a574');
  woodGrad.addColorStop(0.5, '#c09460');
  woodGrad.addColorStop(1, '#d4a574');
  ctx.fillStyle = woodGrad;
  ctx.fillRect(0, 0, BOARD_SIZE, BOARD_SIZE);
  
  // Wood grain texture (simple lines)
  ctx.strokeStyle = 'rgba(139,111,71,0.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i < BOARD_SIZE; i += 8) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + BOARD_SIZE / 4, BOARD_SIZE);
    ctx.stroke();
  }
  
  // Border frame
  ctx.fillStyle = '#5c4a35';
  ctx.fillRect(0, 0, BOARD_SIZE, MARGIN);
  ctx.fillRect(0, BOARD_SIZE - MARGIN, BOARD_SIZE, MARGIN);
  ctx.fillRect(0, MARGIN, MARGIN, BOARD_SIZE - MARGIN * 2);
  ctx.fillRect(BOARD_SIZE - MARGIN, MARGIN, MARGIN, BOARD_SIZE - MARGIN * 2);
  
  // Inner border
  ctx.strokeStyle = '#8b6f47';
  ctx.lineWidth = 4;
  ctx.strokeRect(MARGIN - 2, MARGIN - 2, PLAY_AREA + 4, PLAY_AREA + 4);
  
  // Playing area with slight darker shade
  ctx.fillStyle = 'rgba(139,111,71,0.05)';
  ctx.fillRect(MARGIN, MARGIN, PLAY_AREA, PLAY_AREA);
  
  // Center circle
  ctx.strokeStyle = '#8b6f47';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(centerX, centerY, 80, 0, Math.PI * 2);
  ctx.stroke();
  
  ctx.beginPath();
  ctx.arc(centerX, centerY, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#8b6f47';
  ctx.fill();
  
  // Baseline guides
  const drawBaseline = (y) => {
    ctx.strokeStyle = 'rgba(139,111,71,0.3)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(MARGIN + 100, y);
    ctx.lineTo(BOARD_SIZE - MARGIN - 100, y);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  drawBaseline(MARGIN + BASELINE_Y);
  drawBaseline(BOARD_SIZE - MARGIN - BASELINE_Y);
  
  // Corner pockets (TRIANGULAR)
  const corners = [
    { x: MARGIN, y: MARGIN },
    { x: BOARD_SIZE - MARGIN, y: MARGIN },
    { x: MARGIN, y: BOARD_SIZE - MARGIN },
    { x: BOARD_SIZE - MARGIN, y: BOARD_SIZE - MARGIN }
  ];
  
  corners.forEach(corner => {
    ctx.fillStyle = '#000';
    ctx.beginPath();
    
    // Triangle pointing to corner
    if (corner.x === MARGIN && corner.y === MARGIN) {
      // Top-left
      ctx.moveTo(corner.x, corner.y);
      ctx.lineTo(corner.x + POCKET_SIZE, corner.y);
      ctx.lineTo(corner.x, corner.y + POCKET_SIZE);
    } else if (corner.x === BOARD_SIZE - MARGIN && corner.y === MARGIN) {
      // Top-right
      ctx.moveTo(corner.x, corner.y);
      ctx.lineTo(corner.x - POCKET_SIZE, corner.y);
      ctx.lineTo(corner.x, corner.y + POCKET_SIZE);
    } else if (corner.x === MARGIN && corner.y === BOARD_SIZE - MARGIN) {
      // Bottom-left
      ctx.moveTo(corner.x, corner.y);
      ctx.lineTo(corner.x + POCKET_SIZE, corner.y);
      ctx.lineTo(corner.x, corner.y - POCKET_SIZE);
    } else {
      // Bottom-right
      ctx.moveTo(corner.x, corner.y);
      ctx.lineTo(corner.x - POCKET_SIZE, corner.y);
      ctx.lineTo(corner.x, corner.y - POCKET_SIZE);
    }
    
    ctx.closePath();
    ctx.fill();
    
    // Pocket border
    ctx.strokeStyle = '#8b6f47';
    ctx.lineWidth = 2;
    ctx.stroke();
  });
  
  // Pucks with shadow
  state.pucks.forEach(p => {
    if (p.pocketed) return;
    
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.arc(p.x + 3, p.y + 3, PUCK_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    
    // Puck
    const img = p.type === 'red' ? images.pukRed : (p.owner === 1 ? images.pukWhite : images.pukBlack);
    ctx.drawImage(img, p.x - PUCK_RADIUS, p.y - PUCK_RADIUS, PUCK_RADIUS * 2, PUCK_RADIUS * 2);
  });
  
  // Striker
  if (state.striker && !state.striker.active) {
    striker = { ...state.striker };
    
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.arc(striker.x + 4, striker.y + 4, STRIKER_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    
    // Striker
    ctx.drawImage(images.striker, striker.x - STRIKER_RADIUS, striker.y - STRIKER_RADIUS, STRIKER_RADIUS * 2, STRIKER_RADIUS * 2);
    
    // Highlight if my turn
    if (gameState && gameState.turn === myPlayerNum) {
      ctx.strokeStyle = 'rgba(132,204,22,0.6)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(striker.x, striker.y, STRIKER_RADIUS + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (state.striker && state.striker.active) {
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.arc(state.striker.x + 4, state.striker.y + 4, STRIKER_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    
    // Moving striker
    ctx.drawImage(images.striker, state.striker.x - STRIKER_RADIUS, state.striker.y - STRIKER_RADIUS, STRIKER_RADIUS * 2, STRIKER_RADIUS * 2);
  }
  
  // Aiming guide
  if (isDragging && dragStart && striker && gameState && gameState.turn === myPlayerNum) {
    const dx = dragStart.x - striker.x;
    const dy = dragStart.y - striker.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const power = Math.min(dist / 250, 1);
    
    // Aim line
    ctx.strokeStyle = `rgba(132,204,22,${0.4 + power * 0.4})`;
    ctx.lineWidth = 6;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(striker.x, striker.y);
    
    // Project trajectory
    const projDist = 400;
    const angle = Math.atan2(dy, dx);
    const endX = striker.x + Math.cos(angle) * projDist;
    const endY = striker.y + Math.sin(angle) * projDist;
    ctx.lineTo(endX, endY);
    ctx.stroke();
    
    // Arrow head
    ctx.fillStyle = 'rgba(132,204,22,0.8)';
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - Math.cos(angle - 0.3) * 20, endY - Math.sin(angle - 0.3) * 20);
    ctx.lineTo(endX - Math.cos(angle + 0.3) * 20, endY - Math.sin(angle + 0.3) * 20);
    ctx.closePath();
    ctx.fill();
    
    // Power indicator
    document.getElementById('powerUI').classList.add('show');
    document.getElementById('powerFill').style.width = (power * 100) + '%';
    document.getElementById('powerValue').textContent = Math.round(power * 100);
  } else {
    document.getElementById('powerUI').classList.remove('show');
  }
}

function onMouseDown(e) {
  if (!gameState || gameState.turn !== myPlayerNum || gameState.striker.active) return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (BOARD_SIZE / rect.width);
  const y = (e.clientY - rect.top) * (BOARD_SIZE / rect.height);
  
  if (striker && Math.sqrt(Math.pow(x - striker.x, 2) + Math.pow(y - striker.y, 2)) < STRIKER_RADIUS + 10) {
    isDragging = true;
    dragStart = { x, y };
  }
}

function onMouseMove(e) {
  if (!isDragging || !striker) return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (BOARD_SIZE / rect.width);
  const y = (e.clientY - rect.top) * (BOARD_SIZE / rect.height);
  dragStart = { x, y };
  renderBoard(gameState);
}

function onMouseUp(e) {
  if (!isDragging || !striker || !dragStart) return;
  isDragging = false;
  
  const dx = striker.x - dragStart.x;
  const dy = striker.y - dragStart.y;
  const power = Math.min(Math.sqrt(dx * dx + dy * dy) / 125, 2.5);
  
  if (power < 0.1) {
    dragStart = null;
    renderBoard(gameState);
    return;
  }
  
  socket.emit('carrom_shoot', { vx: dx * power * 0.8, vy: dy * power * 0.8 });
  dragStart = null;
  renderBoard(gameState);
}

function onTouchStart(e) {
  e.preventDefault();
  const touch = e.touches[0];
  onMouseDown({ clientX: touch.clientX, clientY: touch.clientY });
}

function onTouchMove(e) {
  e.preventDefault();
  const touch = e.touches[0];
  onMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
}

function onTouchEnd(e) {
  e.preventDefault();
  onMouseUp({});
}

// ── INIT ──────────────────────────────────────────────────────
if (!authToken) {
  document.getElementById('authOverlay').classList.remove('hidden');
}

document.getElementById('loginPass').addEventListener('keyup', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('loginUser').addEventListener('keyup', e => { if (e.key === 'Enter') doLogin(); });
