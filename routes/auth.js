const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { audit } = require('../middleware/audit');

const SALT_ROUNDS = 12;
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 60 * 60 * 1000,
};

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = await User.findOne({ $or: [{ email: email.toLowerCase() }, { username }] });
    if (existing) {
      audit('register_failed', req, { username, meta: { reason: 'duplicate' }, ok: false });
      return res.status(409).json({ error: 'Username or email already in use.' });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const newUser = await User.create({ username, email, password: hashedPassword });

    audit('register', req, { userId: newUser._id, username });
    res.status(201).json({ message: 'Account created. You can now log in.' });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      audit('login_failed', req, { meta: { email: email.toLowerCase() }, ok: false });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      audit('login_failed', req, { userId: user._id, username: user.username, meta: { reason: 'wrong_password' }, ok: false });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign(
      { id: user._id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Update last login timestamp
    User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() }).catch(() => {});

    res.cookie('token', token, COOKIE_OPTIONS);
    audit('login', req, { userId: user._id, username: user.username });
    res.json({ message: 'Login successful.', username: user.username });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  // Try to get user info from cookie for the audit log
  try {
    const jwt_ = require('jsonwebtoken');
    const token = req.cookies.token;
    if (token) {
      const decoded = jwt_.verify(token, process.env.JWT_SECRET);
      audit('logout', req, { userId: decoded.id, username: decoded.username });
    }
  } catch { /* ignore — still clear the cookie */ }

  res.clearCookie('token', COOKIE_OPTIONS);
  res.json({ message: 'Logged out successfully.' });
});

module.exports = router;

