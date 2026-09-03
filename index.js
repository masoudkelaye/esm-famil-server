const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, '..', 'client')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

// ============ DATA ============
const rooms = new Map();
const socketIndex = new Map();

const LETTERS = 'آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی';
const DEFAULT_CATS = [
  { id: 'name',    name: 'اسم',     icon: '👤' },
  { id: 'family',  name: 'فامیل',   icon: '👨‍👩‍👧‍👦' },
  { id: 'city',    name: 'شهر',     icon: '🏙️' },
  { id: 'country', name: 'کشور',    icon: '🌍' },
  { id: 'food',    name: 'غذا',     icon: '🍲' },
  { id: 'animal',  name: 'حیوان',   icon: '🐾' },
];

const DISCONNECT_GRACE_MS = 60000;
const ROUND_SAFETY_MARGIN_MS = 12000;

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += c[Math.floor(Math.random() * c.length)];
  return code;
}
function genToken() {
  return crypto.randomBytes(16).toString('hex');
}
function randLetter() {
  return LETTERS[Math.floor(Math.random() * LETTERS.length)];
}
function sanitizeCategories(categories) {
  if (!Array.isArray(categories) || categories.length < 3) return DEFAULT_CATS;
  const clean = categories
    .filter(c => c && typeof c.id === 'string' && typeof c.name === 'string')
    .slice(0, 15)
    .map(c => ({ id: String(c.id), name: String(c.name).slice(0, 20), icon: c.icon ? String(c.icon).slice(0, 8) : '📝' }));
  return clean.length >= 3 ? clean : DEFAULT_CATS;
}

function activePlayerIds(room) {
  return Object.keys(room.players).filter(pid =>
    room.players[pid].connected !== false && !room.skippedPlayers.includes(pid)
  );
}

function publicPlayers(room) {
  const out = {};
  Object.keys(room.players).forEach(pid => {
    const p = room.players[pid];
    out[pid] = { id: pid, name: p.name, score: p.score || 0 };
  });
  return out;
}

function publicPlayersScores(room) {
  const out = {};
  Object.keys(room.players).forEach(pid => { out[pid] = room.players[pid].score || 0; });
  return out;
}

function broadcastRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('room_update', {
    code: room.code,
    hostId: room.hostSocketId,
    players: publicPlayers(room),
    state: room.state,
    round: room.round,
    skippedPlayers: room.skippedPlayers,
  });
}

function clearRoundTimer(room) {
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
}

function armRoundSafetyTimer(room) {
  clearRoundTimer(room);
  const roundAtArm = room.round;
  room.roundTimer = setTimeout(() => {
    const r = rooms.get(room.code);
    if (!r || r.round !== roundAtArm || r.state !== 'playing') return;
    calcAndShowResults(r);
  }, (room.timePerRound + ROUND_SAFETY_MARGIN_MS / 1000) * 1000);
}

function beginRound(room, { isFirst }) {
  room.currentLetter = randLetter();
  room.answers = {};
  room.skippedPlayers = [];
  room.readyPlayers = {};
  room.state = 'playing';
  const payload = {
    letter: room.currentLetter,
    round: room.round,
    maxRounds: room.maxRounds,
    timePerRound: room.timePerRound,
    categories: room.categories,
  };
  io.to(room.code).emit(isFirst ? 'game_started' : 'new_round', payload);
  broadcastRoom(room.code);
  armRoundSafetyTimer(room);
}

const ALEF_SET = new Set(['ا', 'آ', 'أ', 'إ', 'ٱ']);
function normalizeLetter(ch) {
  if (!ch) return '';
  ch = String(ch)[0];
  if (ALEF_SET.has(ch)) return 'ا';
  if (ch === 'ة') return 'ه';
  if (ch === 'ي') return 'ی';
  if (ch === 'ك') return 'ک';
  return ch;
}
function normalizeWord(w) {
  return String(w || '')
    .trim()
    .replace(/\u200c/g, '')
    .replace(/[‌‍]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ة/g, 'ه')
    .replace(/[أإٱ]/g, 'ا');
}
function startsWithLetter(word, letter) {
  const w = normalizeWord(word);
  if (!w || !letter) return false;
  const first = normalizeLetter(w[0]);
  const need = normalizeLetter(letter);
  if (need === 'ا' || letter === 'آ') {
    return first === 'ا' || w[0] === 'آ' || ALEF_SET.has(w[0]);
  }
  return first === need;
}

// Offline Persian dictionary (~240k words, Dehkhoda-based)
const WORD_SET = new Set();
let dictReady = false;
try {
  const dictWords = require('an-array-of-persian-words');
  for (const raw of dictWords) {
    const n = String(raw || '')
      .trim()
      .replace(/\u200c/g, '')
      .replace(/ي/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/ة/g, 'ه')
      .replace(/[أإٱ]/g, 'ا');
    if (n.length >= 2) WORD_SET.add(n);
    const nospace = n.replace(/\s+/g, '');
    if (nospace.length >= 2 && nospace !== n) WORD_SET.add(nospace);
  }
  dictReady = true;
  console.log('Dictionary loaded: ' + WORD_SET.size + ' entries');
} catch (e) {
  console.warn('Dictionary package missing — heuristic only:', e.message);
}

function isPlausiblePersianWord(word) {
  const w = normalizeWord(word);
  if (w.length < 2) return false;
  if (!/^[\u0600-\u06FF\s]+$/.test(w)) return false;
  if (/^(.)\1+$/.test(w.replace(/\s/g, ''))) return false;
  return true;
}

function inDictionary(word) {
  const w = normalizeWord(word);
  if (!w) return false;
  if (WORD_SET.has(w)) return true;
  const nospace = w.replace(/\s+/g, '');
  if (nospace !== w && WORD_SET.has(nospace)) return true;
  const parts = w.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && parts.every(p => WORD_SET.has(p))) return true;
  return false;
}

function isValidAnswer(word, letter) {
  const w = normalizeWord(word);
  if (!w) return false;
  if (!startsWithLetter(w, letter)) return false;
  if (!isPlausiblePersianWord(w)) return false;
  if (dictReady) return inDictionary(w);
  return true;
}

app.get('/api/validate', (req, res) => {
  const word = String(req.query.word || '');
  const letter = String(req.query.letter || '');
  const normalized = normalizeWord(word);
  const starts = letter ? startsWithLetter(word, letter) : true;
  const plausible = isPlausiblePersianWord(word);
  const inDict = dictReady ? inDictionary(word) : null;
  const valid = letter ? isValidAnswer(word, letter) : (plausible && (inDict !== false));
  res.json({ word: normalized, letter: letter || null, startsWithLetter: starts, inDictionary: inDict, dictReady, valid });
});
app.get('/api/dict-status', (req, res) => res.json({ dictReady, size: WORD_SET.size }));

function calcAndShowResults(room) {
  clearRoundTimer(room);
  const ids = Object.keys(room.players);
  const results = {};
  ids.forEach(pid => { results[pid] = { total: 0, details: {} }; });

  const letter = room.currentLetter;
  room.categories.forEach(cat => {
    const groups = {};
    const normKey = (a) => normalizeWord(a);
    ids.forEach(pid => {
      const ans = (room.answers[pid] || {})[cat.id] || '';
      const trimmed = ans.trim();
      if (!trimmed) return;
      if (!isValidAnswer(trimmed, letter)) return;
      const key = normKey(trimmed);
      if (!groups[key]) groups[key] = [];
      groups[key].push(pid);
    });
    ids.forEach(pid => {
      const ans = ((room.answers[pid] || {})[cat.id] || '').trim();
      if (!ans) { results[pid].details[cat.id] = { answer: '', score: 0, invalid: false }; return; }
      if (!isValidAnswer(ans, letter)) {
        results[pid].details[cat.id] = { answer: ans, score: 0, invalid: true };
        return;
      }
      const key = normKey(ans);
      const group = groups[key] || [];
      const score = group.length === 1 ? 10 : 5;
      results[pid].details[cat.id] = { answer: ans, score, invalid: false };
      results[pid].total += score;
    });
  });

  room.roundBaseScores = {};
  ids.forEach(pid => { room.roundBaseScores[pid] = room.players[pid].score || 0; });
  ids.forEach(pid => {
    room.players[pid].score = (room.players[pid].score || 0) + results[pid].total;
  });
  const totalScores = {};
  ids.forEach(pid => { totalScores[pid] = room.players[pid].score; });

  room.state = 'waiting_next';
  room.lastResults = results;
  room.lastTotalScores = totalScores;
  room.readyPlayers = {};

  io.to(room.code).emit('round_results', {
    results, totalScores, round: room.round, letter: room.currentLetter, readyPlayers: {},
  });
  broadcastRoom(room.code);
}

function removePlayer(code, socketId, { notify }) {
  const room = rooms.get(code);
  if (!room || !room.players[socketId]) return;
  const wasHost = room.hostSocketId === socketId;
  const name = room.players[socketId].name;
  delete room.players[socketId];
  delete room.answers[socketId];
  delete room.readyPlayers[socketId];
  room.skippedPlayers = room.skippedPlayers.filter(id => id !== socketId);
  socketIndex.delete(socketId);
  if (Object.keys(room.players).length === 0) {
    clearRoundTimer(room);
    if (room.discTimers) Object.values(room.discTimers).forEach(t => clearTimeout(t));
    rooms.delete(code);
    return;
  }
  if (wasHost) room.hostSocketId = Object.keys(room.players)[0];
  if (notify) io.to(code).emit('player_disconnected', { playerName: name });
  broadcastRoom(code);
  if (room.state === 'playing') {
    const active = activePlayerIds(room);
    const done = active.filter(pid => room.answers[pid]).length;
    if (active.length > 0 && done >= active.length) calcAndShowResults(room);
  }
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ playerName, categories, maxRounds, timePerRound } = {}) => {
    let code;
    do { code = genCode(); } while (rooms.has(code));
    const token = genToken();
    const room = {
      code,
      hostSocketId: socket.id,
      players: { [socket.id]: { name: (playerName || 'بازیکن').slice(0, 24), score: 0, token, connected: true } },
      state: 'waiting',
      round: 1,
      maxRounds: (parseInt(maxRounds) >= 1 && parseInt(maxRounds) <= 20) ? parseInt(maxRounds) : 5,
      timePerRound: (parseInt(timePerRound) >= 10 && parseInt(timePerRound) <= 300) ? parseInt(timePerRound) : 60,
      currentLetter: '',
      answers: {},
      categories: sanitizeCategories(categories),
      skippedPlayers: [],
      readyPlayers: {},
      lastResults: {},
      lastTotalScores: {},
      roundBaseScores: {},
      discTimers: {},
      roundTimer: null,
    };
    rooms.set(code, room);
    socketIndex.set(socket.id, code);
    socket.join(code);
    socket.emit('room_created', { code, token, isHost: true });
    broadcastRoom(code);
  });

  socket.on('join_room', ({ roomCode, playerName } = {}) => {
    const code = (roomCode || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('error', { message: 'اتاق پیدا نشد!' }); return; }
    if (room.state !== 'waiting') { socket.emit('error', { message: 'بازی شروع شده!' }); return; }
    if (Object.keys(room.players).length >= 8) { socket.emit('error', { message: 'اتاق پر شده!' }); return; }
    const token = genToken();
    room.players[socket.id] = { name: (playerName || 'بازیکن').slice(0, 24), score: 0, token, connected: true };
    socketIndex.set(socket.id, code);
    socket.join(code);
    socket.emit('room_joined', { code, token, isHost: false });
    broadcastRoom(code);
  });

  socket.on('rejoin_room', ({ roomCode, token } = {}) => {
    const code = (roomCode || '').toUpperCase();
    const room = rooms.get(code);
    if (!room || !token) { socket.emit('rejoin_failed'); return; }
    const oldSocketId = Object.keys(room.players).find(pid => room.players[pid].token === token);
    if (!oldSocketId) { socket.emit('rejoin_failed'); return; }
    const wasHost = room.hostSocketId === oldSocketId;
    const player = room.players[oldSocketId];
    player.connected = true;
    if (oldSocketId !== socket.id) {
      delete room.players[oldSocketId];
      room.players[socket.id] = player;
      if (room.answers[oldSocketId] !== undefined) { room.answers[socket.id] = room.answers[oldSocketId]; delete room.answers[oldSocketId]; }
      if (room.readyPlayers[oldSocketId] !== undefined) { room.readyPlayers[socket.id] = room.readyPlayers[oldSocketId]; delete room.readyPlayers[oldSocketId]; }
      room.skippedPlayers = room.skippedPlayers.map(id => id === oldSocketId ? socket.id : id);
      if (room.roundBaseScores[oldSocketId] !== undefined) { room.roundBaseScores[socket.id] = room.roundBaseScores[oldSocketId]; delete room.roundBaseScores[oldSocketId]; }
      if (wasHost) room.hostSocketId = socket.id;
      socketIndex.delete(oldSocketId);
      if (room.discTimers[oldSocketId]) { clearTimeout(room.discTimers[oldSocketId]); delete room.discTimers[oldSocketId]; }
    }
    socketIndex.set(socket.id, code);
    socket.join(code);
    socket.emit('rejoin_success', {
      code: room.code,
      hostId: room.hostSocketId,
      players: publicPlayers(room),
      categories: room.categories,
      totalScores: publicPlayersScores(room),
      lastResults: room.lastResults || {},
      round: room.round,
      maxRounds: room.maxRounds,
      timePerRound: room.timePerRound,
      currentLetter: room.currentLetter,
      state: room.state,
      skippedPlayers: room.skippedPlayers,
    });
    broadcastRoom(code);
    if (room.state === 'playing') {
      const active = activePlayerIds(room);
      const done = active.filter(pid => room.answers[pid]).length;
      if (active.length > 0 && done >= active.length) calcAndShowResults(room);
    }
  });

  socket.on('leave_room', ({ roomCode } = {}) => {
    const code = (roomCode || socketIndex.get(socket.id) || '').toUpperCase();
    removePlayer(code, socket.id, { notify: true });
    socket.leave(code);
  });

  socket.on('start_game', ({ roomCode, categories, maxRounds, timePerRound } = {}) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostSocketId !== socket.id) return;
    if (Object.keys(room.players).length < 2) {
      socket.emit('error', { message: 'حداقل ۲ بازیکن لازمه!' });
      return;
    }
    if (categories) room.categories = sanitizeCategories(categories);
    if (parseInt(maxRounds) >= 1 && parseInt(maxRounds) <= 20) room.maxRounds = parseInt(maxRounds);
    if (parseInt(timePerRound) >= 10 && parseInt(timePerRound) <= 300) room.timePerRound = parseInt(timePerRound);
    room.round = 1;
    Object.values(room.players).forEach(p => { p.score = 0; });
    beginRound(room, { isFirst: true });
  });

  socket.on('submit_answers', ({ roomCode, answers } = {}) => {
    const room = rooms.get(roomCode);
    if (!room || room.state !== 'playing') return;
    const isFirst = Object.keys(room.answers).length === 0;
    room.answers[socket.id] = answers || {};
    socket.emit('submit_ack');
    if (isFirst) {
      const name = room.players[socket.id] ? room.players[socket.id].name : 'بازیکن';
      socket.to(roomCode).emit('first_submit', { playerName: name });
    }
    const active = activePlayerIds(room);
    const done = active.filter(pid => room.answers[pid]).length;
    io.to(roomCode).emit('answers_progress', { submitted: done, total: active.length });
    if (active.length > 0 && done >= active.length) calcAndShowResults(room);
  });

  socket.on('next_round', ({ roomCode } = {}) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostSocketId !== socket.id) return;
    if (room.round >= room.maxRounds) {
      room.state = 'finished';
      clearRoundTimer(room);
      io.to(roomCode).emit('game_finished', { totalScores: publicPlayersScores(room), players: publicPlayers(room) });
      return;
    }
    room.round++;
    beginRound(room, { isFirst: false });
  });

  socket.on('skip_player', ({ roomCode, playerId } = {}) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostSocketId !== socket.id) return;
    if (!room.players[playerId]) return;
    if (!room.skippedPlayers.includes(playerId)) room.skippedPlayers.push(playerId);
    io.to(roomCode).emit('player_skipped', { playerId, playerName: room.players[playerId].name, skippedPlayers: room.skippedPlayers });
    broadcastRoom(roomCode);
    if (room.state === 'playing') {
      const active = activePlayerIds(room);
      const done = active.filter(pid => room.answers[pid]).length;
      if (active.length > 0 && done >= active.length) calcAndShowResults(room);
    }
  });

  socket.on('player_ready', ({ roomCode } = {}) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.readyPlayers[socket.id] = true;
    io.to(roomCode).emit('ready_update', { readyPlayers: room.readyPlayers });
  });

  socket.on('send_reaction', ({ roomCode, emoji } = {}) => {
    const room = rooms.get(roomCode);
    if (!room || !room.players[socket.id]) return;
    io.to(roomCode).emit('reaction_received', { emoji, playerName: room.players[socket.id].name });
  });

  socket.on('chat_message', ({ roomCode, message } = {}) => {
    const room = rooms.get(roomCode);
    if (!room || !room.players[socket.id] || !message) return;
    const clean = String(message).slice(0, 300);
    io.to(roomCode).emit('chat_message', { playerName: room.players[socket.id].name, message: clean });
  });

  socket.on('edit_scores', ({ roomCode, editedScores } = {}) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostSocketId !== socket.id || !editedScores) return;
    Object.keys(editedScores).forEach(pid => {
      if (!room.players[pid]) return;
      const base = room.roundBaseScores[pid] || 0;
      const roundScore = Math.max(0, parseInt(editedScores[pid]) || 0);
      room.players[pid].score = base + roundScore;
    });
    io.to(roomCode).emit('scores_updated', { totalScores: publicPlayersScores(room) });
    broadcastRoom(roomCode);
  });

  socket.on('disconnect', () => {
    const code = socketIndex.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room || !room.players[socket.id]) { socketIndex.delete(socket.id); return; }
    room.players[socket.id].connected = false;
    broadcastRoom(code);
    if (room.state === 'playing') {
      const active = activePlayerIds(room);
      const done = active.filter(pid => room.answers[pid]).length;
      if (active.length > 0 && done >= active.length) calcAndShowResults(room);
    }
    room.discTimers[socket.id] = setTimeout(() => {
      const r = rooms.get(code);
      if (!r || !r.players[socket.id] || r.players[socket.id].connected) return;
      removePlayer(code, socket.id, { notify: true });
    }, DISCONNECT_GRACE_MS);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Esm-Famil server running on port ' + PORT));
