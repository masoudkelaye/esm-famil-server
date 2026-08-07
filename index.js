const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'client')));

// ============ DATA ============
const rooms = new Map();
const LETTERS = 'آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی';

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += c[Math.floor(Math.random() * c.length)];
  return code;
}

function randLetter() {
  return LETTERS[Math.floor(Math.random() * LETTERS.length)];
}

const DEFAULT_CATS = [
  { id: 'name',    name: 'اسم',     icon: '👤' },
  { id: 'family',  name: 'فامیل',   icon: '👨‍👩‍👧‍👦' },
  { id: 'city',    name: 'شهر',     icon: '🏙️' },
  { id: 'country', name: 'کشور',    icon: '🌍' },
  { id: 'food',    name: 'غذا',     icon: '🍲' },
  { id: 'animal',  name: 'حیوان',   icon: '🐾' },
];

// ============ SOCKETS ============
io.on('connection', (socket) => {
  console.log('[+] connected:', socket.id);

  socket.on('create_room', ({ playerName }) => {
    let code;
    do { code = genCode(); } while (rooms.has(code));

    const room = {
      code,
      hostId: socket.id,
      players: { [socket.id]: { id: socket.id, name: playerName || 'بازیکن', score: 0 } },
      state: 'waiting',
      round: 1,
      maxRounds: 5,
      timePerRound: 60,
      currentLetter: '',
      answers: {},
      categories: DEFAULT_CATS,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room_created', { code, isHost: true });
    broadcastRoom(code);
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('error', { message: 'اتاق پیدا نشد!' }); return; }
    if (room.state !== 'waiting') { socket.emit('error', { message: 'بازی شروع شده!' }); return; }
    if (Object.keys(room.players).length >= 8) { socket.emit('error', { message: 'اتاق پر شده!' }); return; }

    room.players[socket.id] = { id: socket.id, name: playerName || 'بازیکن', score: 0 };
    socket.join(code);
    socket.emit('room_joined', { code, isHost: false });
    broadcastRoom(code);
  });

  socket.on('start_game', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (Object.keys(room.players).length < 2) {
      socket.emit('error', { message: 'حداقل ۲ بازیکن لازمه!' });
      return;
    }
    room.state = 'playing';
    room.round = 1;
    room.currentLetter = randLetter();
    room.answers = {};

    io.to(roomCode).emit('game_started', {
      letter: room.currentLetter, round: room.round, maxRounds: room.maxRounds,
      timePerRound: room.timePerRound, categories: room.categories,
    });
    broadcastRoom(roomCode);
  });

  socket.on('submit_answers', ({ roomCode, answers }) => {
    const room = rooms.get(roomCode);
    if (!room || room.state !== 'playing') return;
    room.answers[socket.id] = answers;
    socket.emit('answers_received');

    const total = Object.keys(room.players).length;
    const done = Object.keys(room.answers).length;
    io.to(roomCode).emit('answers_progress', { submitted: done, total });

    if (done >= total) calcAndShowResults(room);
  });

  socket.on('next_round', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.round++;
    room.currentLetter = randLetter();
    room.answers = {};
    room.state = 'playing';

    io.to(roomCode).emit('new_round', {
      letter: room.currentLetter, round: room.round, maxRounds: room.maxRounds,
      timePerRound: room.timePerRound, categories: room.categories,
    });
    broadcastRoom(roomCode);
  });

  socket.on('finish_game', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.state = 'finished';

    const totalScores = {};
    Object.keys(room.players).forEach(pid => {
      totalScores[pid] = room.players[pid].score || 0;
    });
    io.to(roomCode).emit('game_finished', { totalScores, players: room.players });
  });

  socket.on('play_again', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.round = 1;
    room.currentLetter = randLetter();
    room.answers = {};
    room.state = 'playing';
    Object.keys(room.players).forEach(pid => { room.players[pid].score = 0; });

    io.to(roomCode).emit('new_round', {
      letter: room.currentLetter, round: room.round, maxRounds: room.maxRounds,
      timePerRound: room.timePerRound, categories: room.categories,
    });
    broadcastRoom(roomCode);
  });

  socket.on('disconnect', () => {
    console.log('[-] disconnected:', socket.id);
    for (const [code, room] of rooms.entries()) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        if (Object.keys(room.players).length === 0) { rooms.delete(code); return; }
        if (room.hostId === socket.id) room.hostId = Object.keys(room.players)[0];
        broadcastRoom(code);
        return;
      }
    }
  });
});

// ============ HELPERS ============
function broadcastRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('room_update', {
    code: room.code, hostId: room.hostId, players: room.players,
    state: room.state, round: room.round,
  });
}

function calcAndShowResults(room) {
  const results = {};
  Object.keys(room.players).forEach(pid => {
    results[pid] = { total: 0, details: {} };
  });

  room.categories.forEach(cat => {
    const groups = {};
    Object.keys(room.players).forEach(pid => {
      const ans = (room.answers[pid] || {})[cat.id] || '';
      if (ans.trim()) {
        const key = ans.trim();
        if (!groups[key]) groups[key] = [];
        groups[key].push(pid);
      }
    });

    Object.keys(room.players).forEach(pid => {
      const ans = (room.answers[pid] || {})[cat.id] || '';
      if (!ans.trim()) { results[pid].details[cat.id] = { answer: '', score: 0 }; return; }
      const group = groups[ans.trim()];
      const score = group.length === 1 ? 20 : 10;
      results[pid].details[cat.id] = { answer: ans.trim(), score };
      results[pid].total += score;
    });
  });

  Object.keys(room.players).forEach(pid => {
    room.players[pid].score = (room.players[pid].score || 0) + results[pid].total;
  });

  const totalScores = {};
  Object.keys(room.players).forEach(pid => { totalScores[pid] = room.players[pid].score; });

  room.state = 'waiting_next';
  io.to(room.code).emit('round_results', { results, totalScores, round: room.round, letter: room.currentLetter });
  broadcastRoom(room.code);
}

// ============ START ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Esm-Famil server running on port ${PORT}`));
