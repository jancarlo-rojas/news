const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const Message = require('../models/Message');
const { audit } = require('../middleware/audit');

const GLOBAL_ROOM = '__global__';

// Deterministic room ID for 1-to-1 — same regardless of direction
function getRoomId(a, b) {
  return [a, b].sort().join('__');
}

function setupChat(io) {
  // --- Socket.IO authentication middleware ---
  io.use((socket, next) => {
    try {
      const raw = socket.handshake.headers.cookie || '';
      const cookies = cookie.parse(raw);
      const token = cookies.token;
      if (!token) return next(new Error('Authentication required.'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (err) {
      next(new Error('Invalid or expired session.'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`[socket] connected: ${socket.user.username} (${socket.id})`);

    // Auto-join global room on connect
    socket.join(GLOBAL_ROOM);

    socket.on('join_room', ({ partner }) => {
      if (!partner || typeof partner !== 'string') return;
      // Global room is already joined above; handle DM rooms
      if (partner === GLOBAL_ROOM) return;
      const roomId = getRoomId(socket.user.username, partner);
      socket.join(roomId);
    });

    socket.on('send_message', async ({ partner, text }) => {
      if (!partner || typeof partner !== 'string') return;
      if (!text || typeof text !== 'string') return;

      const sanitized = text.trim().slice(0, 2000);
      if (!sanitized) return;

      const isGlobal = partner === GLOBAL_ROOM;
      const roomId = isGlobal ? GLOBAL_ROOM : getRoomId(socket.user.username, partner);
      const to = isGlobal ? GLOBAL_ROOM : partner;
      const now = new Date();

      try {
        await Message.create({
          from:   socket.user.username,
          to,
          roomId,
          text:   sanitized,
        });
      } catch (err) {
        console.error('[socket] Message save error:', err.message);
        return;
      }

      io.to(roomId).emit('receive_message', {
        from:      socket.user.username,
        text:      sanitized,
        createdAt: now.toISOString(),
        roomId,
      });

      audit('message_sent', null, {
        userId:    socket.user.id,
        username:  socket.user.username,
        meta:      { to, roomId, length: sanitized.length },
        ip:        socket.handshake.address,
        userAgent: socket.handshake.headers['user-agent'],
      });
    });

    socket.on('disconnect', () => {
      console.log(`[socket] disconnected: ${socket.user.username}`);
    });
  });
}

module.exports = setupChat;
