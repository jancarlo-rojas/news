const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');

// GET /api/dashboard — returns authenticated user's info
router.get('/', verifyToken, (req, res) => {
  res.json({ username: req.user.username });
});

module.exports = router;
