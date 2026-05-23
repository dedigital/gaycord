const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const MAX_TEXT_LENGTH = Number(process.env.MAX_TEXT_LENGTH || 2000);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 15 * 1024 * 1024);
const PBKDF2_ITERATIONS = Number(process.env.PBKDF2_ITERATIONS || 140000);
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const emptyDb = () => ({
  users: {},
  usernameIndex: {},
  sessions: {},
  friendships: {},
  servers: {},
  channels: {},
  messages: {}
});

let db = loadDb();
const onlineCounts = new Map();
const nativeClients = new Set();

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = emptyDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }

  try {
    return { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch (error) {
    console.error('Veritabani okunamadi:', error);
    return emptyDb();
  }
}

let saveTimer = null;
function saveDbSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }, 80);
}

function saveDbNow() {
  clearTimeout(saveTimer);
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

process.on('SIGINT', () => { saveDbNow(); process.exit(0); });
process.on('SIGTERM', () => { saveDbNow(); process.exit(0); });

function id(prefix = '') { return `${prefix}${crypto.randomBytes(10).toString('hex')}`; }
function inviteCode() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }
function now() { return new Date().toISOString(); }

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, displayName: user.displayName || user.username, createdAt: user.createdAt };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  const candidate = hashPassword(password, user.passwordSalt).hash;
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}

function normalizeUsername(username) { return String(username || '').trim().toLowerCase(); }

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(cookieHeader.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [rawKey, ...rawValue] = part.split('=');
    return [decodeURIComponent(rawKey), decodeURIComponent(rawValue.join('='))];
  }));
}

function getTokenFromRequest(req) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return parseCookies(req.headers.cookie || '').sid || '';
}

function getUserByToken(token) {
  if (!token) return null;
  const session = db.sessions[token];
  if (!session) return null;
  const user = db.users[session.userId];
  if (!user) return null;
  session.lastSeenAt = now();
  saveDbSoon();
  return user;
}

function auth(req, res, next) {
  const user = getUserByToken(getTokenFromRequest(req));
  if (!user) return res.status(401).json({ error: 'Giris gerekli.' });
  req.user = user;
  next();
}

function friendshipKey(a, b) { return [a, b].sort().join(':'); }
function getFriendship(a, b) { return db.friendships[friendshipKey(a, b)] || null; }
function areFriends(a, b) { const friendship = getFriendship(a, b); return Boolean(friendship && friendship.status === 'accepted'); }
function dmChannelId(a, b) { return `dm_${[a, b].sort().join('_')}`; }

function createOrGetDm(a, b) {
  if (!areFriends(a, b)) return null;
  const channelId = dmChannelId(a, b);
  if (!db.channels[channelId]) {
    db.channels[channelId] = { id: channelId, type: 'dm', kind: 'text', name: 'DM', memberIds: [a, b].sort(), createdAt: now() };
    db.messages[channelId] = [];
    saveDbSoon();
  }
  return db.channels[channelId];
}

function canAccessChannel(userId, channelId) {
  const channel = db.channels[channelId];
  if (!channel) return false;
  if (channel.type === 'dm') return channel.memberIds.includes(userId);
  const server = db.servers[channel.serverId];
  return Boolean(server && server.memberIds.includes(userId));
}

function ensureServerView(server) {
  return {
    id: server.id,
    name: server.name,
    ownerId: server.ownerId,
    inviteCode: server.inviteCode,
    memberIds: server.memberIds,
    channels: server.channelIds.map((channelId) => db.channels[channelId]).filter(Boolean),
    createdAt: server.createdAt
  };
}

function friendSummaryFor(userId) {
  const friends = [];
  const incomingRequests = [];
  const outgoingRequests = [];

  for (const friendship of Object.values(db.friendships)) {
    if (!friendship.memberIds.includes(userId)) continue;
    const otherId = friendship.memberIds.find((memberId) => memberId !== userId);
    const other = publicUser(db.users[otherId]);
    if (!other) continue;
    if (friendship.status === 'accepted') friends.push({ ...other, online: onlineCounts.has(otherId), friendshipId: friendship.id });
    else if (friendship.toId === userId) incomingRequests.push({ id: friendship.id, from: other, createdAt: friendship.createdAt });
    else outgoingRequests.push({ id: friendship.id, to: other, createdAt: friendship.createdAt });
  }

  friends.sort((a, b) => a.displayName.localeCompare(b.displayName, 'tr'));
  return { friends, incomingRequests, outgoingRequests };
}

function serversFor(userId) {
  return Object.values(db.servers).filter((server) => server.memberIds.includes(userId)).map(ensureServerView).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

function uploadUrl(fileName) { return `${PUBLIC_URL}/uploads/${fileName}`.replace(/^\/\//, '/'); }

function sanitizeMessage(message) {
  const user = db.users[message.userId];
  return {
    id: message.id,
    channelId: message.channelId,
    type: message.type,
    user: publicUser(user),
    text: message.text || '',
    audioUrl: message.audioUrl || '',
    fileUrl: message.fileUrl || '',
    fileName: message.fileName || '',
    mimeType: message.mimeType || '',
    sizeBytes: message.sizeBytes || null,
    durationMs: message.durationMs || null,
    createdAt: message.createdAt
  };
}

function createMessage({ channelId, userId, type, text = '', audioUrl = '', fileUrl = '', fileName = '', mimeType = '', sizeBytes = null, durationMs = null }) {
  const message = { id: id('msg_'), channelId, userId, type, text, audioUrl, fileUrl, fileName, mimeType, sizeBytes, durationMs, createdAt: now() };
  db.messages[channelId] ||= [];
  db.messages[channelId].push(message);
  if (db.messages[channelId].length > 700) db.messages[channelId] = db.messages[channelId].slice(-700);
  saveDbSoon();
  return sanitizeMessage(message);
}

function decodeBase64Upload(dataUrlOrBase64, fallbackMimeType) {
  const raw = String(dataUrlOrBase64 || '');
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  const mimeType = String(match ? match[1] : fallbackMimeType || 'application/octet-stream').toLowerCase();
  const base64 = match ? match[2] : raw;
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('Dosya bos gorunuyor.');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`Dosya ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB sinirini asiyor.`);
  return { buffer, mimeType };
}

function extensionFor(mimeType, originalName = '') {
  const safeOriginal = path.basename(String(originalName || '')).toLowerCase();
  const ext = path.extname(safeOriginal).replace(/[^a-z0-9.]/g, '').slice(0, 12);
  if (ext) return ext.slice(1);
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg')) return 'jpg';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('pdf')) return 'pdf';
  return 'bin';
}

function persistUpload({ data, mimeType, fileName = '', prefix = 'file_' }) {
  const decoded = decodeBase64Upload(data, mimeType);
  const extension = extensionFor(decoded.mimeType, fileName);
  const storedName = `${id(prefix)}.${extension}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), decoded.buffer);
  return { storedName, url: uploadUrl(storedName), mimeType: decoded.mimeType, sizeBytes: decoded.buffer.length, originalName: fileName || storedName };
}

function sendNative(ws, type, payload = {}) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, ...payload }));
}

function broadcastNative(type, payload = {}, predicate = () => true) {
  for (const ws of nativeClients) {
    if (ws.readyState === ws.OPEN && predicate(ws)) sendNative(ws, type, payload);
  }
}

function broadcastMessage(channelId, message) {
  io.to(channelId).emit('message:new', message);
  broadcastNative('message:new', { message }, (ws) => ws.joinedChannels?.has(channelId));
}

function emitPresence() {
  const onlineIds = [...onlineCounts.keys()];
  io.emit('presence:update', { onlineIds });
  broadcastNative('presence:update', { onlineIds });
}

function createSession(userId) {
  const sessionToken = id('sess_');
  db.sessions[sessionToken] = { userId, createdAt: now(), lastSeenAt: now() };
  saveDbSoon();
  return sessionToken;
}

function setSessionCookie(res, token) {
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: Boolean(PUBLIC_URL.startsWith('https://')), maxAge: 1000 * 60 * 60 * 24 * 30 });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: MAX_UPLOAD_BYTES + 1024 * 1024, cors: { origin: false } });
const wss = new WebSocketServer({ noServer: true });

app.use(express.json({ limit: `${Math.ceil(MAX_UPLOAD_BYTES / 1024 / 1024) + 2}mb` }));
app.use('/uploads', express.static(UPLOAD_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=604800, immutable') }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'gaycord-v3', time: now() }));

app.post('/api/register', (req, res) => {
  const username = normalizeUsername(req.body.username);
  const displayName = String(req.body.displayName || username).trim().slice(0, 32);
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Kullanici adi 3-20 karakter olmali; harf, rakam ve _ kullan.' });
  if (password.length < 6) return res.status(400).json({ error: 'Sifre en az 6 karakter olmali.' });
  if (db.usernameIndex[username]) return res.status(409).json({ error: 'Bu kullanici adi alinmis.' });

  const userId = id('usr_');
  const { salt, hash } = hashPassword(password);
  const user = { id: userId, username, displayName, passwordSalt: salt, passwordHash: hash, createdAt: now() };
  db.users[userId] = user;
  db.usernameIndex[username] = userId;
  const sessionToken = createSession(userId);
  setSessionCookie(res, sessionToken);
  res.status(201).json({ user: publicUser(user), token: sessionToken });
});

app.post('/api/login', (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  const userId = db.usernameIndex[username];
  const user = db.users[userId];
  if (!user || !verifyPassword(password, user)) return res.status(401).json({ error: 'Kullanici adi veya sifre hatali.' });
  const sessionToken = createSession(user.id);
  setSessionCookie(res, sessionToken);
  res.json({ user: publicUser(user), token: sessionToken });
});

app.post('/api/logout', auth, (req, res) => {
  const token = getTokenFromRequest(req);
  if (token) delete db.sessions[token];
  saveDbSoon();
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: publicUser(req.user), friends: friendSummaryFor(req.user.id), servers: serversFor(req.user.id), onlineIds: [...onlineCounts.keys()] });
});

app.get('/api/search-users', auth, (req, res) => {
  const q = normalizeUsername(req.query.q).slice(0, 32);
  if (q.length < 2) return res.json({ users: [] });
  const users = Object.values(db.users).filter((user) => user.id !== req.user.id).filter((user) => user.username.includes(q) || (user.displayName || '').toLowerCase().includes(q)).slice(0, 10).map((user) => ({ ...publicUser(user), friendship: getFriendship(req.user.id, user.id)?.status || null }));
  res.json({ users });
});

app.post('/api/friends/request', auth, (req, res) => {
  const username = normalizeUsername(req.body.username);
  const otherId = db.usernameIndex[username];
  const other = db.users[otherId];
  if (!other || other.id === req.user.id) return res.status(404).json({ error: 'Kullanici bulunamadi.' });
  const key = friendshipKey(req.user.id, other.id);
  const existing = db.friendships[key];
  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'Zaten arkadassiniz.' });
    return res.status(409).json({ error: 'Arkadaslik istegi zaten var.' });
  }
  const friendship = { id: id('fr_'), memberIds: [req.user.id, other.id], fromId: req.user.id, toId: other.id, status: 'pending', createdAt: now() };
  db.friendships[key] = friendship;
  saveDbSoon();
  res.status(201).json({ friendship });
});

app.post('/api/friends/respond', auth, (req, res) => {
  const requestId = String(req.body.requestId || '');
  const accept = Boolean(req.body.accept);
  const friendship = Object.values(db.friendships).find((item) => item.id === requestId);
  if (!friendship || friendship.toId !== req.user.id || friendship.status !== 'pending') return res.status(404).json({ error: 'Istek bulunamadi.' });
  if (accept) { friendship.status = 'accepted'; friendship.acceptedAt = now(); createOrGetDm(friendship.memberIds[0], friendship.memberIds[1]); }
  else { delete db.friendships[friendshipKey(friendship.memberIds[0], friendship.memberIds[1])]; }
  saveDbSoon();
  res.json({ ok: true });
});

app.get('/api/dms/:friendId', auth, (req, res) => {
  const channel = createOrGetDm(req.user.id, req.params.friendId);
  if (!channel) return res.status(403).json({ error: 'DM icin once arkadas olmalisiniz.' });
  res.json({ channel });
});

app.post('/api/servers', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (name.length < 2) return res.status(400).json({ error: 'Sunucu adi en az 2 karakter olmali.' });
  const serverId = id('srv_');
  const channelId = id('chn_');
  const voiceChannelId = id('chn_');
  const serverObj = { id: serverId, name, ownerId: req.user.id, inviteCode: inviteCode(), memberIds: [req.user.id], channelIds: [channelId, voiceChannelId], createdAt: now() };
  db.servers[serverId] = serverObj;
  db.channels[channelId] = { id: channelId, type: 'server', kind: 'text', serverId, name: 'genel', createdAt: now() };
  db.channels[voiceChannelId] = { id: voiceChannelId, type: 'server', kind: 'voice', serverId, name: 'ses-odasi', createdAt: now() };
  db.messages[channelId] = [];
  db.messages[voiceChannelId] = [];
  saveDbSoon();
  res.status(201).json({ server: ensureServerView(serverObj) });
});

app.post('/api/servers/join', auth, (req, res) => {
  const code = String(req.body.inviteCode || '').trim().toUpperCase();
  const serverObj = Object.values(db.servers).find((server) => server.inviteCode === code);
  if (!serverObj) return res.status(404).json({ error: 'Davet kodu bulunamadi.' });
  if (!serverObj.memberIds.includes(req.user.id)) serverObj.memberIds.push(req.user.id);
  saveDbSoon();
  res.json({ server: ensureServerView(serverObj) });
});

app.post('/api/servers/:serverId/channels', auth, (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Sunucu bulunamadi.' });
  if (serverObj.ownerId !== req.user.id) return res.status(403).json({ error: 'Sadece sunucu sahibi kanal acabilir.' });
  const kind = req.body.kind === 'voice' ? 'voice' : 'text';
  const name = String(req.body.name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  if (name.length < 2) return res.status(400).json({ error: 'Kanal adi en az 2 karakter olmali.' });
  const channelId = id('chn_');
  db.channels[channelId] = { id: channelId, type: 'server', kind, serverId: serverObj.id, name, createdAt: now() };
  db.messages[channelId] = [];
  serverObj.channelIds.push(channelId);
  saveDbSoon();
  res.status(201).json({ server: ensureServerView(serverObj), channel: db.channels[channelId] });
});

app.patch('/api/servers/:serverId', auth, (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Sunucu bulunamadi.' });
  if (serverObj.ownerId !== req.user.id) return res.status(403).json({ error: 'Sadece sunucu sahibi duzenleyebilir.' });
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (name.length < 2) return res.status(400).json({ error: 'Sunucu adi en az 2 karakter olmali.' });
  serverObj.name = name;
  serverObj.updatedAt = now();
  saveDbSoon();
  io.emit('server:updated', { server: ensureServerView(serverObj) });
  res.json({ server: ensureServerView(serverObj) });
});

app.delete('/api/servers/:serverId', auth, (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Sunucu bulunamadi.' });
  if (serverObj.ownerId !== req.user.id) return res.status(403).json({ error: 'Sadece sunucu sahibi sunucuyu silebilir.' });

  const deletedChannelIds = [...serverObj.channelIds];
  for (const channelId of deletedChannelIds) {
    delete db.messages[channelId];
    delete db.channels[channelId];
  }
  delete db.servers[serverObj.id];
  saveDbSoon();
  io.emit('server:deleted', { serverId: serverObj.id, channelIds: deletedChannelIds });
  broadcastNative('server:deleted', { serverId: serverObj.id, channelIds: deletedChannelIds });
  res.json({ ok: true, serverId: serverObj.id });
});

app.post('/api/servers/:serverId/leave', auth, (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Sunucu bulunamadi.' });
  if (serverObj.ownerId === req.user.id) return res.status(400).json({ error: 'Sahip oldugun sunucudan cikamazsin; istersen silebilirsin.' });

  serverObj.memberIds = serverObj.memberIds.filter((memberId) => memberId !== req.user.id);
  saveDbSoon();
  res.json({ ok: true, serverId: serverObj.id });
});

app.delete('/api/servers/:serverId/channels/:channelId', auth, (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  const channel = db.channels[req.params.channelId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id) || !channel || channel.serverId !== serverObj.id) return res.status(404).json({ error: 'Kanal bulunamadi.' });
  if (serverObj.ownerId !== req.user.id) return res.status(403).json({ error: 'Sadece sunucu sahibi kanal silebilir.' });
  if (serverObj.channelIds.length <= 1) return res.status(400).json({ error: 'Son kanali silemezsin.' });

  serverObj.channelIds = serverObj.channelIds.filter((channelId) => channelId !== channel.id);
  delete db.messages[channel.id];
  delete db.channels[channel.id];
  saveDbSoon();
  io.to(channel.id).emit('channel:deleted', { channelId: channel.id, serverId: serverObj.id });
  broadcastNative('channel:deleted', { channelId: channel.id, serverId: serverObj.id }, (ws) => ws.joinedChannels?.has(channel.id));
  res.json({ ok: true, server: ensureServerView(serverObj), channelId: channel.id });
});

app.get('/api/channels/:channelId/messages', auth, (req, res) => {
  const channelId = req.params.channelId;
  if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erisimin yok.' });
  const messages = (db.messages[channelId] || []).slice(-150).map(sanitizeMessage);
  res.json({ messages });
});

app.post('/api/channels/:channelId/messages', auth, (req, res) => {
  try {
    const channelId = req.params.channelId;
    if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erisimin yok.' });
    const type = String(req.body.type || 'text').toLowerCase();
    let message;
    if (type === 'text') {
      const text = String(req.body.text || '').trim().slice(0, MAX_TEXT_LENGTH);
      if (!text) return res.status(400).json({ error: 'Bos mesaj gonderilemez.' });
      message = createMessage({ channelId, userId: req.user.id, type: 'text', text });
    } else if (type === 'voice') {
      const upload = persistUpload({ data: req.body.audioData, mimeType: req.body.mimeType || 'audio/wav', fileName: req.body.fileName || 'voice.wav', prefix: 'voice_' });
      if (!upload.mimeType.startsWith('audio/')) return res.status(400).json({ error: 'Ses formati desteklenmiyor.' });
      message = createMessage({ channelId, userId: req.user.id, type: 'voice', audioUrl: upload.url, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, durationMs: Number(req.body.durationMs || 0) || null });
    } else if (type === 'file') {
      const upload = persistUpload({ data: req.body.fileData, mimeType: req.body.mimeType || 'application/octet-stream', fileName: req.body.fileName || 'dosya', prefix: 'file_' });
      message = createMessage({ channelId, userId: req.user.id, type: 'file', fileUrl: upload.url, fileName: upload.originalName, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, text: String(req.body.text || '').slice(0, 300) });
    } else return res.status(400).json({ error: 'Bilinmeyen mesaj turu.' });
    broadcastMessage(channelId, message);
    res.status(201).json({ message });
  } catch (error) { res.status(400).json({ error: error.message || 'Mesaj gonderilemedi.' }); }
});

io.use((socket, next) => {
  const user = getUserByToken(parseCookies(socket.handshake.headers.cookie || '').sid);
  if (!user) return next(new Error('Giris gerekli.'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  onlineCounts.set(userId, (onlineCounts.get(userId) || 0) + 1);
  emitPresence();
  socket.emit('session', { user: publicUser(socket.user), onlineIds: [...onlineCounts.keys()] });
  socket.on('channel:join', ({ channelId } = {}, callback = () => {}) => {
    if (!canAccessChannel(userId, channelId)) return callback({ error: 'Bu kanala erisimin yok.' });
    socket.join(channelId);
    callback({ ok: true, messages: (db.messages[channelId] || []).slice(-150).map(sanitizeMessage) });
  });
  socket.on('message:text', ({ channelId, text } = {}, callback = () => {}) => {
    if (!canAccessChannel(userId, channelId)) return callback({ error: 'Bu kanala erisimin yok.' });
    const clean = String(text || '').trim().slice(0, MAX_TEXT_LENGTH);
    if (!clean) return callback({ error: 'Bos mesaj gonderilemez.' });
    const message = createMessage({ channelId, userId, type: 'text', text: clean });
    broadcastMessage(channelId, message);
    callback({ ok: true, message });
  });
  socket.on('message:voice', ({ channelId, audioData, mimeType, durationMs } = {}, callback = () => {}) => {
    try {
      if (!canAccessChannel(userId, channelId)) return callback({ error: 'Bu kanala erisimin yok.' });
      const upload = persistUpload({ data: audioData, mimeType: mimeType || 'audio/webm', fileName: 'voice.webm', prefix: 'voice_' });
      if (!upload.mimeType.startsWith('audio/')) return callback({ error: 'Ses formati desteklenmiyor.' });
      const message = createMessage({ channelId, userId, type: 'voice', audioUrl: upload.url, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, durationMs: Number(durationMs || 0) || null });
      broadcastMessage(channelId, message);
      callback({ ok: true, message });
    } catch (error) { callback({ error: error.message || 'Sesli mesaj gonderilemedi.' }); }
  });
  socket.on('typing', ({ channelId, isTyping } = {}) => {
    if (!canAccessChannel(userId, channelId)) return;
    socket.to(channelId).emit('typing', { channelId, user: publicUser(socket.user), isTyping: Boolean(isTyping) });
  });
  socket.on('disconnect', () => {
    const nextCount = (onlineCounts.get(userId) || 1) - 1;
    if (nextCount <= 0) onlineCounts.delete(userId); else onlineCounts.set(userId, nextCount);
    emitPresence();
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/native') return socket.destroy();
  const token = url.searchParams.get('token') || '';
  const user = getUserByToken(token);
  if (!user) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    ws.joinedChannels = new Set();
    ws.voiceChannelId = null;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const userId = ws.user.id;
  nativeClients.add(ws);
  onlineCounts.set(userId, (onlineCounts.get(userId) || 0) + 1);
  emitPresence();
  sendNative(ws, 'session', { user: publicUser(ws.user), onlineIds: [...onlineCounts.keys()] });
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString('utf8')); } catch { return sendNative(ws, 'error', { error: 'Gecersiz veri.' }); }
    if (data.type === 'join_channel') {
      const channelId = String(data.channelId || '');
      if (!canAccessChannel(userId, channelId)) return sendNative(ws, 'error', { error: 'Bu kanala erisimin yok.' });
      ws.joinedChannels.add(channelId);
      sendNative(ws, 'joined_channel', { channelId, messages: (db.messages[channelId] || []).slice(-150).map(sanitizeMessage) });
      return;
    }
    if (data.type === 'leave_channel') { ws.joinedChannels.delete(String(data.channelId || '')); return; }
    if (data.type === 'voice_join') {
      const channelId = String(data.channelId || '');
      if (!canAccessChannel(userId, channelId)) return sendNative(ws, 'error', { error: 'Ses kanalina erisimin yok.' });
      ws.voiceChannelId = channelId;
      broadcastNative('voice:user_joined', { channelId, user: publicUser(ws.user) }, (client) => client !== ws && client.voiceChannelId === channelId);
      sendNative(ws, 'voice:joined', { channelId });
      return;
    }
    if (data.type === 'voice_leave') {
      const oldChannel = ws.voiceChannelId;
      ws.voiceChannelId = null;
      if (oldChannel) broadcastNative('voice:user_left', { channelId: oldChannel, user: publicUser(ws.user) }, (client) => client !== ws && client.voiceChannelId === oldChannel);
      return;
    }
    if (data.type === 'voice_frame') {
      const channelId = String(data.channelId || ws.voiceChannelId || '');
      const pcmBase64 = String(data.pcmBase64 || '');
      if (!channelId || ws.voiceChannelId !== channelId || !canAccessChannel(userId, channelId)) return;
      if (pcmBase64.length > 90000) return;
      broadcastNative('voice:frame', { channelId, from: publicUser(ws.user), pcmBase64 }, (client) => client !== ws && client.voiceChannelId === channelId);
    }
  });
  ws.on('close', () => {
    const oldChannel = ws.voiceChannelId;
    nativeClients.delete(ws);
    if (oldChannel) broadcastNative('voice:user_left', { channelId: oldChannel, user: publicUser(ws.user) }, (client) => client !== ws && client.voiceChannelId === oldChannel);
    const nextCount = (onlineCounts.get(userId) || 1) - 1;
    if (nextCount <= 0) onlineCounts.delete(userId); else onlineCounts.set(userId, nextCount);
    emitPresence();
  });
});

server.listen(PORT, () => console.log(`Gaycord V3 calisiyor: http://localhost:${PORT}`));
