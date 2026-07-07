const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// ── App & Server ──
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Config ──
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = 'asAntor';
const ADMIN_PASSWORD = 'AnTor7*7';
const SESSION_SECRET = 'antor-secret-key-' + uuidv4();

// In-memory chat tokens (per-tab authentication)
// Map<token, { slug, userId, expiresAt }>
const chatTokens = new Map();
const CHAT_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Cleanup expired tokens every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of chatTokens) {
    if (now > data.expiresAt) chatTokens.delete(token);
  }
}, 30 * 60 * 1000);

// ── Database ──
const dbPath = process.env.DATABASE_URL || path.join(__dirname, 'antor.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_role TEXT NOT NULL DEFAULT 'guest',
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );
`);

// Migration: add deleted_at column if it doesn't exist yet
try {
  db.exec(`ALTER TABLE rooms ADD COLUMN deleted_at TEXT DEFAULT NULL`);
} catch (e) {
  // Column already exists, ignore
}

// ── Middleware ──
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Share session with Socket.io
io.engine.use(sessionMiddleware);

// ── Auth Middleware ──
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Helper: generate slug ──
function generateSlug() {
  return uuidv4().split('-').slice(0, 2).join('');
}

// ═══════════════════════════════════
// ADMIN AUTH ROUTES
// ═══════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    req.session.username = ADMIN_USERNAME;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ═══════════════════════════════════
// ROOM ROUTES (Admin only)
// ═══════════════════════════════════

app.post('/api/rooms', requireAdmin, (req, res) => {
  const { name, userId, password } = req.body;
  if (!name || !userId || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const id = uuidv4();
  const slug = generateSlug();
  const passwordHash = bcrypt.hashSync(password, 10);

  const stmt = db.prepare(`
    INSERT INTO rooms (id, slug, name, user_id, password_hash)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(id, slug, name, userId, passwordHash);

  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
  res.json({
    success: true,
    room: {
      id: room.id,
      slug: room.slug,
      name: room.name,
      userId: room.user_id,
      createdAt: room.created_at,
      link: `/chat/${room.slug}`
    }
  });
});

app.get('/api/rooms', requireAdmin, (req, res) => {
  const rooms = db.prepare('SELECT * FROM rooms WHERE deleted_at IS NULL ORDER BY created_at DESC').all();
  const result = rooms.map(r => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    userId: r.user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    link: `/chat/${r.slug}`
  }));
  res.json(result);
});

app.put('/api/rooms/:id', requireAdmin, (req, res) => {
  const { userId, password } = req.body;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const newUserId = userId || room.user_id;
  const newPasswordHash = password ? bcrypt.hashSync(password, 10) : room.password_hash;

  db.prepare(`
    UPDATE rooms SET user_id = ?, password_hash = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newUserId, newPasswordHash, req.params.id);

  res.json({ success: true });
});

// Soft-delete: move to recycle bin
app.delete('/api/rooms/:id', requireAdmin, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  db.prepare(`UPDATE rooms SET deleted_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════
// RECYCLE BIN ROUTES (Admin only)
// ═══════════════════════════════════

// List trashed rooms
app.get('/api/rooms/trash', requireAdmin, (req, res) => {
  const rooms = db.prepare('SELECT * FROM rooms WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all();
  const result = rooms.map(r => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    userId: r.user_id,
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
    link: `/chat/${r.slug}`
  }));
  res.json(result);
});

// Restore from recycle bin
app.post('/api/rooms/:id/restore', requireAdmin, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found in recycle bin' });

  db.prepare('UPDATE rooms SET deleted_at = NULL, updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Permanently delete
app.delete('/api/rooms/:id/permanent', requireAdmin, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found in recycle bin' });

  db.prepare('DELETE FROM messages WHERE room_id = ?').run(req.params.id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════
// CHAT ROOM ROUTES (Guest)
// ═══════════════════════════════════

app.get('/api/rooms/:slug/info', (req, res) => {
  const room = db.prepare('SELECT id, name, slug, deleted_at FROM rooms WHERE slug = ?').get(req.params.slug);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.deleted_at) return res.status(403).json({ error: 'This room is no longer available' });
  res.json({ name: room.name, slug: room.slug });
});

app.post('/api/rooms/:slug/auth', (req, res) => {
  const { userId, password } = req.body;
  const room = db.prepare('SELECT * FROM rooms WHERE slug = ?').get(req.params.slug);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.deleted_at) return res.status(403).json({ error: 'This room is no longer available' });

  if (room.user_id !== userId || !bcrypt.compareSync(password, room.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Don't persist chat auth in session — every tab must re-authenticate
  // Generate a per-tab token
  const chatToken = uuidv4();
  chatTokens.set(chatToken, {
    slug: room.slug,
    userId,
    expiresAt: Date.now() + CHAT_TOKEN_TTL
  });

  res.json({ success: true, roomName: room.name, chatToken });
});

app.get('/api/rooms/:slug/messages', (req, res) => {
  // Check if admin or authenticated via per-tab chat token
  const isAdmin = req.session && req.session.isAdmin;
  const chatToken = req.query.chat_token;
  let isTokenAuth = false;

  if (chatToken && chatTokens.has(chatToken)) {
    const tokenData = chatTokens.get(chatToken);
    if (tokenData.slug === req.params.slug && Date.now() <= tokenData.expiresAt) {
      isTokenAuth = true;
    }
  }

  if (!isAdmin && !isTokenAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const room = db.prepare('SELECT id FROM rooms WHERE slug = ?').get(req.params.slug);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const messages = db.prepare(`
    SELECT sender, sender_role, content, created_at
    FROM messages WHERE room_id = ?
    ORDER BY created_at ASC
  `).all(room.id);

  res.json(messages.map(m => ({
    sender: m.sender,
    senderRole: m.sender_role,
    content: m.content,
    createdAt: m.created_at
  })));
});

// ── Serve Chat Page ──
app.get('/chat/:slug', (req, res) => {
  const room = db.prepare('SELECT id, deleted_at FROM rooms WHERE slug = ?').get(req.params.slug);
  if (!room) return res.status(404).send('Room not found');
  if (room.deleted_at) return res.status(403).send('This room is no longer available');
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// ── Serve Dashboard ──
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ═══════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('join-room', (data) => {
    const { slug, sender, senderRole } = data;
    const room = db.prepare('SELECT id, name FROM rooms WHERE slug = ?').get(slug);
    if (!room) return;

    socket.join(slug);
    socket.roomSlug = slug;
    socket.roomId = room.id;
    socket.sender = sender;
    socket.senderRole = senderRole || 'guest';

    // Notify others
    socket.to(slug).emit('user-joined', { sender, senderRole: socket.senderRole });
  });

  socket.on('send-message', (data) => {
    const { content } = data;
    if (!socket.roomId || !content) return;

    // Save to DB
    db.prepare(`
      INSERT INTO messages (room_id, sender, sender_role, content)
      VALUES (?, ?, ?, ?)
    `).run(socket.roomId, socket.sender, socket.senderRole, content);

    // Broadcast to room
    io.to(socket.roomSlug).emit('new-message', {
      sender: socket.sender,
      senderRole: socket.senderRole,
      content,
      createdAt: new Date().toISOString()
    });
  });

  socket.on('typing', () => {
    if (socket.roomSlug) {
      socket.to(socket.roomSlug).emit('user-typing', { sender: socket.sender });
    }
  });

  socket.on('stop-typing', () => {
    if (socket.roomSlug) {
      socket.to(socket.roomSlug).emit('user-stop-typing', { sender: socket.sender });
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomSlug) {
      socket.to(socket.roomSlug).emit('user-left', { sender: socket.sender });
    }
  });
});

// ── Start ──
server.listen(PORT, () => {
  console.log(`\n  ✦ Antor is running at http://localhost:${PORT}\n`);
});
