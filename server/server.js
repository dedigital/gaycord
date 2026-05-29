const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let PgPool = null;
try { ({ Pool: PgPool } = require('pg')); } catch { PgPool = null; }

const PORT = Number(process.env.PORT || 3000);
const MAX_TEXT_LENGTH = Number(process.env.MAX_TEXT_LENGTH || 2000);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 15 * 1024 * 1024);
const MAX_BACKUP_BYTES = Number(process.env.MAX_BACKUP_BYTES || 60 * 1024 * 1024);
const PBKDF2_ITERATIONS = Number(process.env.PBKDF2_ITERATIONS || 310000);
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DATABASE_URL = String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '');
const DB_STATE_KEY = String(process.env.DB_STATE_KEY || 'gaycord_state_v4'); // bilerek sabit: güncellemelerde PostgreSQL verisi aynı anahtarda kalır
const APP_VERSION = '7.2.0';
const APP_NAME = 'gaycord-v7';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 30);
const CSRF_HEADER = 'x-gaycord-csrf';
const MAX_E2EE_TEXT_BYTES = Number(process.env.MAX_E2EE_TEXT_BYTES || process.env.MAX_E2EE_PAYLOAD_LENGTH || 16 * 1024);
const MAX_E2EE_METADATA_BYTES = Number(process.env.MAX_E2EE_METADATA_BYTES || 32 * 1024);
const MAX_SOCKET_EVENT_BYTES = Number(process.env.MAX_SOCKET_EVENT_BYTES || 256 * 1024);
const SOCKET_PING_INTERVAL_MS = Number(process.env.SOCKET_PING_INTERVAL_MS || 20 * 1000);
const SOCKET_PING_TIMEOUT_MS = Number(process.env.SOCKET_PING_TIMEOUT_MS || 120 * 1000);
const SOCKET_RECOVERY_MAX_MS = Number(process.env.SOCKET_RECOVERY_MAX_MS || 120 * 1000);
const MAX_STORED_MESSAGE_BYTES = Number(process.env.MAX_STORED_MESSAGE_BYTES || 48 * 1024);
const MAX_CHANNEL_MESSAGE_BYTES = Number(process.env.MAX_CHANNEL_MESSAGE_BYTES || 2 * 1024 * 1024);
const MAX_USER_MESSAGE_BYTES = Number(process.env.MAX_USER_MESSAGE_BYTES || 8 * 1024 * 1024);
const MAX_CHANNEL_MESSAGE_COUNT = Number(process.env.MAX_CHANNEL_MESSAGE_COUNT || 1000);
const MESSAGE_RATE_LIMIT = Number(process.env.MESSAGE_RATE_LIMIT || process.env.SOCKET_MESSAGE_LIMIT || 120);
const MESSAGE_RATE_WINDOW_MS = Number(process.env.MESSAGE_RATE_WINDOW_MS || process.env.SOCKET_MESSAGE_WINDOW_MS || 60 * 1000);
const SOCKET_MESSAGE_LIMIT = MESSAGE_RATE_LIMIT;
const SOCKET_MESSAGE_WINDOW_MS = MESSAGE_RATE_WINDOW_MS;
const SERVER_JOIN_RATE_LIMIT = Number(process.env.SERVER_JOIN_RATE_LIMIT || 5);
const SERVER_JOIN_RATE_WINDOW_MS = Number(process.env.SERVER_JOIN_RATE_WINDOW_MS || 15 * 60 * 1000);
const MAX_E2EE_PAYLOAD_LENGTH = MAX_E2EE_TEXT_BYTES;
const SECURITY_LOG_LIMIT = Number(process.env.SECURITY_LOG_LIMIT || 500);
const TRUSTED_ORIGINS = String(process.env.TRUSTED_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean);
const REQUIRE_HTTPS = String(process.env.REQUIRE_HTTPS || (process.env.RENDER === 'true' ? '1' : '0')) === '1';

const ROOT = __dirname;
const LEGACY_DATA_DIR = path.join(ROOT, 'data');
const DEFAULT_DATA_DIR = process.env.RENDER === 'true' && fs.existsSync('/var/data') ? '/var/data/gaycord' : LEGACY_DATA_DIR;
const DATA_DIR = path.resolve(process.env.GAYCORD_DATA_DIR || process.env.DATA_DIR || DEFAULT_DATA_DIR);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const LEGACY_DB_FILE = path.join(LEGACY_DATA_DIR, 'db.json');
const LEGACY_UPLOAD_DIR = path.join(LEGACY_DATA_DIR, 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Kalıcı diske geçtiğinde V3/V4 eski data klasörü varsa otomatik taşır.
if (DB_FILE !== LEGACY_DB_FILE && !fs.existsSync(DB_FILE) && fs.existsSync(LEGACY_DB_FILE)) {
  try {
    fs.copyFileSync(LEGACY_DB_FILE, DB_FILE);
    if (fs.existsSync(LEGACY_UPLOAD_DIR)) {
      for (const file of fs.readdirSync(LEGACY_UPLOAD_DIR)) {
        const src = path.join(LEGACY_UPLOAD_DIR, file);
        const dst = path.join(UPLOAD_DIR, file);
        if (fs.statSync(src).isFile() && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
      }
    }
  } catch (error) {
    console.warn('Eski veri otomatik taşınamadı:', error.message);
  }
}

function now() { return new Date().toISOString(); }
function id(prefix = '') { return `${prefix}${crypto.randomBytes(10).toString('hex')}`; }
function inviteCode() { return crypto.randomBytes(16).toString('hex').toUpperCase(); }
function normalizeInviteCode(value) { return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 96); }
function isStrongInviteCode(value) { return /^[A-F0-9]{32,}$/.test(String(value || '')); }
function inviteCodeInUse(state, code, exceptServerId = '') {
  return Object.entries(state.servers || {}).some(([id, server]) => id !== exceptServerId && normalizeInviteCode(server.inviteCode) === code);
}
function createUniqueInviteCode(state, exceptServerId = '') {
  let code = inviteCode();
  while (inviteCodeInUse(state, code, exceptServerId)) code = inviteCode();
  return code;
}

const emptyDb = () => ({
  version: 7,
  adminUserId: '',
  users: {},
  usernameIndex: {},
  sessions: {},
  friendships: {},
  servers: {},
  channels: {},
  messages: {},
  uploads: {},
  uploadBlobs: {},
  appSettings: { createdAt: now(), lastBackupHintAt: null },
  securityEvents: []
});

let db = emptyDb();
let pgPool = null;
let storageMode = 'file';
const onlineCounts = new Map();
const nativeClients = new Set();
const webVoiceClients = new Map();

function normalizeUsername(username) { return String(username || '').trim().toLowerCase(); }

function normalizeDb(raw) {
  const db = { ...emptyDb(), ...(raw || {}) };
  db.version = 7;
  db.users ||= {};
  db.usernameIndex ||= {};
  db.sessions ||= {};
  db.friendships ||= {};
  db.servers ||= {};
  db.channels ||= {};
  db.messages ||= {};
  db.uploads ||= {};
  db.uploadBlobs ||= {};
  db.appSettings ||= { createdAt: now(), lastBackupHintAt: null };
  db.securityEvents = Array.isArray(db.securityEvents) ? db.securityEvents.slice(-SECURITY_LOG_LIMIT) : [];

  db.usernameIndex = {};
  for (const [userId, user] of Object.entries(db.users)) {
    user.id ||= userId;
    user.username = normalizeUsername(user.username || userId.slice(0, 10));
    user.displayName ||= user.username;
    user.status ||= '';
    user.createdAt ||= now();
    user.settings = { theme: 'dark', compactMode: false, reduceMotion: false, e2eeHints: true, ...(user.settings || {}) };
    user.passwordIterations ||= user.passwordHash ? 140000 : undefined;
    user.failedLoginCount ||= 0;
    db.usernameIndex[user.username] = user.id;
  }

  if (!db.adminUserId) {
    const firstUser = Object.values(db.users).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0];
    if (firstUser) db.adminUserId = firstUser.id;
  }

  for (const [serverId, server] of Object.entries(db.servers)) {
    server.id ||= serverId;
    server.name ||= 'Sunucu';
    server.ownerId ||= server.memberIds?.[0] || db.adminUserId || '';
    const currentInvite = normalizeInviteCode(server.inviteCode);
    if (isStrongInviteCode(currentInvite) && !inviteCodeInUse(db, currentInvite, serverId)) {
      server.inviteCode = currentInvite;
    } else {
      if (currentInvite && !server.legacyInviteCode) server.legacyInviteCode = currentInvite;
      server.inviteCode = createUniqueInviteCode(db, serverId);
      server.inviteRotatedAt ||= now();
    }
    server.memberIds ||= [];
    server.channelIds ||= [];
    server.createdAt ||= now();
  }

  for (const [channelId, channel] of Object.entries(db.channels)) {
    channel.id ||= channelId;
    channel.kind ||= 'text';
    channel.type ||= channel.serverId ? 'server' : 'dm';
    db.messages[channelId] ||= [];
  }

  return db;
}

async function loadDb() {
  if (DATABASE_URL) {
    if (!PgPool) throw new Error('DATABASE_URL ayarlı ama pg paketi kurulu değil.');
    pgPool = new PgPool({
      connectionString: DATABASE_URL,
      ssl: /sslmode=require/i.test(DATABASE_URL) || process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
    });
    await pgPool.query(`CREATE TABLE IF NOT EXISTS gaycord_kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const result = await pgPool.query('SELECT value FROM gaycord_kv WHERE key = $1', [DB_STATE_KEY]);
    if (!result.rowCount) {
      let initialSource = emptyDb();
      // Veritabanına yeni geçerken aynı deploy içinde eski db.json bulunursa içeriği otomatik taşımayı dener.
      const candidates = [
        { dbFile: DB_FILE, uploadDir: UPLOAD_DIR },
        { dbFile: LEGACY_DB_FILE, uploadDir: LEGACY_UPLOAD_DIR }
      ];
      for (const candidate of candidates) {
        if (!fs.existsSync(candidate.dbFile)) continue;
        try {
          initialSource = JSON.parse(fs.readFileSync(candidate.dbFile, 'utf8'));
          initialSource = hydrateUploadBlobsFromDir(initialSource, candidate.uploadDir);
          break;
        } catch (error) {
          console.warn('Eski dosya verisi PostgreSQL içine taşınamadı:', error.message);
        }
      }
      const initial = normalizeDb(initialSource);
      await pgPool.query('INSERT INTO gaycord_kv(key, value) VALUES ($1, $2::jsonb)', [DB_STATE_KEY, JSON.stringify(initial)]);
      storageMode = 'postgres';
      return initial;
    }
    storageMode = 'postgres';
    return normalizeDb(result.rows[0].value);
  }

  storageMode = 'file';
  if (!fs.existsSync(DB_FILE)) {
    const initial = normalizeDb(emptyDb());
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const loaded = normalizeDb({ ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) });
    hydrateUploadBlobsFromDir(loaded, UPLOAD_DIR);
    return loaded;
  } catch (error) {
    console.error('Veritabani okunamadi:', error);
    return normalizeDb(emptyDb());
  }
}

async function saveDbNowAsync() {
  db.meta ||= { version: 7, createdAt: now(), ownerUserId: '' };
  db.meta.version = 7;
  db.meta.updatedAt = now();
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO gaycord_kv(key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [DB_STATE_KEY, JSON.stringify(db)]
    );
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let saveTimer = null;
function saveDbSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveDbNowAsync().catch((error) => console.error('Veritabani kaydedilemedi:', error));
  }, 120);
}
function saveDbNow() {
  clearTimeout(saveTimer);
  if (pgPool) saveDbNowAsync().catch((error) => console.error('Veritabani kaydedilemedi:', error));
  else {
    db.meta ||= { version: 7, createdAt: now(), ownerUserId: '' };
    db.meta.version = 7;
    db.meta.updatedAt = now();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
}
async function shutdown() {
  try { await saveDbNowAsync(); } catch (error) { console.error('Kapanirken kayit hatasi:', error); }
  try { await pgPool?.end(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex'), iterations = PBKDF2_ITERATIONS) {
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
  return { salt, hash, iterations };
}
function verifyPassword(password, user) {
  const iterations = Number(user.passwordIterations || 140000);
  const candidate = hashPassword(password, user.passwordSalt, iterations).hash;
  if (!/^[a-f0-9]{64}$/i.test(String(candidate)) || !/^[a-f0-9]{64}$/i.test(String(user.passwordHash || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}
function hashToken(token) { return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex'); }
function randomToken(prefix = '') { return `${prefix}${crypto.randomBytes(32).toString('base64url')}`; }
function getSessionByToken(token) {
  if (!token) return null;
  const hashed = hashToken(token);
  let session = db.sessions[hashed];
  if (!session && db.sessions[token]) {
    session = db.sessions[token];
    delete db.sessions[token];
    db.sessions[hashed] = session;
    saveDbSoon();
  }
  if (!session) return null;
  if (session.expiresAt && Date.parse(session.expiresAt) < Date.now()) { delete db.sessions[hashed]; saveDbSoon(); return null; }
  session.id = hashed;
  session.csrfToken ||= randomToken('csrf_');
  return session;
}

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
  const session = getSessionByToken(token);
  if (!session) return null;
  const user = db.users[session.userId];
  if (!user) return null;
  session.lastSeenAt = now();
  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  saveDbSoon();
  return user;
}
function auth(req, res, next) {
  const user = getUserByToken(getTokenFromRequest(req));
  if (!user) return res.status(401).json({ error: 'Giriş gerekli.' });
  req.user = user;
  next();
}
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    status: user.status || '',
    online: onlineCounts.has(user.id),
    createdAt: user.createdAt
  };
}

function meUser(user) {
  return { ...publicUser(user), settings: user?.settings || { theme: 'dark', compactMode: false, reduceMotion: false, e2eeHints: true } };
}

function isAdminUser(user) {
  return Boolean(user && db.adminUserId && user.id === db.adminUserId);
}

function requireAdmin(req, res, next) {
  if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Bu işlem için Gaycord yöneticisi olmalısın.' });
  next();
}

function friendshipKey(a, b) { return [a, b].sort().join(':'); }
function getFriendship(a, b) { return db.friendships[friendshipKey(a, b)] || null; }
function areFriends(a, b) { const f = getFriendship(a, b); return Boolean(f && f.status === 'accepted'); }
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
  if (channel.type === 'dm') return channel.memberIds?.includes(userId);
  const server = db.servers[channel.serverId];
  return Boolean(server && server.memberIds?.includes(userId));
}
function channelIsVoice(channelId) { const channel = db.channels[channelId]; return Boolean(channel && (channel.kind === 'voice' || channel.type === 'dm')); }
function canUseLiveVoice(userId, channelId) {
  const channel = db.channels[channelId];
  if (!channel || !canAccessChannel(userId, channelId)) return false;
  return channel.kind === 'voice' || channel.type === 'dm';
}

function ensureServerView(server, viewerId = '') {
  const members = (server.memberIds || []).map((memberId) => db.users[memberId]).filter(Boolean).map((user) => ({
    ...publicUser(user),
    owner: user.id === server.ownerId,
    isOwner: user.id === server.ownerId
  })).sort((a, b) => Number(b.online) - Number(a.online) || Number(b.owner) - Number(a.owner) || a.displayName.localeCompare(b.displayName, 'tr'));
  return {
    id: server.id,
    name: server.name,
    ownerId: server.ownerId,
    inviteCode: server.inviteCode,
    memberIds: server.memberIds || [],
    memberCount: (server.memberIds || []).length,
    members,
    isOwner: Boolean(viewerId && server.ownerId === viewerId),
    channels: (server.channelIds || []).map((channelId) => db.channels[channelId]).filter(Boolean),
    createdAt: server.createdAt
  };
}
function friendSummaryFor(userId) {
  const friends = [];
  const incomingRequests = [];
  const outgoingRequests = [];
  for (const friendship of Object.values(db.friendships)) {
    if (!friendship.memberIds?.includes(userId)) continue;
    const otherId = friendship.memberIds.find((id) => id !== userId);
    const other = publicUser(db.users[otherId]);
    if (!other) continue;
    if (friendship.status === 'accepted') friends.push({ ...other, friendshipId: friendship.id });
    else if (friendship.toId === userId) incomingRequests.push({ id: friendship.id, from: other, createdAt: friendship.createdAt });
    else outgoingRequests.push({ id: friendship.id, to: other, createdAt: friendship.createdAt });
  }
  friends.sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName, 'tr'));
  return { friends, incomingRequests, outgoingRequests };
}
function serversFor(userId) {
  return Object.values(db.servers).filter((server) => server.memberIds?.includes(userId)).map((server) => ensureServerView(server, userId)).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}


function isPersistentDataEnabled() {
  // PostgreSQL veya /var/data gibi explicit kalıcı disk kullanılıyorsa true.
  if (storageMode === 'postgres') return true;
  if (process.env.GAYCORD_DATA_DIR || process.env.DATA_DIR) return true;
  if (process.env.RENDER === 'true' && DATA_DIR.startsWith('/var/data')) return true;
  return false;
}
function needsPersistentSetup() {
  // Render'ın varsayılan dosya sistemi ephemeral; deploy/restart sonrası yerel dosya verisi silinebilir.
  return process.env.RENDER === 'true' && !isPersistentDataEnabled();
}

function uploadUrl(fileName) {
  const encoded = encodeURIComponent(fileName);
  if (PUBLIC_URL) return `${PUBLIC_URL}/uploads/${encoded}`;
  return `/uploads/${encoded}`;
}
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
    encrypted: Boolean(message.encrypted),
    e2ee: message.e2ee || null,
    createdAt: message.createdAt
  };
}
function approxStoredBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value || {}), 'utf8'); } catch { return MAX_STORED_MESSAGE_BYTES + 1; }
}
function channelMessageBytes(channelId) {
  return (db.messages[channelId] || []).reduce((sum, message) => sum + approxStoredBytes(message), 0);
}
function userMessageBytes(userId) {
  let total = 0;
  for (const list of Object.values(db.messages || {})) {
    if (!Array.isArray(list)) continue;
    for (const message of list) if (message?.userId === userId) total += approxStoredBytes(message);
  }
  return total;
}
function trimChannelMessages(channelId) {
  const list = db.messages[channelId] || [];
  let total = channelMessageBytes(channelId);
  while (list.length && (list.length > MAX_CHANNEL_MESSAGE_COUNT || total > MAX_CHANNEL_MESSAGE_BYTES)) {
    total -= approxStoredBytes(list.shift());
  }
  db.messages[channelId] = list;
}
function trimUserMessages(userId) {
  if (!userId) return;
  let total = userMessageBytes(userId);
  if (total <= MAX_USER_MESSAGE_BYTES) return;
  const rows = [];
  for (const [channelId, list] of Object.entries(db.messages || {})) {
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      if (message?.userId === userId) rows.push({ channelId, id: message.id, createdAt: message.createdAt || '', bytes: approxStoredBytes(message) });
    }
  }
  rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
  for (const row of rows) {
    if (total <= MAX_USER_MESSAGE_BYTES) break;
    const list = db.messages[row.channelId] || [];
    const index = list.findIndex((message) => message.id === row.id);
    if (index < 0) continue;
    total -= approxStoredBytes(list[index]);
    list.splice(index, 1);
  }
}
function enforceMessageAggregateLimits(channelId, userId) {
  trimChannelMessages(channelId);
  trimUserMessages(userId);
}
function createMessage({ channelId, userId, type, text = '', audioUrl = '', fileUrl = '', fileName = '', mimeType = '', sizeBytes = null, durationMs = null, encrypted = false, e2ee = null }) {
  const message = { id: id('msg_'), channelId, userId, type, text, audioUrl, fileUrl, fileName, mimeType, sizeBytes, durationMs, encrypted: Boolean(encrypted), e2ee: e2ee || null, createdAt: now() };
  const messageBytes = approxStoredBytes(message);
  if (messageBytes > Math.min(MAX_STORED_MESSAGE_BYTES, MAX_CHANNEL_MESSAGE_BYTES, MAX_USER_MESSAGE_BYTES)) throw new Error('Mesaj güvenlik sınırını aşıyor. Büyük dosyaları mesaj gövdesinde değil upload olarak gönder.');
  db.messages[channelId] ||= [];
  db.messages[channelId].push(message);
  enforceMessageAggregateLimits(channelId, userId);
  saveDbSoon();
  return sanitizeMessage(message);
}

function decodeBase64Upload(dataUrlOrBase64, fallbackMimeType) {
  const raw = String(dataUrlOrBase64 || '');
  const match = raw.match(/^data:([^;]+(?:;[^,]+)?);base64,(.+)$/);
  const mimeType = String(match ? match[1].split(';')[0] : fallbackMimeType || 'application/octet-stream').toLowerCase();
  const base64 = match ? match[2] : raw;
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('Dosya boş görünüyor.');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`Dosya ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB sınırını aşıyor.`);
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
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('pdf')) return 'pdf';
  return 'bin';
}
function mimeForFileName(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  const map = {
    '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.wav': 'audio/wav',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip'
  };
  return map[ext] || 'application/octet-stream';
}
const BLOCKED_UPLOAD_EXTENSIONS = new Set(['html','htm','svg','js','mjs','cjs','wasm','exe','dll','bat','cmd','ps1','sh','php','phtml','asp','aspx','jsp','jar','msi','scr','com']);
const ALLOWED_UPLOAD_MIMES = new Set([
  'image/png','image/jpeg','image/gif','image/webp',
  'audio/wav','audio/webm','audio/ogg','audio/mpeg','audio/mp4',
  'video/mp4','video/webm',
  'application/pdf','text/plain','application/zip','application/x-zip-compressed','application/octet-stream'
]);
function canonicalMime(mimeType) { return String(mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase(); }
function isProbablyText(buffer) {
  if (!buffer.length || buffer.length > 1024 * 1024) return false;
  for (let i = 0; i < Math.min(buffer.length, 4096); i += 1) if (buffer[i] === 0) return false;
  return true;
}
function detectMagicMime(buffer, fallback = '') {
  const fb = canonicalMime(fallback);
  if (buffer.length >= 8 && buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a','GIF89a'].includes(buffer.subarray(0,6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (buffer.length >= 4 && buffer.subarray(0,4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (buffer.length >= 3 && buffer.subarray(0,3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buffer.length >= 4 && buffer.subarray(0,4).toString('hex') === '1a45dfa3') return fb.includes('video') ? 'video/webm' : 'audio/webm';
  if (buffer.length >= 12 && buffer.subarray(4,8).toString('ascii') === 'ftyp') return fb.includes('audio') ? 'audio/mp4' : 'video/mp4';
  if (buffer.length >= 4 && buffer.subarray(0,4).toString('ascii') === '%PDF') return 'application/pdf';
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03,0x05,0x07].includes(buffer[2])) return 'application/zip';
  if (fb === 'text/plain' && isProbablyText(buffer)) return 'text/plain';
  return ''; // Bilinmeyen içeriği sadece Content-Type'a güvenerek kabul etme.
}
function sanitizeOriginalFileName(fileName) {
  const base = path.basename(String(fileName || 'dosya')).replace(/[\r\n\t]/g, ' ').trim().slice(0, 120) || 'dosya';
  return base.replace(/[<>:"\/\\|?*]/g, '_');
}
function validateUploadBuffer(buffer, mimeType, originalName = '', encrypted = false) {
  const safeName = sanitizeOriginalFileName(originalName);
  if (encrypted) return { mimeType: 'application/octet-stream', originalName: safeName || 'encrypted.gce', extension: 'gce' };
  const ext = extensionFor(mimeType, safeName).toLowerCase();
  if (BLOCKED_UPLOAD_EXTENSIONS.has(ext)) throw new Error('Bu dosya türü güvenlik nedeniyle engellendi.');
  const claimed = canonicalMime(mimeType);
  const detected = detectMagicMime(buffer, claimed);
  const effectiveMime = ALLOWED_UPLOAD_MIMES.has(detected) ? detected : '';
  if (!effectiveMime || effectiveMime === 'application/octet-stream') throw new Error('Bu dosya türü desteklenmiyor veya güvenli değil.');
  if (effectiveMime.startsWith('image/') && !['image/png','image/jpeg','image/gif','image/webp'].includes(effectiveMime)) throw new Error('Bu görsel formatı desteklenmiyor.');
  if (effectiveMime === 'text/plain' && !isProbablyText(buffer)) throw new Error('Metin dosyası güvenli görünmüyor.');
  return { mimeType: effectiveMime, originalName: safeName, extension: extensionFor(effectiveMime, safeName).toLowerCase() };
}
function cleanLimitedBase64(value, label, maxChars, required = true) {
  const out = String(value || '').trim();
  if (!out && !required) return '';
  if (!out) throw new Error(`${label} eksik.`);
  if (Buffer.byteLength(out, 'utf8') > maxChars) throw new Error(`${label} çok büyük.`);
  if (!/^[a-zA-Z0-9+/=_-]+$/.test(out)) throw new Error(`${label} geçersiz.`);
  return out;
}
function cleanE2eePayload(e2ee, options = {}) {
  if (!e2ee || typeof e2ee !== 'object') return null;
  const mode = String(e2ee.mode || 'message').slice(0, 32);
  const isAttachment = mode === 'attachment';
  if (isAttachment && !options.allowAttachment) throw new Error('Bu kanaldan şifreli ek gönderilemez.');
  const payload = {
    v: Number(e2ee.v || (isAttachment ? 2 : 1)),
    alg: String(e2ee.alg || 'AES-GCM').slice(0, 32),
    kdf: String(e2ee.kdf || 'PBKDF2-SHA256').slice(0, 32),
    iterations: Math.min(Math.max(Number(e2ee.iterations || 250000), 100000), 1000000),
    mode,
    salt: cleanLimitedBase64(e2ee.salt, 'Şifreli mesaj salt', 128),
    iv: cleanLimitedBase64(e2ee.iv, 'Şifreli mesaj IV', 128),
    ciphertext: cleanLimitedBase64(e2ee.ciphertext, 'Şifreli mesaj verisi', options.maxCiphertextChars || MAX_E2EE_TEXT_BYTES, true)
  };
  if (payload.alg !== 'AES-GCM' || payload.kdf !== 'PBKDF2-SHA256') throw new Error('Şifreleme biçimi desteklenmiyor.');
  if (isAttachment) {
    payload.fileIv = cleanLimitedBase64(e2ee.fileIv, 'Şifreli dosya IV', 128);
    payload.attachment = true;
  }
  if (approxStoredBytes(payload) > (options.maxStoredBytes || MAX_E2EE_METADATA_BYTES)) throw new Error('Şifreli mesaj meta verisi çok büyük.');
  return payload;
}
function hydrateUploadBlobsFromDir(state, uploadDir) {
  if (!state || !uploadDir || !fs.existsSync(uploadDir)) return state;
  state.uploadBlobs ||= {};
  state.uploads ||= {};
  for (const fileName of fs.readdirSync(uploadDir)) {
    const safeName = path.basename(fileName);
    if (!/^[a-zA-Z0-9_.-]+$/.test(safeName)) continue;
    const fullPath = path.join(uploadDir, safeName);
    if (!fs.statSync(fullPath).isFile() || state.uploadBlobs[safeName]?.base64) continue;
    const buffer = fs.readFileSync(fullPath);
    if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) continue;
    const mimeType = state.uploads[safeName]?.mimeType || mimeForFileName(safeName);
    state.uploadBlobs[safeName] = { mimeType, base64: buffer.toString('base64'), sizeBytes: buffer.length, createdAt: now() };
    state.uploads[safeName] ||= { storedName: safeName, mimeType, sizeBytes: buffer.length, originalName: safeName, createdAt: now() };
  }
  return state;
}
function persistUpload({ data, mimeType, fileName = '', prefix = 'file_', channelId = '', userId = '', encrypted = false }) {
  const decoded = decodeBase64Upload(data, mimeType);
  const validated = validateUploadBuffer(decoded.buffer, decoded.mimeType, fileName, encrypted);
  const storedName = `${id(prefix)}.${validated.extension}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), decoded.buffer);
  db.uploads[storedName] = { storedName, mimeType: validated.mimeType, sizeBytes: decoded.buffer.length, originalName: validated.originalName, channelId, userId, encrypted: Boolean(encrypted), createdAt: now() };
  // Upload'u DB içinde de tutuyoruz; Postgres kullanınca ses/fotoğraf deploy sonrası kaybolmaz.
  db.uploadBlobs ||= {};
  db.uploadBlobs[storedName] = { mimeType: validated.mimeType, base64: decoded.buffer.toString('base64'), sizeBytes: decoded.buffer.length, createdAt: now() };
  saveDbSoon();
  return { storedName, url: uploadUrl(storedName), mimeType: validated.mimeType, sizeBytes: decoded.buffer.length, originalName: validated.originalName };
}
function sendUpload(req, res) {
  const fileName = path.basename(String(req.params.fileName || ''));
  if (!/^[a-zA-Z0-9_.-]+$/.test(fileName)) return res.status(404).end();
  const filePath = path.join(UPLOAD_DIR, fileName);
  const meta = db.uploads?.[fileName] || {};
  if (meta.channelId && !canAccessChannel(req.user.id, meta.channelId) && !isAdminUser(req.user)) return res.status(403).json({ error: 'Bu dosyaya erişimin yok.' });
  const blob = db.uploadBlobs?.[fileName];
  if (!fs.existsSync(filePath) && blob?.base64) {
    try { fs.writeFileSync(filePath, Buffer.from(blob.base64, 'base64')); } catch {}
  }
  if (!fs.existsSync(filePath) && !blob?.base64) return res.status(404).json({ error: 'Dosya bulunamadı.' });
  const contentType = meta.mimeType || blob?.mimeType || mimeForFileName(fileName);
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (!(contentType.startsWith('image/') || contentType.startsWith('audio/') || contentType.startsWith('video/'))) {
    const safeOriginal = String(meta.originalName || fileName).replace(/[\r\n"]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeOriginal}"`);
  }
  res.setHeader('Accept-Ranges', 'bytes');

  if (!fs.existsSync(filePath) && blob?.base64) {
    const buffer = Buffer.from(blob.base64, 'base64');
    res.setHeader('Content-Length', buffer.length);
    return res.end(buffer);
  }

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const match = String(range).match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', end - start + 1);
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }
    }
  }
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
}
function exportUploads() {
  const uploads = {};
  let total = 0;
  const names = new Set([...Object.keys(db.uploadBlobs || {}), ...(fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : [])]);
  for (const fileName of names) {
    const safeName = path.basename(fileName);
    const fullPath = path.join(UPLOAD_DIR, safeName);
    let buffer = null;
    let mimeType = db.uploads?.[safeName]?.mimeType || db.uploadBlobs?.[safeName]?.mimeType || mimeForFileName(safeName);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) buffer = fs.readFileSync(fullPath);
    else if (db.uploadBlobs?.[safeName]?.base64) buffer = Buffer.from(db.uploadBlobs[safeName].base64, 'base64');
    if (!buffer || total + buffer.length > MAX_BACKUP_BYTES) continue;
    uploads[safeName] = `data:${mimeType};base64,${buffer.toString('base64')}`;
    total += buffer.length;
  }
  return uploads;
}
function importUploads(uploads = {}) {
  if (!uploads || typeof uploads !== 'object') return 0;
  let count = 0;
  for (const [fileName, data] of Object.entries(uploads)) {
    const safeName = path.basename(String(fileName || '')).replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (!safeName) continue;
    const decoded = decodeBase64Upload(String(data || ''), mimeForFileName(safeName));
    if (decoded.buffer.length > MAX_UPLOAD_BYTES) continue;
    const validated = validateUploadBuffer(decoded.buffer, decoded.mimeType, safeName, safeName.endsWith('.gce'));
    fs.writeFileSync(path.join(UPLOAD_DIR, safeName), decoded.buffer);
    db.uploads[safeName] = { storedName: safeName, mimeType: validated.mimeType, sizeBytes: decoded.buffer.length, originalName: validated.originalName, createdAt: now() };
    db.uploadBlobs ||= {};
    db.uploadBlobs[safeName] = { mimeType: validated.mimeType, base64: decoded.buffer.toString('base64'), sizeBytes: decoded.buffer.length, createdAt: now() };
    count += 1;
  }
  return count;
}

function sendNative(ws, type, payload = {}) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, ...payload }));
}
function broadcastNative(type, payload = {}, predicate = () => true) {
  for (const ws of nativeClients) if (ws.readyState === ws.OPEN && predicate(ws)) sendNative(ws, type, payload);
}
function emitToUsers(userIds = [], event, payload) {
  const allowed = new Set(userIds);
  for (const socket of io.sockets.sockets.values()) if (socket.user && allowed.has(socket.user.id)) socket.emit(event, payload);
  broadcastNative(event, payload, (ws) => ws.user && allowed.has(ws.user.id));
}
function broadcastServerUpdated(serverObj) {
  const server = ensureServerView(serverObj);
  emitToUsers(serverObj.memberIds || [], 'server:updated', { server });
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
function voiceMembers(channelId) {
  const members = new Map();
  for (const item of webVoiceClients.values()) if (item.channelId === channelId) members.set(item.user.id, publicUser(db.users[item.user.id] || item.user));
  for (const ws of nativeClients) if (ws.voiceChannelId === channelId && ws.user) members.set(ws.user.id, publicUser(ws.user));
  return [...members.values()].filter(Boolean);
}
function emitVoiceMembers(channelId) {
  if (!channelId) return;
  const payload = { channelId, members: voiceMembers(channelId) };
  io.to(`voice:${channelId}`).emit('voice:members', payload);
  broadcastNative('voice:members', payload, (client) => client.voiceChannelId === channelId);
}
function leaveWebVoice(socket) {
  const channelId = socket.voiceChannelId;
  if (!channelId) return;
  socket.leave(`voice:${channelId}`);
  webVoiceClients.delete(socket.id);
  socket.voiceChannelId = null;
  socket.to(`voice:${channelId}`).emit('voice:user_left', { channelId, socketId: socket.id, user: publicUser(socket.user) });
  broadcastNative('voice:user_left', { channelId, user: publicUser(socket.user) }, (client) => client.voiceChannelId === channelId);
  emitVoiceMembers(channelId);
}

function createSession(userId, req = null) {
  const sessionToken = randomToken('sess_');
  const sessionHash = hashToken(sessionToken);
  db.sessions[sessionHash] = { userId, createdAt: now(), lastSeenAt: now(), expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(), csrfToken: randomToken('csrf_'), ip: req ? clientIp(req) : '', ua: req ? String(req.headers['user-agent'] || '').slice(0, 180) : '' };
  saveDbSoon();
  return sessionToken;
}
function setSessionCookie(req, res, token) {
  const secure = Boolean(PUBLIC_URL.startsWith('https://') || req?.secure || String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0] === 'https');
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_TTL_MS });
}
function sessionPayload(token) {
  const session = getSessionByToken(token);
  return session ? { csrfToken: session.csrfToken, expiresAt: session.expiresAt } : {};
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 80) || 'unknown'; }
function recordSecurityEvent(type, details = {}) {
  db.securityEvents ||= [];
  db.securityEvents.push({ id: id('sec_'), type, details, createdAt: now() });
  if (db.securityEvents.length > SECURITY_LOG_LIMIT) db.securityEvents = db.securityEvents.slice(-SECURITY_LOG_LIMIT);
  saveDbSoon();
}
const rateBuckets = new Map();
function checkRateLimit(name, key, max, windowMs) {
  const nowMs = Date.now();
  const bucketKey = `${name}:${key}`;
  let bucket = rateBuckets.get(bucketKey);
  if (!bucket || bucket.resetAt < nowMs) bucket = { count: 0, resetAt: nowMs + windowMs };
  bucket.count += 1;
  rateBuckets.set(bucketKey, bucket);
  if (bucket.count > max) return { ok: false, retryAfter: Math.ceil((bucket.resetAt - nowMs) / 1000) };
  return { ok: true };
}
function rateLimit(name, max, windowMs, keyFn = (req) => clientIp(req)) {
  return (req, res, next) => {
    const checked = checkRateLimit(name, keyFn(req), max, windowMs);
    if (!checked.ok) {
      res.setHeader('Retry-After', String(checked.retryAfter));
      recordSecurityEvent('rate_limit', { name, ip: clientIp(req), path: req.path });
      return res.status(429).json({ error: 'Çok hızlı deniyorsun. Biraz bekle.' });
    }
    next();
  };
}
function socketRateLimit(socket, name, max = SOCKET_MESSAGE_LIMIT, windowMs = SOCKET_MESSAGE_WINDOW_MS) {
  const key = socket?.user?.id || socket?.id || 'unknown';
  const checked = checkRateLimit(name, key, max, windowMs);
  if (!checked.ok) {
    recordSecurityEvent('socket_rate_limit', { name, userId: socket?.user?.id || '', socketId: socket?.id || '', retryAfter: checked.retryAfter });
    return { ok: false, error: 'Çok hızlı mesaj gönderiyorsun. Biraz bekle.' };
  }
  return { ok: true };
}
function originAllowed(req) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  const referer = String(req.headers.referer || '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const ownOrigin = host ? `${proto}://${host}`.replace(/\/$/, '') : '';
  const allowed = new Set([ownOrigin, PUBLIC_URL, ...TRUSTED_ORIGINS].filter(Boolean).map((v) => String(v).replace(/\/$/, '')));
  if (origin) return allowed.has(origin);
  if (referer) { try { return allowed.has(new URL(referer).origin); } catch { return false; } }
  return true;
}
function csrfGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (!originAllowed(req)) { recordSecurityEvent('bad_origin', { ip: clientIp(req), path: req.path, origin: req.headers.origin || '', referer: req.headers.referer || '' }); return res.status(403).json({ error: 'Güvenlik kontrolü başarısız: origin reddedildi.' }); }
  if (/^Bearer\s+/i.test(String(req.headers.authorization || ''))) return next();
  const session = getSessionByToken(getTokenFromRequest(req));
  if (!session) return next();
  const supplied = String(req.headers[CSRF_HEADER] || req.headers['x-csrf-token'] || '');
  if (!supplied || supplied !== session.csrfToken) { recordSecurityEvent('csrf_block', { ip: clientIp(req), path: req.path, userId: session.userId }); return res.status(403).json({ error: 'Güvenlik anahtarı eksik veya hatalı. Sayfayı yenile.' }); }
  next();
}
function securityHeaders(req, res, next) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    REQUIRE_HTTPS ? "upgrade-insecure-requests" : ''
  ].filter(Boolean).join('; ');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
}

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: MAX_SOCKET_EVENT_BYTES,
  pingInterval: SOCKET_PING_INTERVAL_MS,
  pingTimeout: SOCKET_PING_TIMEOUT_MS,
  connectionStateRecovery: { maxDisconnectionDuration: SOCKET_RECOVERY_MAX_MS, skipMiddlewares: false },
  cors: { origin: false }
});
const wss = new WebSocketServer({ noServer: true });

app.use(securityHeaders);
app.use(express.json({ limit: `${Math.ceil(Math.max(MAX_UPLOAD_BYTES, MAX_BACKUP_BYTES) / 1024 / 1024) + 2}mb` }));
app.use(csrfGuard);
app.get('/uploads/:fileName', auth, sendUpload);
app.use(express.static(path.join(ROOT, 'public'), { etag: true, maxAge: '1h', setHeaders(res, filePath) { if (/\.html$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store'); } }));

function dataStatusPayload() {
  const uploadCount = Object.keys(db.uploads || {}).length || (fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).filter((name) => !name.startsWith('.')).length : 0);
  const persistentData = isPersistentDataEnabled();
  return {
    ok: true,
    app: APP_NAME,
    version: APP_VERSION,
    storageMode,
    dataDir: storageMode === 'postgres' ? 'postgres' : DATA_DIR,
    persistentData,
    persistentDataDirConfigured: persistentData,
    needsPersistentSetup: needsPersistentSetup(),
    uploadCount,
    userCount: Object.keys(db.users || {}).length,
    serverCount: Object.keys(db.servers || {}).length,
    messageCount: Object.values(db.messages || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0),
    dbFile: storageMode === 'postgres' ? DB_STATE_KEY : DB_FILE,
    dbStateKey: DB_STATE_KEY,
    warning: persistentData ? '' : 'Render Free dosya sistemi deploy/restart sonrası sıfırlanabilir; DATABASE_URL ile PostgreSQL bağla.'
  };
}
app.get('/api/health', (_req, res) => res.json({ ...dataStatusPayload(), time: now() }));
app.get('/api/public-status', (_req, res) => res.json({ ...dataStatusPayload(), hasUsers: Object.keys(db.users || {}).length > 0 }));
app.get('/api/storage-info', auth, (_req, res) => res.json(dataStatusPayload()));
app.get('/api/security/status', auth, (req, res) => res.json({
  ok: true,
  version: APP_VERSION,
  securityHeaders: true,
  csrf: true,
  rateLimit: true,
  socketRateLimit: true,
  socketSharesRestMessageRateLimit: true,
  uploadAuthorization: true,
  sessionStorage: 'sha256-token-hash',
  passwordKdf: isAdminUser(req.user) ? `PBKDF2-SHA256/${PBKDF2_ITERATIONS}` : 'redacted',
  e2ee: {
    available: true,
    optional: true,
    mode: isAdminUser(req.user) ? 'optional per-channel client-side passphrase; AES-GCM via Web Crypto; text ciphertext capped, attachments stored as encrypted uploads' : 'optional client-side encryption',
    maxTextCiphertextBytes: isAdminUser(req.user) ? MAX_E2EE_TEXT_BYTES : undefined,
    maxSocketEventBytes: isAdminUser(req.user) ? MAX_SOCKET_EVENT_BYTES : undefined,
    liveVoiceContentE2EE: false,
    metadataVisible: true
  },
  adminAutoLocalBackup: false,
  inviteCodes: isAdminUser(req.user) ? { activeBits: 128, format: 'hex', joinRateLimit: `${SERVER_JOIN_RATE_LIMIT}/${Math.round(SERVER_JOIN_RATE_WINDOW_MS / 1000)}s` } : 'redacted',
  aggregateMessageByteLimits: isAdminUser(req.user) ? { perChannel: MAX_CHANNEL_MESSAGE_BYTES, perUser: MAX_USER_MESSAGE_BYTES, perMessage: MAX_STORED_MESSAGE_BYTES } : 'redacted',
  redacted: !isAdminUser(req.user),
  recentSecurityEvents: isAdminUser(req.user) ? (db.securityEvents || []).slice(-25).reverse() : undefined
}));
app.get('/api/csrf', auth, (req, res) => res.json({ csrfToken: getSessionByToken(getTokenFromRequest(req))?.csrfToken || '' }));
app.post('/api/voice/keepalive', auth, (req, res) => {
  const channelId = String(req.body?.channelId || '');
  if (!canUseLiveVoice(req.user.id, channelId)) return res.status(403).json({ error: 'Ses kanalına erişimin yok.' });
  res.json({ ok: true, channelId, time: now() });
});
app.post('/api/security/logout-all', auth, (req, res) => {
  for (const [key, session] of Object.entries(db.sessions || {})) if (session.userId === req.user.id) delete db.sessions[key];
  saveDbSoon();
  res.clearCookie('sid');
  res.json({ ok: true });
});
app.post('/api/admin/security/invalidate-sessions', auth, requireAdmin, rateLimit('admin_invalidate_sessions', 3, 15 * 60 * 1000, (req) => req.user?.id || clientIp(req)), (req, res) => {
  const count = Object.keys(db.sessions || {}).length;
  db.sessions = {};
  recordSecurityEvent('admin_invalidated_sessions', { adminUserId: req.user.id, count });
  saveDbNow();
  res.clearCookie('sid');
  res.json({ ok: true, invalidated: count });
  setTimeout(() => { for (const s of io.sockets.sockets.values()) s.disconnect(true); }, 150);
});

function normalizeImportedDb(incoming) {
  const next = normalizeDb({ ...emptyDb(), ...(incoming || {}) });
  // Yedek dosyaları aktif oturum taşıyamaz. Böylece eski export veya ele geçirilmiş backup session reuse yapamaz.
  next.sessions = {};
  next.securityEvents = [];
  for (const user of Object.values(next.users || {})) {
    delete user.failedLoginCount;
    delete user.lastFailedLoginAt;
    delete user.lastLoginAt;
  }
  return next;
}
app.post('/api/bootstrap-import', rateLimit('bootstrap_import', 3, 15 * 60 * 1000), (req, res) => {
  if (Object.keys(db.users || {}).length > 0) return res.status(409).json({ error: 'Yedek yükleme sadece veritabanı boşken giriş ekranından yapılabilir. Hesabın varsa Ayarlar > Yedek yükle kullan.' });
  const incoming = req.body?.db;
  if (!incoming || typeof incoming !== 'object' || !incoming.users || !incoming.servers) return res.status(400).json({ error: 'Geçersiz yedek dosyası.' });
  db = normalizeImportedDb(incoming);
  const uploadCount = importUploads(req.body.uploads || {});
  saveDbNow();
  res.json({ ok: true, uploads: uploadCount, userCount: Object.keys(db.users || {}).length });
});

app.post('/api/register', rateLimit('register', 8, 10 * 60 * 1000), (req, res) => {
  const username = normalizeUsername(req.body.username);
  const displayName = String(req.body.displayName || username).trim().slice(0, 32);
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Kullanıcı adı 3-20 karakter olmalı; harf, rakam ve _ kullan.' });
  if (password.length < 8) return res.status(400).json({ error: 'Şifre en az 8 karakter olmalı.' });
  if (db.usernameIndex[username]) return res.status(409).json({ error: 'Bu kullanıcı adı alınmış.' });

  const userId = id('usr_');
  const { salt, hash, iterations } = hashPassword(password);
  const user = { id: userId, username, displayName, passwordSalt: salt, passwordHash: hash, passwordIterations: iterations, status: '', settings: { theme: 'dark', compactMode: false, reduceMotion: false, e2eeHints: true }, failedLoginCount: 0, createdAt: now() };
  db.users[userId] = user;
  db.usernameIndex[username] = userId;
  if (!db.adminUserId) db.adminUserId = userId;
  const token = createSession(userId, req);
  setSessionCookie(req, res, token);
  res.status(201).json({ user: meUser(user), token, ...sessionPayload(token) });
});
app.post('/api/login', rateLimit('login', 20, 10 * 60 * 1000), (req, res) => {
  const username = normalizeUsername(req.body.username);
  const user = db.users[db.usernameIndex[username]];
  const userLimit = checkRateLimit('login_user', `${clientIp(req)}:${username}`, 6, 10 * 60 * 1000);
  if (!userLimit.ok) return res.status(429).json({ error: 'Bu kullanıcı için çok fazla deneme yapıldı. Biraz bekle.' });
  if (!user || !verifyPassword(String(req.body.password || ''), user)) {
    if (user) { user.failedLoginCount = (user.failedLoginCount || 0) + 1; user.lastFailedLoginAt = now(); saveDbSoon(); }
    recordSecurityEvent('failed_login', { username, ip: clientIp(req) });
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
  }
  user.failedLoginCount = 0;
  user.lastLoginAt = now();
  if (Number(user.passwordIterations || 0) < PBKDF2_ITERATIONS) {
    const upgraded = hashPassword(String(req.body.password || ''));
    user.passwordSalt = upgraded.salt; user.passwordHash = upgraded.hash; user.passwordIterations = upgraded.iterations;
  }
  const token = createSession(user.id, req);
  setSessionCookie(req, res, token);
  res.json({ user: meUser(user), token, ...sessionPayload(token) });
});
app.post('/api/logout', auth, (req, res) => {
  const token = getTokenFromRequest(req);
  if (token) { delete db.sessions[hashToken(token)]; delete db.sessions[token]; }
  saveDbSoon();
  res.clearCookie('sid');
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => {
  const dataStatus = { storageMode, dataDir: storageMode === 'postgres' ? 'postgres' : DATA_DIR, persistentData: isPersistentDataEnabled(), persistentDataDir: isPersistentDataEnabled(), needsPersistentSetup: needsPersistentSetup(), dbStateKey: DB_STATE_KEY };
  res.json({ user: { ...meUser(req.user), isAppOwner: isAdminUser(req.user) }, isAppOwner: isAdminUser(req.user), friends: friendSummaryFor(req.user.id), servers: serversFor(req.user.id), onlineIds: [...onlineCounts.keys()], dataStatus, appInfo: { version: APP_VERSION, storageMode, dataStatus }, ...sessionPayload(getTokenFromRequest(req)) });
});
app.patch('/api/me', auth, (req, res) => {
  const displayName = String(req.body.displayName || req.user.displayName || req.user.username).trim().slice(0, 32);
  if (displayName.length < 2) return res.status(400).json({ error: 'Görünen ad en az 2 karakter olmalı.' });
  req.user.displayName = displayName;
  req.user.status = String(req.body.status || req.user.status || '').trim().slice(0, 80);
  const settings = req.body.settings && typeof req.body.settings === 'object' ? req.body.settings : {};
  req.user.settings = {
    ...(req.user.settings || {}),
    theme: ['dark', 'midnight', 'rainbow'].includes(settings.theme) ? settings.theme : (req.user.settings?.theme || 'dark'),
    compactMode: Boolean(settings.compactMode),
    reduceMotion: Boolean(settings.reduceMotion),
    e2eeHints: settings.e2eeHints !== false
  };
  saveDbSoon();
  res.json({ user: { ...meUser(req.user), isAppOwner: isAdminUser(req.user) } });
});

function publicBackupUser(user) {
  const out = publicUser(user) || {};
  out.createdAt = user?.createdAt || '';
  return out;
}
function makeAdminExport(light = false) {
  if (light) {
    return {
      version: db.version,
      adminUserId: db.adminUserId,
      users: Object.fromEntries(Object.entries(db.users || {}).map(([id, user]) => [id, publicBackupUser(user)])),
      usernameIndex: { ...(db.usernameIndex || {}) },
      servers: Object.fromEntries(Object.entries(db.servers || {}).map(([id, server]) => [id, { id, name: server.name, ownerId: server.ownerId, memberIds: server.memberIds || [], channelIds: server.channelIds || [], createdAt: server.createdAt || '' }])),
      channels: { ...(db.channels || {}) },
      messages: {},
      friendships: {},
      uploads: {},
      uploadBlobs: {},
      sessions: {},
      securityEvents: [],
      appSettings: { ...(db.appSettings || {}) }
    };
  }
  const copy = JSON.parse(JSON.stringify(db));
  copy.sessions = {};
  copy.securityEvents = [];
  copy.uploadBlobs = {};
  for (const user of Object.values(copy.users || {})) {
    delete user.failedLoginCount;
    delete user.lastFailedLoginAt;
  }
  return copy;
}
app.get('/api/admin/export', auth, requireAdmin, rateLimit('admin_export', 12, 60 * 1000, (req) => req.user?.id || clientIp(req)), (req, res) => {
  saveDbNow();
  const light = String(req.query.light || '') === '1';
  const outDb = makeAdminExport(light);
  res.json({ app: 'gaycord', version: APP_VERSION, exportedAt: now(), light, db: outDb, uploads: light ? {} : exportUploads() });
});
app.post('/api/admin/import', auth, requireAdmin, (req, res) => {
  const incoming = req.body?.db;
  if (!incoming || typeof incoming !== 'object' || !incoming.users || !incoming.servers) return res.status(400).json({ error: 'Geçersiz yedek dosyası.' });
  db = normalizeImportedDb(incoming);
  if (!db.adminUserId || !db.users[db.adminUserId]) db.adminUserId = req.user.id;
  const uploadCount = importUploads(req.body.uploads || {});
  saveDbNow();
  io.emit('data:imported', { ok: true });
  broadcastNative('data:imported', { ok: true });
  res.json({ ok: true, uploads: uploadCount });
});

app.get('/api/search-users', auth, (req, res) => {
  const q = normalizeUsername(req.query.q).slice(0, 32);
  if (q.length < 2) return res.json({ users: [] });
  const users = Object.values(db.users).filter((user) => user.id !== req.user.id)
    .filter((user) => user.username.includes(q) || (user.displayName || '').toLowerCase().includes(q))
    .slice(0, 10).map((user) => ({ ...publicUser(user), friendship: getFriendship(req.user.id, user.id)?.status || null }));
  res.json({ users });
});
app.post('/api/friends/request', auth, (req, res) => {
  const username = normalizeUsername(req.body.username);
  const other = db.users[db.usernameIndex[username]];
  if (!other || other.id === req.user.id) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  const key = friendshipKey(req.user.id, other.id);
  const existing = db.friendships[key];
  if (existing) return res.status(409).json({ error: existing.status === 'accepted' ? 'Zaten arkadaşsınız.' : 'Arkadaşlık isteği zaten var.' });
  const friendship = { id: id('fr_'), memberIds: [req.user.id, other.id], fromId: req.user.id, toId: other.id, status: 'pending', createdAt: now() };
  db.friendships[key] = friendship;
  saveDbSoon();
  res.status(201).json({ friendship });
});
app.post('/api/friends/respond', auth, (req, res) => {
  const friendship = Object.values(db.friendships).find((f) => f.id === String(req.body.requestId || ''));
  if (!friendship || friendship.toId !== req.user.id || friendship.status !== 'pending') return res.status(404).json({ error: 'İstek bulunamadı.' });
  if (req.body.accept) { friendship.status = 'accepted'; friendship.acceptedAt = now(); createOrGetDm(friendship.memberIds[0], friendship.memberIds[1]); }
  else delete db.friendships[friendshipKey(friendship.memberIds[0], friendship.memberIds[1])];
  saveDbSoon();
  res.json({ ok: true });
});
app.get('/api/dms/:friendId', auth, (req, res) => {
  const channel = createOrGetDm(req.user.id, req.params.friendId);
  if (!channel) return res.status(403).json({ error: 'DM için önce arkadaş olmalısınız.' });
  res.json({ channel });
});

app.post('/api/servers', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (name.length < 2) return res.status(400).json({ error: 'Sunucu adı en az 2 karakter olmalı.' });
  const serverId = id('srv_');
  const textId = id('chn_');
  const voiceId = id('chn_');
  const serverObj = { id: serverId, name, ownerId: req.user.id, inviteCode: inviteCode(), memberIds: [req.user.id], channelIds: [textId, voiceId], createdAt: now() };
  db.servers[serverId] = serverObj;
  db.channels[textId] = { id: textId, type: 'server', kind: 'text', serverId, name: 'genel', createdAt: now() };
  db.channels[voiceId] = { id: voiceId, type: 'server', kind: 'voice', serverId, name: 'ses-odasi', createdAt: now() };
  db.messages[textId] = [];
  db.messages[voiceId] = [];
  saveDbSoon();
  res.status(201).json({ server: ensureServerView(serverObj, req.user.id) });
});
app.post('/api/servers/join', auth, rateLimit('server_join', SERVER_JOIN_RATE_LIMIT, SERVER_JOIN_RATE_WINDOW_MS, (req) => `${req.user?.id || 'anon'}:${clientIp(req)}`), (req, res) => {
  const code = normalizeInviteCode(req.body.inviteCode);
  const serverObj = Object.values(db.servers).find((server) => server.inviteCode === code);
  if (!serverObj) return res.status(404).json({ error: 'Davet kodu bulunamadı.' });
  if (!serverObj.memberIds.includes(req.user.id)) serverObj.memberIds.push(req.user.id);
  saveDbSoon();
  broadcastServerUpdated(serverObj);
  res.json({ server: ensureServerView(serverObj, req.user.id) });
});
app.patch('/api/servers/:serverId', auth, (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
  if (serverObj.ownerId !== req.user.id) return res.status(403).json({ error: 'Sadece sunucu sahibi düzenleyebilir.' });
  if (typeof req.body.name === 'string') {
    const name = String(req.body.name || '').trim().slice(0, 40);
    if (name.length < 2) return res.status(400).json({ error: 'Sunucu adı en az 2 karakter olmalı.' });
    serverObj.name = name;
  }
  if (req.body.regenerateInvite) serverObj.inviteCode = inviteCode();
  serverObj.updatedAt = now();
  saveDbSoon();
  broadcastServerUpdated(serverObj);
  res.json({ server: ensureServerView(serverObj, req.user.id) });
});
app.delete('/api/servers/:serverId', auth, (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
  if (serverObj.ownerId !== req.user.id) return res.status(403).json({ error: 'Sadece sunucu sahibi silebilir.' });
  const channelIds = [...serverObj.channelIds];
  for (const channelId of channelIds) { delete db.messages[channelId]; delete db.channels[channelId]; }
  delete db.servers[serverObj.id];
  saveDbSoon();
  emitToUsers(serverObj.memberIds || [], 'server:deleted', { serverId: serverObj.id, channelIds });
  res.json({ ok: true });
});
app.post('/api/servers/:serverId/leave', auth, (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
  if (serverObj.ownerId === req.user.id) return res.status(400).json({ error: 'Sahibi olduğun sunucudan çıkamazsın; silebilirsin.' });
  serverObj.memberIds = serverObj.memberIds.filter((id) => id !== req.user.id);
  saveDbSoon();
  broadcastServerUpdated(serverObj);
  res.json({ ok: true });
});
app.post('/api/servers/:serverId/channels', auth, (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
  if (serverObj.ownerId !== req.user.id) return res.status(403).json({ error: 'Sadece sunucu sahibi kanal açabilir.' });
  const kind = req.body.kind === 'voice' ? 'voice' : 'text';
  const name = String(req.body.name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  if (name.length < 2) return res.status(400).json({ error: 'Kanal adı en az 2 karakter olmalı.' });
  const channelId = id('chn_');
  db.channels[channelId] = { id: channelId, type: 'server', kind, serverId: serverObj.id, name, createdAt: now() };
  db.messages[channelId] = [];
  serverObj.channelIds.push(channelId);
  saveDbSoon();
  const view = ensureServerView(serverObj, req.user.id);
  broadcastServerUpdated(serverObj);
  res.status(201).json({ server: view, channel: db.channels[channelId] });
});
app.delete('/api/servers/:serverId/channels/:channelId', auth, (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  const channel = db.channels[req.params.channelId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id) || !channel || channel.serverId !== serverObj.id) return res.status(404).json({ error: 'Kanal bulunamadı.' });
  if (serverObj.ownerId !== req.user.id) return res.status(403).json({ error: 'Sadece sunucu sahibi kanal silebilir.' });
  if (serverObj.channelIds.length <= 1) return res.status(400).json({ error: 'Son kanalı silemezsin.' });
  serverObj.channelIds = serverObj.channelIds.filter((id) => id !== channel.id);
  delete db.messages[channel.id];
  delete db.channels[channel.id];
  saveDbSoon();
  io.to(channel.id).emit('channel:deleted', { channelId: channel.id, serverId: serverObj.id });
  io.to(`voice:${channel.id}`).emit('channel:deleted', { channelId: channel.id, serverId: serverObj.id });
  broadcastNative('channel:deleted', { channelId: channel.id, serverId: serverObj.id }, (ws) => serverObj.memberIds?.includes(ws.user?.id));
  res.json({ ok: true, server: ensureServerView(serverObj, req.user.id), channelId: channel.id });
});

app.get('/api/channels/:channelId/messages', auth, (req, res) => {
  if (!canAccessChannel(req.user.id, req.params.channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
  res.json({ messages: (db.messages[req.params.channelId] || []).slice(-200).map(sanitizeMessage) });
});
app.post('/api/channels/:channelId/messages', auth, rateLimit('messages', MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW_MS, (req) => req.user?.id || clientIp(req)), (req, res) => {
  try {
    const channelId = req.params.channelId;
    if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
    const type = String(req.body.type || 'text').toLowerCase();
    let message;
    if (type === 'text') {
      if (req.body.encrypted) {
        const e2ee = cleanE2eePayload(req.body.e2ee, { maxCiphertextChars: MAX_E2EE_TEXT_BYTES, maxStoredBytes: MAX_E2EE_METADATA_BYTES });
        message = createMessage({ channelId, userId: req.user.id, type: 'text', text: '', encrypted: true, e2ee });
      } else {
        const text = String(req.body.text || '').trim().slice(0, MAX_TEXT_LENGTH);
        if (!text) return res.status(400).json({ error: 'Boş mesaj gönderilemez.' });
        message = createMessage({ channelId, userId: req.user.id, type: 'text', text });
      }
    } else if (type === 'voice') {
      const encrypted = Boolean(req.body.encrypted);
      const e2ee = encrypted ? cleanE2eePayload(req.body.e2ee, { allowAttachment: true, maxCiphertextChars: MAX_E2EE_TEXT_BYTES, maxStoredBytes: MAX_E2EE_METADATA_BYTES }) : null;
      if (encrypted) { const uploadRate = checkRateLimit('encrypted_uploads', req.user.id, 30, 60 * 1000); if (!uploadRate.ok) return res.status(429).json({ error: 'Çok hızlı dosya/ses gönderiyorsun. Biraz bekle.' }); }
      const upload = persistUpload({ data: req.body.audioData, mimeType: req.body.mimeType || 'audio/webm', fileName: req.body.fileName || 'voice.webm', prefix: 'voice_', channelId, userId: req.user.id, encrypted });
      if (!encrypted && !upload.mimeType.startsWith('audio/')) return res.status(400).json({ error: 'Ses formatı desteklenmiyor.' });
      message = createMessage({ channelId, userId: req.user.id, type: 'voice', audioUrl: upload.url, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, durationMs: Number(req.body.durationMs || 0) || null, encrypted, e2ee });
    } else if (type === 'file') {
      const encrypted = Boolean(req.body.encrypted);
      const e2ee = encrypted ? cleanE2eePayload(req.body.e2ee, { allowAttachment: true, maxCiphertextChars: MAX_E2EE_TEXT_BYTES, maxStoredBytes: MAX_E2EE_METADATA_BYTES }) : null;
      if (encrypted) { const uploadRate = checkRateLimit('encrypted_uploads', req.user.id, 30, 60 * 1000); if (!uploadRate.ok) return res.status(429).json({ error: 'Çok hızlı dosya/ses gönderiyorsun. Biraz bekle.' }); }
      const upload = persistUpload({ data: req.body.fileData, mimeType: req.body.mimeType || 'application/octet-stream', fileName: req.body.fileName || 'dosya', prefix: 'file_', channelId, userId: req.user.id, encrypted });
      message = createMessage({ channelId, userId: req.user.id, type: 'file', fileUrl: upload.url, fileName: encrypted ? 'encrypted.gce' : upload.originalName, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, text: encrypted ? '' : String(req.body.text || '').slice(0, 300), encrypted, e2ee });
    } else return res.status(400).json({ error: 'Bilinmeyen mesaj türü.' });
    broadcastMessage(channelId, message);
    res.status(201).json({ message });
  } catch (error) { res.status(400).json({ error: error.message || 'Mesaj gönderilemedi.' }); }
});

io.use((socket, next) => {
  if (socket.handshake.headers.origin && !originAllowed({ headers: socket.handshake.headers, protocol: String(socket.handshake.headers['x-forwarded-proto'] || 'https'), path: '/socket.io' })) return next(new Error('Origin reddedildi.'));
  const user = getUserByToken(parseCookies(socket.handshake.headers.cookie || '').sid);
  if (!user) return next(new Error('Giriş gerekli.'));
  socket.user = user;
  next();
});
io.on('connection', (socket) => {
  const userId = socket.user.id;
  onlineCounts.set(userId, (onlineCounts.get(userId) || 0) + 1);
  emitPresence();
  socket.emit('session', { user: publicUser(socket.user), onlineIds: [...onlineCounts.keys()] });

  socket.on('channel:join', ({ channelId } = {}, callback = () => {}) => {
    if (!canAccessChannel(userId, channelId)) return callback({ error: 'Bu kanala erişimin yok.' });
    socket.join(channelId);
    callback({ ok: true, messages: (db.messages[channelId] || []).slice(-200).map(sanitizeMessage) });
  });
  socket.on('message:text', ({ channelId, text } = {}, callback = () => {}) => {
    try {
      const limited = socketRateLimit(socket, 'messages');
      if (!limited.ok) return callback({ error: limited.error });
      if (!canAccessChannel(userId, channelId)) return callback({ error: 'Bu kanala erişimin yok.' });
      const clean = String(text || '').trim().slice(0, MAX_TEXT_LENGTH);
      if (!clean) return callback({ error: 'Boş mesaj gönderilemez.' });
      const message = createMessage({ channelId, userId, type: 'text', text: clean });
      broadcastMessage(channelId, message);
      callback({ ok: true, message });
    } catch (error) { callback({ error: error.message || 'Mesaj gönderilemedi.' }); }
  });
  socket.on('message:voice', ({ channelId, audioData, mimeType, durationMs, encrypted, e2ee } = {}, callback = () => {}) => {
    try {
      const limited = socketRateLimit(socket, 'messages');
      if (!limited.ok) return callback({ error: limited.error });
      if (!canAccessChannel(userId, channelId)) return callback({ error: 'Bu kanala erişimin yok.' });
      const secure = Boolean(encrypted);
      const secureMeta = secure ? cleanE2eePayload(e2ee, { allowAttachment: true, maxCiphertextChars: MAX_E2EE_TEXT_BYTES, maxStoredBytes: MAX_E2EE_METADATA_BYTES }) : null;
      const upload = persistUpload({ data: audioData, mimeType: mimeType || 'audio/webm', fileName: secure ? 'encrypted-voice.gce' : 'voice.webm', prefix: 'voice_', channelId, userId, encrypted: secure });
      if (!secure && !upload.mimeType.startsWith('audio/')) return callback({ error: 'Ses formatı desteklenmiyor.' });
      const message = createMessage({ channelId, userId, type: 'voice', audioUrl: upload.url, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, durationMs: Number(durationMs || 0) || null, encrypted: secure, e2ee: secureMeta });
      broadcastMessage(channelId, message);
      callback({ ok: true, message });
    } catch (error) { callback({ error: error.message || 'Sesli mesaj gönderilemedi.' }); }
  });
  socket.on('message:secure', ({ channelId, e2ee } = {}, callback = () => {}) => {
    try {
      const limited = socketRateLimit(socket, 'messages');
      if (!limited.ok) return callback({ error: limited.error });
      if (!canAccessChannel(userId, channelId)) return callback({ error: 'Bu kanala erişimin yok.' });
      const message = createMessage({ channelId, userId, type: 'text', text: '', encrypted: true, e2ee: cleanE2eePayload(e2ee, { maxCiphertextChars: MAX_E2EE_TEXT_BYTES, maxStoredBytes: MAX_E2EE_METADATA_BYTES }) });
      broadcastMessage(channelId, message);
      callback({ ok: true, message });
    } catch (error) { callback({ error: error.message || 'Şifreli mesaj gönderilemedi.' }); }
  });
  socket.on('typing', ({ channelId, isTyping } = {}) => {
    if (!canAccessChannel(userId, channelId)) return;
    socket.to(channelId).emit('typing', { channelId, user: publicUser(socket.user), isTyping: Boolean(isTyping) });
  });

  socket.on('voice:join', ({ channelId } = {}, callback = () => {}) => {
    if (!canUseLiveVoice(userId, channelId)) return callback({ error: 'Ses kanalına erişimin yok.' });
    leaveWebVoice(socket);
    socket.voiceChannelId = channelId;
    socket.voiceLastSeenAt = now();
    webVoiceClients.set(socket.id, { channelId, user: publicUser(socket.user) });
    socket.join(`voice:${channelId}`);
    const peers = [...webVoiceClients.entries()].filter(([socketId, item]) => socketId !== socket.id && item.channelId === channelId).map(([socketId, item]) => ({ socketId, user: item.user }));
    callback({ ok: true, selfId: socket.id, peers, members: voiceMembers(channelId) });
    socket.to(`voice:${channelId}`).emit('voice:user_joined', { channelId, peer: { socketId: socket.id, user: publicUser(socket.user) } });
    broadcastNative('voice:user_joined', { channelId, user: publicUser(socket.user) }, (client) => client.voiceChannelId === channelId);
    emitVoiceMembers(channelId);
  });
  socket.on('voice:ping', ({ channelId } = {}, callback = () => {}) => {
    const targetChannelId = String(channelId || socket.voiceChannelId || '');
    if (!targetChannelId || !canUseLiveVoice(userId, targetChannelId)) return callback({ error: 'Ses kanalına erişimin yok.' });
    socket.voiceLastSeenAt = now();
    callback({ ok: true, channelId: targetChannelId, time: socket.voiceLastSeenAt });
  });
  socket.on('voice:leave', (_data = {}, callback = () => {}) => { leaveWebVoice(socket); callback({ ok: true }); });
  socket.on('voice:frame', ({ channelId, pcmBase64 } = {}) => {
    const targetChannelId = String(channelId || socket.voiceChannelId || '');
    const frame = String(pcmBase64 || '');
    if (!targetChannelId || socket.voiceChannelId !== targetChannelId) return;
    if (!canAccessChannel(userId, targetChannelId) || !channelIsVoice(targetChannelId)) return;
    if (!frame || frame.length > 120000) return;
    socket.to(`voice:${targetChannelId}`).emit('voice:frame', { channelId: targetChannelId, from: publicUser(socket.user), pcmBase64: frame });
    broadcastNative('voice:frame', { channelId: targetChannelId, from: publicUser(socket.user), pcmBase64: frame }, (client) => client.voiceChannelId === targetChannelId);
  });
  socket.on('voice:signal', ({ to, signal } = {}) => {
    const target = String(to || '');
    if (!target || !socket.voiceChannelId) return;
    const peer = webVoiceClients.get(target);
    if (!peer || peer.channelId !== socket.voiceChannelId) return;
    io.to(target).emit('voice:signal', { from: socket.id, user: publicUser(socket.user), signal });
  });


  socket.on('disconnect', () => {
    leaveWebVoice(socket);
    const nextCount = (onlineCounts.get(userId) || 1) - 1;
    if (nextCount <= 0) onlineCounts.delete(userId); else onlineCounts.set(userId, nextCount);
    emitPresence();
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/socket.io/')) return;
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
    try { data = JSON.parse(raw.toString('utf8')); } catch { return sendNative(ws, 'error', { error: 'Geçersiz veri.' }); }
    if (data.type === 'join_channel') {
      const channelId = String(data.channelId || '');
      if (!canAccessChannel(userId, channelId)) return sendNative(ws, 'error', { error: 'Bu kanala erişimin yok.' });
      ws.joinedChannels.add(channelId);
      return sendNative(ws, 'joined_channel', { channelId, messages: (db.messages[channelId] || []).slice(-200).map(sanitizeMessage) });
    }
    if (data.type === 'leave_channel') { ws.joinedChannels.delete(String(data.channelId || '')); return; }
    if (data.type === 'voice_join') {
      const channelId = String(data.channelId || '');
      if (!canUseLiveVoice(userId, channelId)) return sendNative(ws, 'error', { error: 'Ses kanalına erişimin yok.' });
      const old = ws.voiceChannelId;
      ws.voiceChannelId = channelId;
      if (old && old !== channelId) emitVoiceMembers(old);
      broadcastNative('voice:user_joined', { channelId, user: publicUser(ws.user) }, (client) => client !== ws && client.voiceChannelId === channelId);
      sendNative(ws, 'voice:joined', { channelId, members: voiceMembers(channelId) });
      emitVoiceMembers(channelId);
      return;
    }
    if (data.type === 'voice_leave') {
      const old = ws.voiceChannelId;
      ws.voiceChannelId = null;
      if (old) {
        broadcastNative('voice:user_left', { channelId: old, user: publicUser(ws.user) }, (client) => client !== ws && client.voiceChannelId === old);
        emitVoiceMembers(old);
      }
      return;
    }
    if (data.type === 'voice_frame') {
      const channelId = String(data.channelId || ws.voiceChannelId || '');
      const pcmBase64 = String(data.pcmBase64 || '');
      if (!channelId || ws.voiceChannelId !== channelId || !canAccessChannel(userId, channelId) || pcmBase64.length > 90000) return;
      broadcastNative('voice:frame', { channelId, from: publicUser(ws.user), pcmBase64 }, (client) => client !== ws && client.voiceChannelId === channelId);
    }
  });
  ws.on('close', () => {
    const old = ws.voiceChannelId;
    nativeClients.delete(ws);
    if (old) {
      broadcastNative('voice:user_left', { channelId: old, user: publicUser(ws.user) }, (client) => client !== ws && client.voiceChannelId === old);
      emitVoiceMembers(old);
    }
    const nextCount = (onlineCounts.get(userId) || 1) - 1;
    if (nextCount <= 0) onlineCounts.delete(userId); else onlineCounts.set(userId, nextCount);
    emitPresence();
  });
});

async function start() {
  db = await loadDb();
  saveDbSoon();
  console.log(`Gaycord V7 veri modu: ${storageMode}${storageMode === 'file' ? ` | data=${DATA_DIR}` : ''}${needsPersistentSetup() ? ' | UYARI: Render dosya sistemi geçici; DATABASE_URL veya disk ekle.' : ''}`);
  server.listen(PORT, () => console.log(`Gaycord V7 çalışıyor: http://localhost:${PORT}`));
}

start().catch((error) => {
  console.error('Gaycord başlatılamadı:', error);
  process.exit(1);
});
