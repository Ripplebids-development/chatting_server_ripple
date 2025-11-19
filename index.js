// c:\Users\emman\OneDrive\Desktop\chatting_server_ripple\server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const { URL } = require('url');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const db = new Database('chat.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomId TEXT NOT NULL,
    fromUser TEXT NOT NULL,
    text TEXT,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    messageId INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT,
    dataBase64 TEXT,
    FOREIGN KEY(messageId) REFERENCES messages(id) ON DELETE CASCADE
  );
`);
const insertMessage = db.prepare('INSERT INTO messages (roomId, fromUser, text, ts) VALUES (?, ?, ?, ?)');
const insertAttachment = db.prepare('INSERT INTO attachments (messageId, name, type, dataBase64) VALUES (?, ?, ?, ?)');
const selectMessages = db.prepare('SELECT * FROM messages WHERE roomId = ? ORDER BY ts ASC');
const selectAttachmentsForMsgs = db.prepare('SELECT * FROM attachments WHERE messageId IN (SELECT id FROM messages WHERE roomId = ?)');

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/messages', (req, res) => {
  const roomId = String(req.query.roomId || '').trim();
  if (!roomId) return res.status(400).json({ error: 'roomId required' });
  const msgs = selectMessages.all(roomId);
  const atts = selectAttachmentsForMsgs.all(roomId);
  const attByMsg = new Map();
  for (const a of atts) {
    const arr = attByMsg.get(a.messageId) || [];
    arr.push({ id: a.id, name: a.name, type: a.type || null, data: a.dataBase64 || null });
    attByMsg.set(a.messageId, arr);
  }
  const result = msgs.map(m => ({
    id: m.id,
    roomId: m.roomId,
    from: m.fromUser,
    text: m.text || '',
    ts: m.ts,
    attachments: attByMsg.get(m.id) || []
  }));
  res.json({ messages: result });
});

app.post('/messages', (req, res) => {
  const { roomId, from, text, ts, attachments } = req.body || {};
  const r = String(roomId || '').trim();
  const f = String(from || '').trim();
  const t = typeof text === 'string' ? text : '';
  const time = Number.isFinite(ts) ? ts : Date.now();
  if (!r || !f) return res.status(400).json({ error: 'roomId and from required' });
  const info = insertMessage.run(r, f, t, time);
  const msgId = info.lastInsertRowid;
  const atts = Array.isArray(attachments) ? attachments : [];
  for (const a of atts) {
    const name = String(a.name || '').trim();
    const type = a.type ? String(a.type) : null;
    const data = a.data ? String(a.data) : null;
    if (!name) continue;
    insertAttachment.run(msgId, name, type, data);
  }
  res.json({ id: msgId });
});

// Get message rooms for a seller
// Query param: `email` (seller email)
// Logic: returns rooms where roomId.split('-')[2] === sellerEmail.slice(4)
app.get('/getMessageRooms', (req, res) => {
  const sellerEmail = String(req.query.email || '').trim();
  if (!sellerEmail) return res.status(400).json({ error: 'email query param required' });

  // Collect room ids from active websocket rooms
  const activeRoomIds = Array.from(rooms.keys());

  // Collect room ids that have messages in DB
  let dbRoomIds = [];
  try {
    const rows = db.prepare('SELECT DISTINCT roomId FROM messages').all();
    dbRoomIds = rows.map(r => String(r.roomId));
  } catch (e) {
    // if DB read fails, just continue with active rooms
    console.error('failed to read rooms from db', e);
  }

  const allRoomIds = Array.from(new Set(activeRoomIds.concat(dbRoomIds)));

  const key = sellerEmail.slice(4);
  const matched = allRoomIds.filter(rid => {
    if (!rid) return false;
    const parts = String(rid).split('-');
    return parts[2] === key;
  });

  res.json({ rooms: matched });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/chat' });
const rooms = new Map();

function addToRoom(roomId, ws) {
  let set = rooms.get(roomId);
  if (!set) {
    set = new Set();
    rooms.set(roomId, set);
  }
  set.add(ws);
  ws.on('close', () => set.delete(ws));
}

function broadcast(roomId, payload) {
  const set = rooms.get(roomId);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const client of set) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

wss.on('connection', (ws, req) => {
  let roomId = '';
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    roomId = String(u.searchParams.get('roomId') || '').trim();
  } catch {}
  if (!roomId) {
    ws.close(1008, 'roomId required');
    return;
  }
  addToRoom(roomId, ws);
  console.log('ws client connected to room', roomId);
  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      data = { text: String(raw) };
    }
    const from = String((data && data.from) || '').trim();
    const text = typeof data.text === 'string' ? data.text : '';
    const time = Number.isFinite(data.ts) ? data.ts : Date.now();
    const r = String((data && data.roomId) || roomId);
    if (!r || !from) return;
    const info = insertMessage.run(r, from, text, time);
    const msgId = info.lastInsertRowid;
    const atts = Array.isArray(data.attachments) ? data.attachments : [];
    const storedAtts = [];
    for (const a of atts) {
      const name = String(a.name || '').trim();
      if (!name) continue;
      const type = a.type ? String(a.type) : null;
      const base64 = a.data ? String(a.data) : null;
      insertAttachment.run(msgId, name, type, base64);
      storedAtts.push({ name, type, data: base64 });
    }
    const payload = { roomId: r, from, text, ts: time, attachments: storedAtts };
    broadcast(r, payload);
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => {
  console.log(`chat server listening on http://localhost:${PORT}`);
});
server.on('error', (err) => {
  console.error('server error:', err);
});