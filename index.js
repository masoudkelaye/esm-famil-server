const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

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

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // سرور - فقط بخش create_room تغییر کرده
  socket.on('create_room', ({ playerName, categories }) => {
    let code;
    do { code = genCode(); } while (rooms.has(code));
  
    const room = {
      code,
      hostId: socket.id,
      players: { [socket.id]: { id: socket.id, name: playerName || 'بازیکن', score: 0 } },
      state: 'waiting', round: 1, maxRounds: 5, timePerRound: 60,
      currentLetter: '', answers: {},
      categories: categories || DEFAULT_CATS,  // ← دسته‌بندی‌های دلخواه
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room_created', { code });
    broadcastRoom(code);
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('error', 'اتاق پیدا نشد!'); return; }
    if (room.state !== 'waiting') { socket.emit('error', 'بازی شروع شده!'); return; }
    
    room.players[socket.id] = { id: socket.id, name: playerName || 'Player', score: 0 };
    socket.join(code);
    socket.emit('room_joined', { code });
    broadcastRoom(code);
  });

  socket.on('start_game', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (Object.keys(room.players).length < 2) { socket.emit('error', 'حداقل ۲ بازیکن لازمه!'); return; }
    
    room.state = 'playing'; room.round = 1;
    room.currentLetter = randLetter(); room.answers = {};
    
    io.to(roomCode).emit('game_started', {
      letter: room.currentLetter, round: room.round, maxRounds: room.maxRounds,
      timePerRound: room.timePerRound, categories: room.categories, players: room.players,
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
    if (done >= total) calcResults(room);
  });

  socket.on('next_round', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.round++; room.currentLetter = randLetter(); room.answers = {}; room.state = 'playing';
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
    const ts = {};
    Object.keys(room.players).forEach(pid => { ts[pid] = room.players[pid].score || 0; });
    io.to(roomCode).emit('game_finished', { totalScores: ts, players: room.players });
  });

  socket.on('play_again', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.round = 1; room.currentLetter = randLetter(); room.answers = {}; room.state = 'playing';
    Object.keys(room.players).forEach(pid => { room.players[pid].score = 0; });
    io.to(roomCode).emit('new_round', {
      letter: room.currentLetter, round: room.round, maxRounds: room.maxRounds,
      timePerRound: room.timePerRound, categories: room.categories,
    });
    broadcastRoom(roomCode);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        if (Object.keys(room.players).length === 0) rooms.delete(code);
        else if (room.hostId === socket.id) room.hostId = Object.keys(room.players)[0];
        broadcastRoom(code);
        break;
      }
    }
  });
});

function broadcastRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('room_update', {
    code: room.code, hostId: room.hostId, players: room.players,
    state: room.state, round: room.round,
  });
}

function calcResults(room) {
  const results = {};
  Object.keys(room.players).forEach(pid => { results[pid] = { total: 0, details: {} }; });
  
  room.categories.forEach(cat => {
    const groups = {};
    Object.keys(room.players).forEach(pid => {
      const ans = (room.answers[pid] || {})[cat.id] || '';
      if (ans.trim()) { const k = ans.trim(); if (!groups[k]) groups[k] = []; groups[k].push(pid); }
    });
    Object.keys(room.players).forEach(pid => {
      const ans = (room.answers[pid] || {})[cat.id] || '';
      if (!ans.trim()) { results[pid].details[cat.id] = { answer: '', score: 0 }; return; }
      const sc = groups[ans.trim()].length === 1 ? 20 : 10;
      results[pid].details[cat.id] = { answer: ans.trim(), score: sc };
      results[pid].total += sc;
    });
  });

  Object.keys(room.players).forEach(pid => { room.players[pid].score = (room.players[pid].score || 0) + results[pid].total; });
  const ts = {}; Object.keys(room.players).forEach(pid => { ts[pid] = room.players[pid].score; });
  
  room.state = 'waiting_next';
  io.to(room.code).emit('round_results', { results, totalScores: ts, round: room.round, letter: room.currentLetter });
  broadcastRoom(room.code);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('🎮 Server running!'));
