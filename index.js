const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() });
});

// ============ DATA ============
const rooms = new Map();
const LETTERS = 'آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی';

// 🔑 امتیازات جدید: ۱۰ یکتا، ۵ مشترک
const SCORE_UNIQUE = 10;
const SCORE_SHARED = 5;

// Disconnect grace period (ms) - بازیکن ۶۰ ثانیه فرصت داره reconnect کنه
const DISCONNECT_GRACE_MS = 60000;
const disconnectTimers = new Map(); // socketId -> timeout

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += c[Math.floor(Math.random() * c.length)];
  return code;
}

function randLetter() {
  return LETTERS[Math.floor(Math.random() * LETTERS.length)];
}

function genToken() {
  return Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
}

// ============ SOCKET EVENTS ============
io.on('connection', (socket) => {
  console.log('[+] متصل شد:', socket.id);

  // ---- ساخت اتاق ----
  socket.on('create_room', ({ playerName, categories }) => {
    // اگه توکن قبلی داره، چک کن شاید rejoin باشه
    let code;
    do { code = genCode(); } while (rooms.has(code));

    const token = genToken();

    const room = {
      code,
      hostId: socket.id,
      players: {
        [socket.id]: { id: socket.id, name: playerName || 'بازیکن', score: 0, token }
      },
      state: 'waiting',
      round: 1,
      maxRounds: 5,
      timePerRound: 60,
      currentLetter: '',
      answers: {},
      categories: categories && categories.length >= 3 ? categories : [
        { id: 'name', name: 'اسم', icon: '👤' },
        { id: 'family', name: 'فامیل', icon: '👨‍👩‍👧‍👦' },
        { id: 'city', name: 'شهر', icon: '🏙️' },
        { id: 'country', name: 'کشور', icon: '🌍' },
        { id: 'food', name: 'غذا', icon: '🍲' },
        { id: 'animal', name: 'حیوان', icon: '🐾' },
      ],
    };

    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.playerToken = token;
    socket.emit('room_created', { code, token });
    broadcastRoom(code);
  });

  // ---- ورود به اتاق ----
  socket.on('join_room', ({ roomCode, playerName }) => {
    const code = (roomCode || '').toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('error', 'اتاق پیدا نشد!');
      return;
    }
    if (room.state !== 'waiting') {
      socket.emit('error', 'بازی شروع شده!');
      return;
    }
    if (Object.keys(room.players).length >= 8) {
      socket.emit('error', 'اتاق پر شده!');
      return;
    }

    const token = genToken();
    room.players[socket.id] = { id: socket.id, name: playerName || 'بازیکن', score: 0, token };
    socket.join(code);
    socket.roomCode = code;
    socket.playerToken = token;
    socket.emit('room_joined', { code, token });
    broadcastRoom(code);
  });

  // ---- 🔧 Rejoin بعد از قطع اتصال (حل باگ ۵) ----
  socket.on('rejoin_room', ({ roomCode, token }) => {
    const code = (roomCode || '').toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('rejoin_failed', 'اتاق پیدا نشد');
      return;
    }

    // پیدا کردن بازیکن با token
    let oldId = null;
    for (const pid of Object.keys(room.players)) {
      if (room.players[pid].token === token) {
        oldId = pid;
        break;
      }
    }

    if (!oldId) {
      socket.emit('rejoin_failed', 'توکن نامعتبر');
      return;
    }

    // انتقال اطلاعات بازیکن از id قدیمی به جدید
    const playerData = room.players[oldId];
    delete room.players[oldId];
    playerData.id = socket.id;
    room.players[socket.id] = playerData;

    // اگه جواب قبلی ثبت شده بود، منتقل کن
    if (room.answers[oldId]) {
      room.answers[socket.id] = room.answers[oldId];
      delete room.answers[oldId];
    }

    // اگه host بود، منتقل کن
    if (room.hostId === oldId) {
      room.hostId = socket.id;
    }

    // لغو تایمر disconnect قبلی
    if (disconnectTimers.has(oldId)) {
      clearTimeout(disconnectTimers.get(oldId));
      disconnectTimers.delete(oldId);
    }

    socket.join(code);
    socket.roomCode = code;
    socket.playerToken = token;

    socket.emit('rejoin_success', {
      code,
      state: room.state,
      round: room.round,
      maxRounds: room.maxRounds,
      timePerRound: room.timePerRound,
      categories: room.categories,
      players: room.players,
      currentLetter: room.currentLetter,
      skippedPlayers: room.skippedPlayers || [],
      readyPlayers: room.readyPlayers || {},
      lastResults: room.lastResults || {},
      totalScores: (() => {
        const ts = {};
        Object.keys(room.players).forEach(pid => { ts[pid] = room.players[pid].score || 0; });
        return ts;
      })(),
    });

    broadcastRoom(code);
    console.log(`[rejoin] بازیکن ${playerData.name} دوباره وصل شد به اتاق ${code}`);
  });

  // ---- شروع بازی ----
  socket.on('start_game', ({ roomCode, categories, maxRounds, timePerRound }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (Object.keys(room.players).length < 2) {
      socket.emit('error', 'حداقل ۲ بازیکن لازمه!');
      return;
    }

    room.state = 'playing';
    room.round = 1;
    room.currentLetter = randLetter();
    room.answers = {};
    room.skippedPlayers = [];
    room.readyPlayers = {};
    if (categories && categories.length >= 3) room.categories = categories;
    if (maxRounds) room.maxRounds = maxRounds;
    if (timePerRound) room.timePerRound = timePerRound;

    io.to(roomCode).emit('game_started', {
      letter: room.currentLetter,
      round: room.round,
      maxRounds: room.maxRounds,
      timePerRound: room.timePerRound,
      categories: room.categories,
      players: room.players,
    });
    broadcastRoom(roomCode);
  });

  // ---- ثبت جواب‌ها ----
  socket.on('submit_answers', ({ roomCode, answers }) => {
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', 'اتاق پیدا نشد!');
      return;
    }
    if (room.state !== 'playing') {
      socket.emit('submit_ack', { ok: true, msg: 'بازی در حالت دیگری است' });
      return;
    }

    room.answers[socket.id] = answers;
    socket.emit('answers_received');
    socket.emit('submit_ack', { ok: true });

    const skipped = room.skippedPlayers || [];
    const activePlayers = Object.keys(room.players).filter(pid => !skipped.includes(pid));

    // 🔑 First submit ends the round for everyone!
    if (Object.keys(room.answers).length === 1) {
      const playerName = room.players[socket.id]?.name || '?';
      io.to(roomCode).emit('first_submit', { playerId: socket.id, playerName });
      
      // Wait 3 seconds then calculate results
      if (!room._submitTimer) {
        room._submitTimer = setTimeout(() => {
          room._submitTimer = null;
          if (room.state === 'playing') {
            calcAndShowResults(room);
          }
        }, 3000);
      }
    }

    const done = Object.keys(room.answers).filter(pid => !skipped.includes(pid)).length;
    io.to(roomCode).emit('answers_progress', { submitted: done, total: activePlayers.length });
  });

  // ---- 🔧 ویرایش امتیازات توسط میزبان ----
  socket.on('edit_scores', ({ roomCode, editedScores }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;

    // editedScores: { playerId: newTotal, ... }
    if (editedScores && typeof editedScores === 'object') {
      Object.keys(editedScores).forEach(pid => {
        if (room.players[pid]) {
          const newScore = parseInt(editedScores[pid]) || 0;
          room.players[pid].score = Math.max(0, newScore);
        }
      });

      const totalScores = {};
      Object.keys(room.players).forEach(pid => {
        totalScores[pid] = room.players[pid].score || 0;
      });

      io.to(roomCode).emit('scores_updated', { totalScores });
      broadcastRoom(roomCode);
    }
  });

  // ---- 🔧 حذف موقت بازیکن (فقط این راند) ----
  socket.on('skip_player', ({ roomCode, playerId }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (!room.players[playerId]) return;

    if (!room.skippedPlayers) room.skippedPlayers = [];
    if (!room.skippedPlayers.includes(playerId)) {
      room.skippedPlayers.push(playerId);
    }

    const playerName = room.players[playerId]?.name || '?';
    io.to(roomCode).emit('player_skipped', {
      playerId,
      playerName,
      skippedPlayers: room.skippedPlayers,
    });
    broadcastRoom(roomCode);
  });

  // ---- 🔧 ریاکشن ----
  socket.on('send_reaction', ({ roomCode, emoji }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    io.to(roomCode).emit('reaction_received', {
      playerId: socket.id,
      playerName: player.name,
      emoji,
    });
  });

  // ---- 🔧 آماده برای راند بعد ----
  socket.on('player_ready', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (!room.players[socket.id]) return;

    if (!room.readyPlayers) room.readyPlayers = {};
    room.readyPlayers[socket.id] = true;

    io.to(roomCode).emit('ready_update', {
      readyPlayers: room.readyPlayers,
    });

    // Check if all active players are ready → auto start next round
    const skipped = room.skippedPlayers || [];
    const activePlayers = Object.keys(room.players).filter(pid => !skipped.includes(pid));
    const readyCount = Object.keys(room.readyPlayers).filter(pid => !skipped.includes(pid)).length;

    if (readyCount >= activePlayers.length && activePlayers.length > 0) {
      room.round++;
      room.currentLetter = randLetter();
      room.answers = {};
      room.state = 'playing';
      room.skippedPlayers = [];
      room.readyPlayers = {};

      io.to(roomCode).emit('new_round', {
        letter: room.currentLetter,
        round: room.round,
        maxRounds: room.maxRounds,
        timePerRound: room.timePerRound,
        categories: room.categories,
      });
      broadcastRoom(roomCode);
    }
  });

  // ---- دور بعدی ----
  socket.on('next_round', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;

    room.round++;
    room.currentLetter = randLetter();
    room.answers = {};
    room.state = 'playing';
    room.skippedPlayers = [];
    room.readyPlayers = {};

    io.to(roomCode).emit('new_round', {
      letter: room.currentLetter,
      round: room.round,
      maxRounds: room.maxRounds,
      timePerRound: room.timePerRound,
      categories: room.categories,
    });
    broadcastRoom(roomCode);
  });

  // ---- پایان بازی ----
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

  // ---- بازی دوباره ----
  socket.on('play_again', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.round = 1;
    room.currentLetter = randLetter();
    room.answers = {};
    room.state = 'playing';
    Object.keys(room.players).forEach(pid => { room.players[pid].score = 0; });
    io.to(roomCode).emit('new_round', {
      letter: room.currentLetter,
      round: room.round,
      maxRounds: room.maxRounds,
      timePerRound: room.timePerRound,
      categories: room.categories,
    });
    broadcastRoom(roomCode);
  });

  // ---- ترک اتاق ----
  // ---- چت ----
  socket.on("chat_message", ({ roomCode, message }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.players[socket.id]) return;
    io.to(roomCode).emit("chat_message", {
      playerId: socket.id,
      playerName: room.players[socket.id].name,
      message,
    });
  });

  socket.on('leave_room', ({ roomCode }) => {
    leaveRoom(roomCode, socket, true);
  });

  // ---- 🔧 قطع اتصال با grace period (حل باگ ۵) ----
  socket.on('disconnect', () => {
    console.log('[-] قطع شد:', socket.id);
    const code = socket.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room || !room.players[socket.id]) return;

    // اگه بازی هنوز شروع نشده یا تموم شده، فوری حذف کن
    if (room.state === 'waiting' || room.state === 'finished') {
      leaveRoom(code, socket, true);
      return;
    }

    // 🔑 Grace period: ۶۰ ثانیه فرصت rejoin
    const playerId = socket.id;
    const playerName = room.players[playerId]?.name || '?';
    console.log(`[grace] بازیکن ${playerName} قطع شد، ${DISCONNECT_GRACE_MS/1000} ثانیه فرصت بازگشت`);

    // اطلاع به بقیه
    io.to(code).emit('player_disconnected', {
      playerId,
      playerName,
      graceMs: DISCONNECT_GRACE_MS,
    });

    const timer = setTimeout(() => {
      console.log(`[grace-timeout] بازیکن ${playerName} حذف شد از اتاق ${code}`);
      disconnectTimers.delete(playerId);
      leaveRoom(code, { id: playerId, roomCode: code }, true);
    }, DISCONNECT_GRACE_MS);

    disconnectTimers.set(playerId, timer);
  });
});

// ============ HELPERS ============
function leaveRoom(roomCode, socket, immediate) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const sid = socket.id;
  if (room.players[sid]) {
    delete room.players[sid];
  }
  if (socket.leave) socket.leave(roomCode);

  if (Object.keys(room.players).length === 0) {
    rooms.delete(roomCode);
    return;
  }

  if (room.hostId === sid) {
    room.hostId = Object.keys(room.players)[0];
  }

  broadcastRoom(roomCode);
}

function broadcastRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit('room_update', {
    code: room.code,
    hostId: room.hostId,
    players: room.players,
    state: room.state,
    round: room.round,
    skippedPlayers: room.skippedPlayers || [],
  });
}

function calcAndShowResults(room) {
  const results = {};
  const totalScores = {};
  const skipped = room.skippedPlayers || [];
  const activePlayers = Object.keys(room.players).filter(pid => !skipped.includes(pid));

  activePlayers.forEach(pid => {
    results[pid] = { total: 0, details: {} };
    totalScores[pid] = room.players[pid].score || 0;
  });

  room.categories.forEach(cat => {
    const groups = {};

    activePlayers.forEach(pid => {
      const ans = (room.answers[pid] || {})[cat.id] || '';
      if (ans.trim()) {
        const key = ans.trim();
        if (!groups[key]) groups[key] = [];
        groups[key].push(pid);
      }
    });

    activePlayers.forEach(pid => {
      const ans = (room.answers[pid] || {})[cat.id] || '';
      if (!ans.trim()) {
        results[pid].details[cat.id] = { answer: '', score: 0 };
        return;
      }
      // Validate: word must start with the round letter
      if (!ans.trim().startsWith(room.currentLetter)) {
        results[pid].details[cat.id] = { answer: ans.trim(), score: 0 };
        return;
      }
      const group = groups[ans.trim()];
      const score = group.length === 1 ? SCORE_UNIQUE : SCORE_SHARED;
      results[pid].details[cat.id] = { answer: ans.trim(), score };
      results[pid].total += score;
    });
  });

  activePlayers.forEach(pid => {
    room.players[pid].score = (room.players[pid].score || 0) + results[pid].total;
    totalScores[pid] = room.players[pid].score;
  });

  room.state = 'waiting_next';
  room.readyPlayers = {};
  room.lastResults = results;

  io.to(room.code).emit('round_results', {
    results,
    totalScores,
    round: room.round,
    letter: room.currentLetter,
    readyPlayers: {},
  });
  broadcastRoom(room.code);
}

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 سرور اسم فامیل روی پورت ${PORT} فعال شد`);
  console.log(`   امتیازات: یکتا=${SCORE_UNIQUE}، مشترک=${SCORE_SHARED}`);
});
