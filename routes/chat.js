const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const User = require('../models/User');
const Message = require('../models/Message');

// Deterministic room ID — same for both directions
function getRoomId(a, b) {
  return [a, b].sort().join('__');
}

// GET /api/chat/users — all registered users except the caller
router.get('/users', verifyToken, async (req, res) => {
  try {
    const users = await User.find(
      { username: { $ne: req.user.username } },
      'username -_id'
    ).sort({ username: 1 });
    res.json(users.map((u) => u.username));
  } catch (err) {
    console.error('Chat users error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/chat/global — last 200 messages in the global channel
router.get('/global', verifyToken, async (req, res) => {
  try {
    const messages = await Message.find({ roomId: '__global__' })
      .sort({ createdAt: 1 })
      .limit(200)
      .select('from text createdAt -_id');
    res.json(messages);
  } catch (err) {
    console.error('Global history error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/chat/history/:username — last 200 messages with a specific user
router.get('/history/:username', verifyToken, async (req, res) => {
  try {
    const other = req.params.username;

    // Validate that the target user exists
    const target = await User.findOne({ username: other }, '_id');
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const roomId = getRoomId(req.user.username, other);
    const messages = await Message.find({ roomId })
      .sort({ createdAt: 1 })
      .limit(200)
      .select('from text createdAt -_id');

    res.json(messages);
  } catch (err) {
    console.error('Chat history error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
