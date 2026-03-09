require('dotenv').config();
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const path = require('path');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const chatRoutes = require('./routes/chat');
const newsRoutes = require('./routes/news');
const threadsRoutes = require('./routes/threads');
const setupChat = require('./sockets/chat');
const { startAggregator } = require('./server/newsAggregator');
const { seedThreads } = require('./server/seedThreads');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('Connected to MongoDB');
    // Seed predefined storyline threads (idempotent upsert)
    await seedThreads();
    // Start background news aggregation after DB is ready
    startAggregator();
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/threads', threadsRoutes);

// Socket.IO chat
setupChat(io);

// Catch-all: redirect unknown routes to login
app.use((req, res) => {
  res.redirect('/login.html');
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
