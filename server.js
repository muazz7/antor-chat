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

// ── Database Setup (Hybrid Postgres & SQLite) ──
const usePostgres = process.env.DATABASE_URL && (process.env.DATABASE_URL.startsWith('postgres://') || process.env.DATABASE_URL.startsWith('postgresql://'));

let dbClient = null;

if (usePostgres) {
  const { Pool } = require('pg');
  dbClient = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false // Required for Neon / Render Managed PG
    }
  });
  console.log('✦ Database: Connected to PostgreSQL');
} else {
  const Database = require('better-sqlite3');
  const dbPath = path.join(__dirname, 'antor.db');
  dbClient = new Database(dbPath);
  dbClient.pragma('journal_mode = WAL');
  console.log('✦ Database: Connected to SQLite');
}

// Unified query helper abstracting PostgreSQL and SQLite differences
async function query(sql, params = []) {
  if (usePostgres) {
    // Convert SQLite "?" placeholders to PostgreSQL "$1, $2, etc."
    let index = 1;
    const pgSql = sql.replace(/\?/g, () => `$${index++}`);
    const res = await dbClient.query(pgSql, params);
    return res;
  } else {
    const stmt = dbClient.prepare(sql);
    let rows = [];
    let rowCount = 0;
    if (sql.trim().toUpperCase().startsWith('SELECT')) {
      rows = stmt.all(params);
    } else {
      const info = stmt.run(params);
      rowCount = info.changes;
    }
    return { rows, rowCount };
  }
}

// Async schema setup
async function initDb() {
  if (usePostgres) {
    await query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        sender TEXT NOT NULL,
        sender_role TEXT NOT NULL DEFAULT 'guest',
        content TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
    dbClient.exec(`
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
  }
}

initDb().catch(err => console.error('Database setup failed:', err));

// Migration: add deleted_at column if it doesn't exist yet (SQLite only)
if (!usePostgres) {
  try {
    dbClient.exec(`ALTER TABLE rooms ADD COLUMN deleted_at TEXT DEFAULT NULL`);
  } catch (e) {
    // Column already exists, ignore
  }
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

app.post('/api/rooms', requireAdmin, async (req, res) => {
  const { name, userId, password } = req.body;
  if (!name || !userId || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const id = uuidv4();
  const slug = generateSlug();
  const passwordHash = bcrypt.hashSync(password, 10);

  try {
    await query(`
      INSERT INTO rooms (id, slug, name, user_id, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `, [id, slug, name, userId, passwordHash]);

    const roomRes = await query('SELECT * FROM rooms WHERE id = ?', [id]);
    const room = roomRes.rows[0];

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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rooms', requireAdmin, async (req, res) => {
  try {
    const roomsRes = await query('SELECT * FROM rooms WHERE deleted_at IS NULL ORDER BY created_at DESC');
    const result = roomsRes.rows.map(r => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      userId: r.user_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      link: `/chat/${r.slug}`
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rooms/:id', requireAdmin, async (req, res) => {
  const { userId, password } = req.body;
  try {
    const roomRes = await query('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
    const room = roomRes.rows[0];
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const newUserId = userId || room.user_id;
    const newPasswordHash = password ? bcrypt.hashSync(password, 10) : room.password_hash;

    await query(`
      UPDATE rooms SET user_id = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [newUserId, newPasswordHash, req.params.id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Soft-delete: move to recycle bin
app.delete('/api/rooms/:id', requireAdmin, async (req, res) => {
  try {
    const roomRes = await query('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
    const room = roomRes.rows[0];
    if (!room) return res.status(404).json({ error: 'Room not found' });

    await query(`UPDATE rooms SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════
// RECYCLE BIN ROUTES (Admin only)
// ═══════════════════════════════════

// List trashed rooms
app.get('/api/rooms/trash', requireAdmin, async (req, res) => {
  try {
    const roomsRes = await query('SELECT * FROM rooms WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
    const result = roomsRes.rows.map(r => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      userId: r.user_id,
      createdAt: r.created_at,
      deletedAt: r.deleted_at,
      link: `/chat/${r.slug}`
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore from recycle bin
app.post('/api/rooms/:id/restore', requireAdmin, async (req, res) => {
  try {
    const roomRes = await query('SELECT * FROM rooms WHERE id = ? AND deleted_at IS NOT NULL', [req.params.id]);
    const room = roomRes.rows[0];
    if (!room) return res.status(404).json({ error: 'Room not found in recycle bin' });

    await query('UPDATE rooms SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Permanently delete
app.delete('/api/rooms/:id/permanent', requireAdmin, async (req, res) => {
  try {
    const roomRes = await query('SELECT * FROM rooms WHERE id = ? AND deleted_at IS NOT NULL', [req.params.id]);
    const room = roomRes.rows[0];
    if (!room) return res.status(404).json({ error: 'Room not found in recycle bin' });

    await query('DELETE FROM messages WHERE room_id = ?', [req.params.id]);
    await query('DELETE FROM rooms WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════
// CHAT ROOM ROUTES (Guest)
// ═══════════════════════════════════

app.get('/api/rooms/:slug/info', async (req, res) => {
  try {
    const roomRes = await query('SELECT id, name, slug, deleted_at FROM rooms WHERE slug = ?', [req.params.slug]);
    const room = roomRes.rows[0];
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.deleted_at) return res.status(403).json({ error: 'This room is no longer available' });
    res.json({ name: room.name, slug: room.slug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rooms/:slug/auth', async (req, res) => {
  const { userId, password } = req.body;
  try {
    const roomRes = await query('SELECT * FROM rooms WHERE slug = ?', [req.params.slug]);
    const room = roomRes.rows[0];
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rooms/:slug/messages', async (req, res) => {
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

  try {
    const roomRes = await query('SELECT id FROM rooms WHERE slug = ?', [req.params.slug]);
    const room = roomRes.rows[0];
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const messagesRes = await query(`
      SELECT sender, sender_role, content, created_at
      FROM messages WHERE room_id = ?
      ORDER BY created_at ASC
    `, [room.id]);

    res.json(messagesRes.rows.map(m => ({
      sender: m.sender,
      senderRole: m.sender_role || 'guest',
      content: m.content,
      createdAt: m.created_at
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Serve Chat Page ──
app.get('/chat/:slug', async (req, res) => {
  try {
    const roomRes = await query('SELECT id, deleted_at FROM rooms WHERE slug = ?', [req.params.slug]);
    const room = roomRes.rows[0];
    if (!room) return res.status(404).send('Room not found');
    if (room.deleted_at) return res.status(403).send('This room is no longer available');
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
  } catch (err) {
    res.status(500).send('Internal Server Error');
  }
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

  socket.on('join-room', async (data) => {
    const { slug, sender, senderRole } = data;
    try {
      const roomRes = await query('SELECT id, name FROM rooms WHERE slug = ?', [slug]);
      const room = roomRes.rows[0];
      if (!room) return;

      socket.join(slug);
      socket.roomSlug = slug;
      socket.roomId = room.id;
      socket.sender = sender;
      socket.senderRole = senderRole || 'guest';

      // Notify others
      socket.to(slug).emit('user-joined', { sender, senderRole: socket.senderRole });
    } catch (err) {
      console.error('Socket join room failed:', err);
    }
  });

  socket.on('send-message', async (data) => {
    const { content } = data;
    if (!socket.roomId || !content) return;

    try {
      // Save to DB
      await query(`
        INSERT INTO messages (room_id, sender, sender_role, content)
        VALUES (?, ?, ?, ?)
      `, [socket.roomId, socket.sender, socket.senderRole, content]);

      // Broadcast to room
      io.to(socket.roomSlug).emit('new-message', {
        sender: socket.sender,
        senderRole: socket.senderRole,
        content,
        createdAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('Socket send message failed:', err);
    }
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
