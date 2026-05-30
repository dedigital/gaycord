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
const SERVER_AUDIT_LIMIT = Number(process.env.SERVER_AUDIT_LIMIT || 400); // V7.6: per-server audit log cap
const MAX_ALLOWED_CHANNEL_USERS = Number(process.env.MAX_ALLOWED_CHANNEL_USERS || 200); // V7.6: private channel allow-list cap
const MAX_CHANNELS_PER_SERVER = Number(process.env.MAX_CHANNELS_PER_SERVER || 100); // V7.6: bound channels (broadcast fan-out is O(members*channels))
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
    user.avatarUrl ||= '';
    user.bannerUrl ||= '';
    user.bio = String(user.bio || '');
    user.bookmarks = Array.isArray(user.bookmarks) ? user.bookmarks : [];
    user.reads = (user.reads && typeof user.reads === 'object' && !Array.isArray(user.reads)) ? user.reads : {};
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
    // V7.6 roles: backward-compatible defaults. Only non-owner Admin/Mod assignments are stored;
    // everyone else (and any stale entry) is implicitly a Member. Never destructive.
    server.roles = (server.roles && typeof server.roles === 'object' && !Array.isArray(server.roles)) ? server.roles : {};
    for (const uid of Object.keys(server.roles)) {
      if (uid === server.ownerId || !server.memberIds.includes(uid) || !['admin', 'mod'].includes(server.roles[uid])) delete server.roles[uid];
    }
    server.auditLog = Array.isArray(server.auditLog) ? server.auditLog.slice(-SERVER_AUDIT_LIMIT) : [];
    // V7.6 moderation: timeouts (write-restriction) + bans. Prune expired/invalid/non-member entries on load.
    server.timeouts = (server.timeouts && typeof server.timeouts === 'object' && !Array.isArray(server.timeouts)) ? server.timeouts : {};
    for (const uid of Object.keys(server.timeouts)) {
      const t = server.timeouts[uid];
      if (!t || !t.until || uid === server.ownerId || !server.memberIds.includes(uid) || Date.parse(t.until) <= Date.now()) delete server.timeouts[uid];
    }
    server.bans = (server.bans && typeof server.bans === 'object' && !Array.isArray(server.bans)) ? server.bans : {};
  }

  for (const [channelId, channel] of Object.entries(db.channels)) {
    channel.id ||= channelId;
    channel.kind ||= 'text';
    channel.type ||= channel.serverId ? 'server' : 'dm';
    channel.pinnedMessageIds = Array.isArray(channel.pinnedMessageIds) ? channel.pinnedMessageIds : [];
    // V7.6 private channels: default to public. allowedRoles ⊆ {admin,mod,member}; allowedUserIds capped.
    channel.private = Boolean(channel.private);
    channel.allowedRoles = Array.isArray(channel.allowedRoles) ? channel.allowedRoles.filter((r) => ['admin', 'mod', 'member'].includes(r)) : [];
    channel.allowedUserIds = Array.isArray(channel.allowedUserIds) ? channel.allowedUserIds.filter((x) => typeof x === 'string').slice(0, MAX_ALLOWED_CHANNEL_USERS) : [];
    channel.topic = String(channel.topic || '').slice(0, 200);
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
    avatarUrl: user.avatarUrl || '',
    online: onlineCounts.has(user.id),
    createdAt: user.createdAt
  };
}

function meUser(user) {
  return { ...publicUser(user), bio: String(user?.bio || ''), bannerUrl: user?.bannerUrl || '', settings: user?.settings || { theme: 'dark', compactMode: false, reduceMotion: false, e2eeHints: true } };
}

function isAdminUser(user) {
  return Boolean(user && db.adminUserId && user.id === db.adminUserId);
}

// App Owner / Super Admin gate. The App Owner is db.adminUserId (first registered admin); server
// owners/admins are NOT app owners and must never pass this gate (global backup/import/invalidate).
function requireAdmin(req, res, next) {
  if (isAdminUser(req.user)) return next();
  // Always deny non-owners with 403 (boundary is never weakened). The route-level admin rate limits
  // run AFTER this guard, so throttle the denial LOGGING here: rate-limit recordSecurityEvent so a
  // non-owner cannot spam admin endpoints into unbounded securityEvents + DB writes. checkRateLimit
  // is in-memory only, so denied requests never trigger a DB write once the log cap is reached.
  const ip = clientIp(req);
  const logKey = `${req.user?.id || 'anon'}:${ip}:${req.path}`;
  if (checkRateLimit('admin_denied_log', logKey, 5, 60 * 1000).ok) {
    recordSecurityEvent('admin_denied', { userId: req.user?.id || '', path: req.path, ip });
  }
  return res.status(403).json({ error: 'Bu işlem yalnızca uygulama sahibine (Super Admin) açıktır.' });
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
// ---- V7.6 server roles & permissions (single source of truth) ----
// Hierarchy: Owner > Admin > Mod > Member. server.roles only stores Admin/Mod; owner is derived from
// server.ownerId; everyone else who is a member is a Member. App Owner (db.adminUserId) is an app-wide
// gate for global backups ONLY (requireAdmin) and is deliberately NOT mixed into server role powers.
const ROLE_RANK = { owner: 3, admin: 2, mod: 1, member: 0 };
function getServerById(serverId) { return db.servers[serverId] || null; }
function getServerRole(server, userId) {
  if (!server || !userId || !server.memberIds?.includes(userId)) return null; // null = not a member
  if (server.ownerId === userId) return 'owner';
  const role = server.roles?.[userId];
  return (role === 'admin' || role === 'mod') ? role : 'member';
}
function roleRank(role) { return Number.isFinite(ROLE_RANK[role]) ? ROLE_RANK[role] : -1; }
function hasServerRole(server, userId, minRole) {
  const role = getServerRole(server, userId);
  return role !== null && roleRank(role) >= roleRank(minRole);
}
function canManageServer(userId, serverId) { return hasServerRole(getServerById(serverId), userId, 'admin'); }
function canManageMembers(userId, serverId) { return hasServerRole(getServerById(serverId), userId, 'admin'); }
function canManageChannels(userId, serverId) { return hasServerRole(getServerById(serverId), userId, 'admin'); }
function canModerateServer(userId, serverId) { return hasServerRole(getServerById(serverId), userId, 'mod'); }
function serverActiveTimeout(server, userId) {
  const t = server?.timeouts?.[userId];
  if (!t || !t.until || Date.parse(t.until) <= Date.now()) return null;
  return t;
}
function isMemberTimedOut(server, userId) {
  if (!server || server.ownerId === userId) return false; // owner is never write-restricted
  return Boolean(serverActiveTimeout(server, userId));
}
function canManageMessage(userId, message) {
  if (!userId || !message) return false;
  if (message.userId === userId) return true; // own message
  const channel = db.channels[message.channelId];
  if (!channel || !channel.serverId) return false; // DM: only own message is manageable
  return canModerateServer(userId, channel.serverId); // owner/admin/mod may moderate others' messages
}
function canAccessChannel(userId, channelId) {
  const channel = db.channels[channelId];
  if (!channel) return false;
  if (channel.type === 'dm') return Boolean(channel.memberIds?.includes(userId));
  const server = db.servers[channel.serverId];
  if (!server) return false;
  const role = getServerRole(server, userId);
  if (!role) return false;                                    // not a server member
  if (!channel.private) return true;                          // public server channel: any member
  if (role === 'owner' || role === 'admin') return true;      // managers always retain access (owner can never be locked out)
  if (channel.allowedUserIds?.includes(userId)) return true;  // explicitly allowed user
  if ((channel.allowedRoles || []).includes(role)) return true; // role granted access
  return false;
}
// Channel metadata (existence/name) visibility mirrors message access: unauthorized users must not
// even learn a private channel exists.
function canSeeChannelMetadata(userId, channelId) { return canAccessChannel(userId, channelId); }
function channelIsVoice(channelId) { const channel = db.channels[channelId]; return Boolean(channel && (channel.kind === 'voice' || channel.type === 'dm')); }
function canUseLiveVoice(userId, channelId) {
  const channel = db.channels[channelId];
  if (!channel || !canAccessChannel(userId, channelId)) return false;
  return channel.kind === 'voice' || channel.type === 'dm';
}

// Safe, per-channel view. Only fields the client needs; private allow-lists are sent only with the
// channel itself (which is already filtered per viewer in ensureServerView), never server-wide.
function channelView(channel, includeAllowLists = false) {
  const view = {
    id: channel.id,
    type: channel.type,
    kind: channel.kind,
    serverId: channel.serverId || '',
    name: channel.name || '',
    topic: channel.topic || '',
    private: Boolean(channel.private),
    pinnedMessageIds: Array.isArray(channel.pinnedMessageIds) ? channel.pinnedMessageIds : [],
    createdAt: channel.createdAt
  };
  // Curated allow-lists are management metadata: expose them ONLY to channel managers (admin+), never
  // to ordinary members who merely have access (they'd otherwise enumerate who else was granted in).
  if (includeAllowLists) {
    view.allowedRoles = Array.isArray(channel.allowedRoles) ? channel.allowedRoles : [];
    view.allowedUserIds = Array.isArray(channel.allowedUserIds) ? channel.allowedUserIds : [];
  }
  return view;
}
// V7.6: viewer-specific. Channels are filtered to those the viewer may see (private channels are
// hidden entirely from unauthorized members) so a single server payload can never leak private
// channel metadata. broadcastServerUpdated emits one of these PER member.
function ensureServerView(server, viewerId = '') {
  const viewerRole = getServerRole(server, viewerId);
  const viewerIsManager = viewerRole !== null && roleRank(viewerRole) >= roleRank('mod');
  const members = (server.memberIds || []).map((memberId) => db.users[memberId]).filter(Boolean).map((user) => {
    const role = user.id === server.ownerId ? 'owner' : (['admin', 'mod'].includes(server.roles?.[user.id]) ? server.roles[user.id] : 'member');
    const out = {
      ...publicUser(user),
      owner: user.id === server.ownerId,
      isOwner: user.id === server.ownerId,
      role
    };
    // Moderation state (timeout) is only exposed to managers (mod+); regular members don't need it.
    if (viewerIsManager) {
      const t = serverActiveTimeout(server, user.id);
      out.timedOut = Boolean(t);
      if (t) out.timeoutUntil = t.until;
    }
    return out;
  }).sort((a, b) => Number(b.online) - Number(a.online) || Number(b.owner) - Number(a.owner) || a.displayName.localeCompare(b.displayName, 'tr'));
  const viewerCanManageChannels = Boolean(viewerId && canManageChannels(viewerId, server.id));
  const channels = (server.channelIds || [])
    .map((channelId) => db.channels[channelId])
    .filter(Boolean)
    .filter((channel) => !viewerId || canSeeChannelMetadata(viewerId, channel.id))
    .map((channel) => channelView(channel, viewerCanManageChannels));
  return {
    id: server.id,
    name: server.name,
    ownerId: server.ownerId,
    inviteCode: server.inviteCode,
    memberIds: server.memberIds || [],
    memberCount: (server.memberIds || []).length,
    members,
    isOwner: Boolean(viewerId && server.ownerId === viewerId),
    myRole: viewerRole || 'member',
    canManage: Boolean(viewerId && canManageServer(viewerId, server.id)),
    canModerate: Boolean(viewerId && canModerateServer(viewerId, server.id)),
    channelCount: channels.length,
    channels,
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
function findMessageById(channelId, messageId) {
  return (db.messages[channelId] || []).find((m) => m.id === messageId) || null;
}
function reactionsView(reactions) {
  if (!reactions || typeof reactions !== 'object') return [];
  return Object.entries(reactions)
    .filter(([, ids]) => Array.isArray(ids) && ids.length)
    .map(([emoji, ids]) => ({ emoji, count: ids.length, userIds: ids.slice(0, 200) }));
}
function replyPreviewFor(message) {
  if (!message.replyTo) return null;
  const target = findMessageById(message.channelId, message.replyTo);
  if (!target) return { id: message.replyTo, user: null, deleted: true, text: '', encrypted: false };
  const u = publicUser(db.users[target.userId]);
  const text = target.encrypted ? '' : String(
    target.type === 'voice' ? '🎙️ sesli mesaj' : target.type === 'file' ? `📎 ${target.fileName || 'dosya'}` : (target.text || '')
  ).slice(0, 120);
  return { id: target.id, user: u ? { id: u.id, displayName: u.displayName, username: u.username } : null, encrypted: Boolean(target.encrypted), type: target.type, text };
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
    replyTo: message.replyTo || null,
    replyPreview: replyPreviewFor(message),
    reactions: reactionsView(message.reactions),
    editedAt: message.editedAt || null,
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
function createMessage({ channelId, userId, type, text = '', audioUrl = '', fileUrl = '', fileName = '', mimeType = '', sizeBytes = null, durationMs = null, encrypted = false, e2ee = null, replyTo = null }) {
  const message = { id: id('msg_'), channelId, userId, type, text, audioUrl, fileUrl, fileName, mimeType, sizeBytes, durationMs, encrypted: Boolean(encrypted), e2ee: e2ee || null, replyTo: replyTo || null, reactions: {}, createdAt: now() };
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
const PROFILE_MEDIA_MAX_BYTES = Number(process.env.PROFILE_MEDIA_MAX_BYTES || 4 * 1024 * 1024);
function storedNameFromUrl(url) {
  const match = String(url || '').match(/\/uploads\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
// Best-effort removal of a previously stored upload (used when an avatar/banner is replaced) so
// orphaned blobs do not accumulate in db.uploads / db.uploadBlobs / on disk forever.
function deleteStoredUpload(url, ownerUserId = '') {
  const name = storedNameFromUrl(url);
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) return;
  if (ownerUserId && db.uploads?.[name]?.userId && db.uploads[name].userId !== ownerUserId) return;
  delete db.uploads[name];
  if (db.uploadBlobs) delete db.uploadBlobs[name];
  try { const filePath = path.join(UPLOAD_DIR, name); if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
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
// V7.6 leak prevention: NEVER send one all-channels server view to everyone. Each member receives a
// view containing only the channels they may see, so private channel metadata cannot leak via
// server:updated. (Costs one emit per member — fine for realistic server sizes.)
function broadcastServerUpdated(serverObj) {
  for (const memberId of serverObj.memberIds || []) {
    emitToUsers([memberId], 'server:updated', { server: ensureServerView(serverObj, memberId) });
  }
}
// V7.4 security: never trust Socket.IO room membership for delivery. connectionStateRecovery can
// restore old channel rooms after a reconnect, so we emit per connected socket and re-check
// canAccessChannel at send time. Nothing is broadcast to the room itself, so disconnected
// recoverable sessions also get nothing buffered for replay.
function emitToChannelSockets(channelId, event, payload) {
  const room = io.sockets.adapter.rooms.get(channelId);
  if (!room) return;
  for (const socketId of [...room]) {
    const target = io.sockets.sockets.get(socketId);
    if (target?.user && canAccessChannel(target.user.id, channelId)) target.emit(event, payload);
  }
}
function broadcastMessage(channelId, message) {
  emitToChannelSockets(channelId, 'message:new', message);
  broadcastNative('message:new', { message }, (ws) => ws.user && ws.joinedChannels?.has(channelId) && canAccessChannel(ws.user.id, channelId));
}
function broadcastMessageUpdated(channelId, message) {
  emitToChannelSockets(channelId, 'message:updated', message);
  broadcastNative('message:updated', { message }, (ws) => ws.user && ws.joinedChannels?.has(channelId) && canAccessChannel(ws.user.id, channelId));
}
function broadcastMessageDeleted(channelId, messageId) {
  emitToChannelSockets(channelId, 'message:deleted', { channelId, messageId });
  broadcastNative('message:deleted', { channelId, messageId }, (ws) => ws.user && ws.joinedChannels?.has(channelId) && canAccessChannel(ws.user.id, channelId));
}

// ---- V7.4 social content helpers (small, isolated) ----
const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🔥', '👀', '✅', '🙏'];
function sanitizeReplyTo(channelId, replyTo) {
  const ref = String(replyTo || '');
  if (!ref) return null;
  return findMessageById(channelId, ref) ? ref : null;
}
function canDeleteMessage(user, channelId, message) {
  if (!user || !message) return false;
  return canManageMessage(user.id, { ...message, channelId }); // own message OR owner/admin/mod moderation
}
function canManagePins(userId, channelId) {
  const channel = db.channels[channelId];
  if (!channel) return false;
  if (channel.type === 'dm') return Boolean(channel.memberIds?.includes(userId));
  if (!canAccessChannel(userId, channelId)) return false; // must be able to see the (possibly private) channel
  return canModerateServer(userId, channel.serverId); // owner/admin/mod may manage pins
}
function channelDisplayName(channelId) {
  const channel = db.channels[channelId];
  if (!channel) return '';
  if (channel.type === 'dm') return 'DM';
  const server = db.servers[channel.serverId];
  return `${server?.name || 'Sunucu'} #${channel.name || ''}`.trim();
}
function accessibleChannelIdsFor(userId) {
  const ids = new Set();
  // V7.6: respect private channels so notification/unread counts never leak inaccessible channels.
  for (const server of Object.values(db.servers)) if (server.memberIds?.includes(userId)) for (const cid of server.channelIds || []) if (canAccessChannel(userId, cid)) ids.add(cid);
  for (const [cid, channel] of Object.entries(db.channels)) if (channel.type === 'dm' && channel.memberIds?.includes(userId)) ids.add(cid);
  return [...ids];
}
// Deliver live mention/DM notifications. Only to authorized recipients; never leaks E2EE plaintext.
function deliverMentions(channelId, message) {
  if (!message || message.encrypted || message.type !== 'text' || !message.text) return;
  const matches = String(message.text).match(/@([a-zA-Z0-9_]{2,32})/g);
  if (!matches) return;
  const fromId = message.user?.id;
  const notified = new Set();
  for (const raw of matches) {
    const uname = normalizeUsername(raw.slice(1));
    const targetId = db.usernameIndex[uname];
    if (!targetId || targetId === fromId || notified.has(targetId)) continue;
    if (!canAccessChannel(targetId, channelId)) continue; // do not notify users who cannot see the channel
    notified.add(targetId);
    emitToUsers([targetId], 'notify', { kind: 'mention', channelId, messageId: message.id, from: message.user, snippet: String(message.text).slice(0, 140), createdAt: message.createdAt });
  }
}
function notifyNewMessage(channelId, message) {
  const channel = db.channels[channelId];
  if (channel?.type === 'dm') {
    const otherId = (channel.memberIds || []).find((mid) => mid !== message.user?.id);
    if (otherId && canAccessChannel(otherId, channelId)) {
      const snippet = message.encrypted ? '🔒 şifreli mesaj' : String(message.type === 'voice' ? '🎙️ sesli mesaj' : message.type === 'file' ? `📎 ${message.fileName || 'dosya'}` : (message.text || '')).slice(0, 140);
      emitToUsers([otherId], 'notify', { kind: 'dm', channelId, messageId: message.id, from: message.user, snippet, createdAt: message.createdAt });
    }
  }
  deliverMentions(channelId, message);
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
  broadcastNative('voice:members', payload, (client) => client.voiceChannelId === channelId && canAccessChannel(client.user?.id, channelId));
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

// V7.4 security: drop any restored room the socket can no longer access. connectionStateRecovery
// re-joins a recovered socket to its previous channel/voice rooms; if the user lost access while
// disconnected, those rooms are stale and must not deliver broadcasts. Voice rooms are cleaned up
// safely (leave + notify peers) without weakening V7.2 voice stability.
function revalidateSocketRooms(socket) {
  if (!socket || !socket.user) return;
  const userId = socket.user.id;
  for (const room of [...socket.rooms]) {
    if (room === socket.id) continue;
    if (room.startsWith('voice:')) {
      // Voice membership (webVoiceClients / socket.voiceChannelId) is NOT restored across
      // connectionStateRecovery, so any restored voice room is stale. Always drop it: if the user is
      // still in a call the client re-issues voice:join (the single source of truth). If access was
      // lost, also notify peers so the member list stays correct.
      const channelId = room.slice('voice:'.length);
      const lostAccess = !canUseLiveVoice(userId, channelId);
      socket.leave(room);
      if (webVoiceClients.get(socket.id)?.channelId === channelId) webVoiceClients.delete(socket.id);
      if (socket.voiceChannelId === channelId) socket.voiceChannelId = null;
      if (lostAccess) {
        socket.to(room).emit('voice:user_left', { channelId, socketId: socket.id, user: publicUser(socket.user) });
        broadcastNative('voice:user_left', { channelId, user: publicUser(socket.user) }, (client) => client.voiceChannelId === channelId);
      }
      emitVoiceMembers(channelId);
    } else if (db.channels[room] && !canAccessChannel(userId, room)) {
      socket.leave(room);
    }
  }
}
function revalidateUserRooms(userId) {
  if (!userId) return;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.user && socket.user.id === userId) revalidateSocketRooms(socket);
  }
  revalidateNativeUser(userId);
}
// V7.6: after a privacy/role change affecting a whole server, drop now-unauthorized live rooms for
// every affected user (current members + any explicitly named, e.g. a just-kicked user) on BOTH
// Socket.IO and native WS.
function revalidateServerRooms(serverObj, extraUserIds = []) {
  const affected = new Set([...(serverObj?.memberIds || []), ...extraUserIds]);
  for (const socket of io.sockets.sockets.values()) {
    if (socket.user && affected.has(socket.user.id)) revalidateSocketRooms(socket);
  }
  for (const userId of affected) revalidateNativeUser(userId);
}
// V7.6: native-WS clients are not Socket.IO rooms; their access keys off ws.joinedChannels (text) and
// ws.voiceChannelId (voice). Drop any entry the user can no longer access so role/privacy changes
// evict native clients symmetrically with Socket.IO — no ghost voice participants, no stale rooms,
// and no voice:members/voice:user_joined roster leak to a revoked native client.
function revalidateNativeUser(userId) {
  if (!userId) return;
  for (const ws of nativeClients) {
    if (!ws.user || ws.user.id !== userId) continue;
    for (const cid of [...(ws.joinedChannels || [])]) if (!canAccessChannel(userId, cid)) ws.joinedChannels.delete(cid);
    if (ws.voiceChannelId && !canUseLiveVoice(userId, ws.voiceChannelId)) {
      const old = ws.voiceChannelId;
      ws.voiceChannelId = null;
      broadcastNative('voice:user_left', { channelId: old, user: publicUser(ws.user) }, (client) => client.voiceChannelId === old && canAccessChannel(client.user?.id, old));
      emitVoiceMembers(old);
    }
  }
}
// V7.6 kick/ban: forcibly remove a user from this server's live channel + voice rooms. The user is
// already out of memberIds, so revalidate* (Socket.IO + native WS) drops every room they held.
function removeUserFromServerRealtime(serverObj, userId) {
  revalidateUserRooms(userId);
}
// V7.6 audit log: small, sanitized, capped per server. Never stores objects/secrets/E2EE plaintext.
function addAudit(serverObj, type, actorId, targetId = '', details = {}) {
  if (!serverObj) return;
  serverObj.auditLog = Array.isArray(serverObj.auditLog) ? serverObj.auditLog : [];
  const safeDetails = {};
  for (const [k, v] of Object.entries(details || {})) {
    if (v == null) continue;
    if (typeof v === 'string') safeDetails[String(k).slice(0, 32)] = v.slice(0, 120);
    else if (typeof v === 'number' || typeof v === 'boolean') safeDetails[String(k).slice(0, 32)] = v;
    // objects/arrays are intentionally dropped to avoid leaking large/secret payloads
  }
  serverObj.auditLog.push({ id: id('aud_'), type: String(type).slice(0, 40), actorId: actorId || '', targetId: targetId || '', details: safeDetails, createdAt: now() });
  if (serverObj.auditLog.length > SERVER_AUDIT_LIMIT) serverObj.auditLog = serverObj.auditLog.slice(-SERVER_AUDIT_LIMIT);
}
function auditEntryView(entry) {
  return {
    id: entry.id,
    type: entry.type,
    actor: publicUser(db.users[entry.actorId]) || (entry.actorId ? { id: entry.actorId } : null),
    target: entry.targetId ? (publicUser(db.users[entry.targetId]) || { id: entry.targetId }) : null,
    details: entry.details || {},
    createdAt: entry.createdAt
  };
}
// V7.6 moderation hierarchy gate for kick/timeout/ban. Owner > Admin > Mod > Member; nobody may act
// on the owner or on a peer/superior (admins can act on mods/members, mods on members only).
function canActOnMember(serverObj, actorId, targetId) {
  if (!serverObj.memberIds.includes(targetId)) return { ok: false, status: 404, error: 'Üye bulunamadı.' };
  if (targetId === actorId) return { ok: false, status: 400, error: 'Kendine bu işlemi uygulayamazsın.' };
  if (targetId === serverObj.ownerId) return { ok: false, status: 403, error: 'Sunucu sahibine işlem yapılamaz.' };
  const actorRole = getServerRole(serverObj, actorId);
  const targetRole = getServerRole(serverObj, targetId);
  if (!actorRole || roleRank(actorRole) < roleRank('mod')) return { ok: false, status: 403, error: 'Bu işlem için yetkin yok.' };
  if (actorRole !== 'owner' && roleRank(targetRole) >= roleRank(actorRole)) return { ok: false, status: 403, error: 'Kendinle aynı veya üst yetkideki üyeye işlem yapamazsın.' };
  return { ok: true };
}
// V7.6 timeout enforcement: a timed-out member may read but not write (text/voice/file) in a server.
function assertCanPostInChannel(userId, channelId) {
  const channel = db.channels[channelId];
  if (!channel || !channel.serverId) return true; // DMs are unaffected by server timeouts
  return !isMemberTimedOut(db.servers[channel.serverId], userId);
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

app.post('/api/register', rateLimit('register', Number(process.env.REGISTER_RATE_LIMIT || 8), Number(process.env.REGISTER_RATE_WINDOW_MS || 10 * 60 * 1000)), (req, res) => {
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
  if (typeof req.body.bio === 'string') req.user.bio = String(req.body.bio).trim().slice(0, 280);
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
  recordSecurityEvent('backup_export', { adminUserId: req.user.id, light, ip: clientIp(req) });
  res.json({ app: 'gaycord', version: APP_VERSION, exportedAt: now(), light, db: outDb, uploads: light ? {} : exportUploads() });
});
app.post('/api/admin/import', auth, requireAdmin, rateLimit('admin_import', 6, 60 * 1000, (req) => req.user?.id || clientIp(req)), (req, res) => {
  const incoming = req.body?.db;
  if (!incoming || typeof incoming !== 'object' || !incoming.users || !incoming.servers) return res.status(400).json({ error: 'Geçersiz yedek dosyası.' });
  db = normalizeImportedDb(incoming); // strips sessions/securityEvents; never restores active session tokens
  if (!db.adminUserId || !db.users[db.adminUserId]) db.adminUserId = req.user.id;
  const uploadCount = importUploads(req.body.uploads || {});
  saveDbNow();
  recordSecurityEvent('backup_import', { adminUserId: req.user.id, uploads: uploadCount, ip: clientIp(req) });
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
  if (serverObj.bans?.[req.user.id]) return res.status(403).json({ error: 'Bu sunucudan yasaklandın.' }); // V7.6: banned users cannot rejoin
  if (!serverObj.memberIds.includes(req.user.id)) serverObj.memberIds.push(req.user.id);
  saveDbSoon();
  broadcastServerUpdated(serverObj);
  res.json({ server: ensureServerView(serverObj, req.user.id) });
});
app.patch('/api/servers/:serverId', auth, rateLimit('server_manage', 60, 60 * 1000, (req) => req.user.id), (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
  if (!canManageServer(req.user.id, serverObj.id)) return res.status(403).json({ error: 'Bu işlem için yetkin yok.' });
  if (typeof req.body.name === 'string') {
    const name = String(req.body.name || '').trim().slice(0, 40);
    if (name.length < 2) return res.status(400).json({ error: 'Sunucu adı en az 2 karakter olmalı.' });
    serverObj.name = name;
    addAudit(serverObj, 'server_updated', req.user.id, '', { name });
  }
  if (req.body.regenerateInvite) { serverObj.inviteCode = createUniqueInviteCode(db, serverObj.id); addAudit(serverObj, 'invite_regenerated', req.user.id, '', {}); }
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
  if (serverObj.roles) delete serverObj.roles[req.user.id]; // drop elevated role so it can't silently return on rejoin (timeouts persist as anti-evasion)
  saveDbSoon();
  broadcastServerUpdated(serverObj);
  revalidateUserRooms(req.user.id); // membership change: drop the leaver's live channel rooms immediately
  res.json({ ok: true });
});
app.post('/api/servers/:serverId/channels', auth, rateLimit('channel_manage', 60, 60 * 1000, (req) => req.user.id), (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
  if (!canManageChannels(req.user.id, serverObj.id)) return res.status(403).json({ error: 'Bu işlem için yetkin yok.' });
  if ((serverObj.channelIds?.length || 0) >= MAX_CHANNELS_PER_SERVER) return res.status(400).json({ error: 'Kanal limitine ulaşıldı.' });
  const kind = req.body.kind === 'voice' ? 'voice' : 'text';
  const name = String(req.body.name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  if (name.length < 2) return res.status(400).json({ error: 'Kanal adı en az 2 karakter olmalı.' });
  const channelId = id('chn_');
  db.channels[channelId] = { id: channelId, type: 'server', kind, serverId: serverObj.id, name, private: false, allowedRoles: [], allowedUserIds: [], topic: '', pinnedMessageIds: [], createdAt: now() };
  db.messages[channelId] = [];
  serverObj.channelIds.push(channelId);
  addAudit(serverObj, 'channel_created', req.user.id, '', { channel: name, kind });
  saveDbSoon();
  const view = ensureServerView(serverObj, req.user.id);
  broadcastServerUpdated(serverObj);
  res.status(201).json({ server: view, channel: channelView(db.channels[channelId], true) });
});
app.delete('/api/servers/:serverId/channels/:channelId', auth, rateLimit('channel_manage', 60, 60 * 1000, (req) => req.user.id), (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  const channel = db.channels[req.params.channelId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id) || !channel || channel.serverId !== serverObj.id) return res.status(404).json({ error: 'Kanal bulunamadı.' });
  if (!canManageChannels(req.user.id, serverObj.id)) return res.status(403).json({ error: 'Bu işlem için yetkin yok.' });
  if (serverObj.channelIds.length <= 1) return res.status(400).json({ error: 'Son kanalı silemezsin.' });
  serverObj.channelIds = serverObj.channelIds.filter((id) => id !== channel.id);
  addAudit(serverObj, 'channel_deleted', req.user.id, '', { channel: channel.name });
  delete db.messages[channel.id];
  delete db.channels[channel.id];
  saveDbSoon();
  io.to(channel.id).emit('channel:deleted', { channelId: channel.id, serverId: serverObj.id });
  io.to(`voice:${channel.id}`).emit('channel:deleted', { channelId: channel.id, serverId: serverObj.id });
  broadcastNative('channel:deleted', { channelId: channel.id, serverId: serverObj.id }, (ws) => serverObj.memberIds?.includes(ws.user?.id));
  res.json({ ok: true, server: ensureServerView(serverObj, req.user.id), channelId: channel.id });
});

// ===================== V7.6 Roles, Private Channels, Moderation & Audit =====================
const VALID_ASSIGNABLE_ROLES = ['admin', 'mod', 'member'];
// Load a server the caller is a member of and enforce the required permission tier in one place.
// need: 'manage'|'members'|'channels' => Admin+ ; 'moderate' => Mod+. Writes the 404/403 response.
function loadManageableServer(req, res, need = 'manage') {
  const serverObj = db.servers[req.params.serverId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id)) { res.status(404).json({ error: 'Sunucu bulunamadı.' }); return null; }
  const ok = need === 'moderate' ? canModerateServer(req.user.id, serverObj.id)
    : need === 'members' ? canManageMembers(req.user.id, serverObj.id)
    : need === 'channels' ? canManageChannels(req.user.id, serverObj.id)
    : canManageServer(req.user.id, serverObj.id);
  if (!ok) { res.status(403).json({ error: 'Bu işlem için yetkin yok.' }); return null; }
  return serverObj;
}

app.get('/api/servers/:serverId/roles', auth, (req, res) => {
  const serverObj = loadManageableServer(req, res, 'moderate');
  if (!serverObj) return;
  res.json({ ownerId: serverObj.ownerId, roles: serverObj.roles || {}, members: ensureServerView(serverObj, req.user.id).members });
});
app.get('/api/servers/:serverId/members', auth, (req, res) => {
  const serverObj = loadManageableServer(req, res, 'moderate');
  if (!serverObj) return;
  res.json({ members: ensureServerView(serverObj, req.user.id).members, bans: Object.entries(serverObj.bans || {}).map(([userId, b]) => ({ user: publicUser(db.users[userId]) || { id: userId }, reason: b.reason || '', at: b.at || '' })) });
});
// Assign Admin/Mod/Member. Owner/Admin only. Owner is immutable; an Admin cannot touch a peer/superior
// nor grant a role at/above their own rank. Triggers per-user room revalidation (private access may change).
app.patch('/api/servers/:serverId/members/:userId/role', auth, rateLimit('role_update', 60, 60 * 1000, (req) => req.user.id), (req, res) => {
  const serverObj = loadManageableServer(req, res, 'members');
  if (!serverObj) return;
  const targetId = req.params.userId;
  if (!serverObj.memberIds.includes(targetId)) return res.status(404).json({ error: 'Üye bulunamadı.' });
  const nextRole = String(req.body.role || '').toLowerCase();
  if (!VALID_ASSIGNABLE_ROLES.includes(nextRole)) return res.status(400).json({ error: 'Geçersiz rol.' });
  if (targetId === serverObj.ownerId) return res.status(403).json({ error: 'Sunucu sahibinin rolü değiştirilemez.' });
  if (targetId === req.user.id) return res.status(400).json({ error: 'Kendi rolünü değiştiremezsin.' });
  const actorRole = getServerRole(serverObj, req.user.id);
  const targetCurrentRole = getServerRole(serverObj, targetId);
  if (actorRole !== 'owner') {
    if (roleRank(targetCurrentRole) >= roleRank(actorRole)) return res.status(403).json({ error: 'Kendinle aynı veya üst yetkideki üyenin rolünü değiştiremezsin.' });
    if (roleRank(nextRole) >= roleRank(actorRole)) return res.status(403).json({ error: 'Kendinden yüksek bir rol veremezsin.' });
  }
  serverObj.roles = serverObj.roles || {};
  if (nextRole === 'member') delete serverObj.roles[targetId];
  else serverObj.roles[targetId] = nextRole;
  addAudit(serverObj, 'role_updated', req.user.id, targetId, { role: nextRole });
  saveDbSoon();
  broadcastServerUpdated(serverObj);
  revalidateUserRooms(targetId); // role change may grant/revoke private channel access
  res.json({ ok: true, role: nextRole, server: ensureServerView(serverObj, req.user.id) });
});

app.get('/api/servers/:serverId/channels/:channelId/permissions', auth, (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  const channel = db.channels[req.params.channelId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id) || !channel || channel.serverId !== serverObj.id) return res.status(404).json({ error: 'Kanal bulunamadı.' });
  const canManage = canManageChannels(req.user.id, serverObj.id);
  if (!canManage && !canAccessChannel(req.user.id, channel.id)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
  res.json({
    channelId: channel.id,
    name: channel.name,
    private: Boolean(channel.private),
    topic: channel.topic || '',
    permissionsUpdatedAt: channel.permissionsUpdatedAt || null,
    canManage,
    // allow-lists are manager-only metadata
    allowedRoles: canManage ? (channel.allowedRoles || []) : undefined,
    allowedUserIds: canManage ? (channel.allowedUserIds || []) : undefined
  });
});
// Set channel visibility (public/private) + allow-lists. Owner/Admin only. Owner/Admin always retain
// access via canAccessChannel, so a channel can never be made inaccessible to the owner.
app.patch('/api/servers/:serverId/channels/:channelId/privacy', auth, rateLimit('channel_privacy', 40, 60 * 1000, (req) => req.user.id), (req, res) => {
  const serverObj = db.servers[req.params.serverId];
  const channel = db.channels[req.params.channelId];
  if (!serverObj || !serverObj.memberIds.includes(req.user.id) || !channel || channel.serverId !== serverObj.id) return res.status(404).json({ error: 'Kanal bulunamadı.' });
  if (!canManageChannels(req.user.id, serverObj.id)) return res.status(403).json({ error: 'Bu işlem için yetkin yok.' });
  const makePrivate = req.body.private === undefined ? Boolean(channel.private) : Boolean(req.body.private);
  if (Array.isArray(req.body.allowedRoles)) {
    channel.allowedRoles = [...new Set(req.body.allowedRoles.map((r) => String(r).toLowerCase()).filter((r) => ['admin', 'mod', 'member'].includes(r)))];
  }
  if (Array.isArray(req.body.allowedUserIds)) {
    const members = new Set(serverObj.memberIds);
    channel.allowedUserIds = [...new Set(req.body.allowedUserIds.map((x) => String(x)).filter((x) => members.has(x)))].slice(0, MAX_ALLOWED_CHANNEL_USERS);
  }
  if (typeof req.body.topic === 'string') channel.topic = req.body.topic.trim().slice(0, 200);
  channel.private = makePrivate;
  channel.permissionsUpdatedAt = now();
  addAudit(serverObj, 'channel_privacy_updated', req.user.id, '', { channel: channel.name, private: makePrivate });
  saveDbSoon();
  broadcastServerUpdated(serverObj);                 // unauthorized members lose the channel from their list
  revalidateServerRooms(serverObj);                  // drop now-unauthorized live text/voice rooms
  emitToChannelSockets(channel.id, 'channel:permissions', { channelId: channel.id });
  res.json({ ok: true, channel: channelView(channel, true), server: ensureServerView(serverObj, req.user.id) });
});

// ---- Member moderation: kick / timeout / ban (audited, rate-limited, hierarchy-enforced) ----
app.post('/api/servers/:serverId/members/:userId/kick', auth, rateLimit('member_moderation', 40, 60 * 1000, (req) => req.user.id), (req, res) => {
  const serverObj = loadManageableServer(req, res, 'moderate');
  if (!serverObj) return;
  const targetId = req.params.userId;
  const check = canActOnMember(serverObj, req.user.id, targetId);
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  serverObj.memberIds = serverObj.memberIds.filter((mid) => mid !== targetId);
  if (serverObj.roles) delete serverObj.roles[targetId];
  if (serverObj.timeouts) delete serverObj.timeouts[targetId];
  addAudit(serverObj, 'member_kicked', req.user.id, targetId, { reason: String(req.body.reason || '').slice(0, 120) });
  saveDbSoon();
  removeUserFromServerRealtime(serverObj, targetId);                       // drop their channel + voice rooms now
  broadcastServerUpdated(serverObj);                                       // remaining members get the new member list
  emitToUsers([targetId], 'server:removed', { serverId: serverObj.id, reason: 'kick' });
  res.json({ ok: true });
});
app.post('/api/servers/:serverId/members/:userId/timeout', auth, rateLimit('member_moderation', 40, 60 * 1000, (req) => req.user.id), (req, res) => {
  const serverObj = loadManageableServer(req, res, 'moderate');
  if (!serverObj) return;
  const targetId = req.params.userId;
  const check = canActOnMember(serverObj, req.user.id, targetId);
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  const minutes = Math.floor(Number(req.body.minutes));
  if (!Number.isFinite(minutes) || minutes < 1) return res.status(400).json({ error: 'Geçerli bir süre gir (dakika).' });
  const cappedMinutes = Math.min(minutes, 60 * 24 * 7); // hard cap: 7 days
  const until = new Date(Date.now() + cappedMinutes * 60 * 1000).toISOString();
  serverObj.timeouts = serverObj.timeouts || {};
  serverObj.timeouts[targetId] = { until, by: req.user.id, reason: String(req.body.reason || '').slice(0, 120), createdAt: now() };
  addAudit(serverObj, 'member_timed_out', req.user.id, targetId, { minutes: cappedMinutes, until });
  saveDbSoon();
  broadcastServerUpdated(serverObj);
  emitToUsers([targetId], 'server:member_timeout', { serverId: serverObj.id, until });
  res.json({ ok: true, until });
});
app.delete('/api/servers/:serverId/members/:userId/timeout', auth, rateLimit('member_moderation', 40, 60 * 1000, (req) => req.user.id), (req, res) => {
  const serverObj = loadManageableServer(req, res, 'moderate');
  if (!serverObj) return;
  const targetId = req.params.userId;
  const check = canActOnMember(serverObj, req.user.id, targetId); // same hierarchy gate as applying a timeout
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  if (serverObj.timeouts) delete serverObj.timeouts[targetId];
  addAudit(serverObj, 'member_timeout_removed', req.user.id, targetId, {});
  saveDbSoon();
  broadcastServerUpdated(serverObj);
  emitToUsers([targetId], 'server:member_timeout', { serverId: serverObj.id, until: null });
  res.json({ ok: true });
});
app.post('/api/servers/:serverId/members/:userId/ban', auth, rateLimit('member_moderation', 40, 60 * 1000, (req) => req.user.id), (req, res) => {
  const serverObj = loadManageableServer(req, res, 'members'); // ban is heavier: Admin+
  if (!serverObj) return;
  const targetId = req.params.userId;
  const check = canActOnMember(serverObj, req.user.id, targetId);
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  serverObj.memberIds = serverObj.memberIds.filter((mid) => mid !== targetId);
  if (serverObj.roles) delete serverObj.roles[targetId];
  if (serverObj.timeouts) delete serverObj.timeouts[targetId];
  serverObj.bans = serverObj.bans || {};
  serverObj.bans[targetId] = { by: req.user.id, reason: String(req.body.reason || '').slice(0, 120), at: now() };
  addAudit(serverObj, 'member_banned', req.user.id, targetId, { reason: String(req.body.reason || '').slice(0, 120) });
  saveDbSoon();
  removeUserFromServerRealtime(serverObj, targetId);
  broadcastServerUpdated(serverObj);
  emitToUsers([targetId], 'server:removed', { serverId: serverObj.id, reason: 'ban' });
  res.json({ ok: true });
});
app.delete('/api/servers/:serverId/bans/:userId', auth, rateLimit('member_moderation', 40, 60 * 1000, (req) => req.user.id), (req, res) => {
  const serverObj = loadManageableServer(req, res, 'members');
  if (!serverObj) return;
  const targetId = req.params.userId;
  if (!serverObj.bans || !serverObj.bans[targetId]) return res.status(404).json({ error: 'Yasaklı üye bulunamadı.' }); // only audit real state transitions
  delete serverObj.bans[targetId];
  addAudit(serverObj, 'member_unbanned', req.user.id, targetId, {});
  saveDbSoon();
  res.json({ ok: true });
});

app.get('/api/servers/:serverId/audit-log', auth, (req, res) => {
  const serverObj = loadManageableServer(req, res, 'moderate'); // Owner/Admin/Mod may view
  if (!serverObj) return;
  const entries = (serverObj.auditLog || []).slice(-150).reverse().map(auditEntryView);
  res.json({ auditLog: entries });
});

app.get('/api/channels/:channelId/messages', auth, (req, res) => {
  if (!canAccessChannel(req.user.id, req.params.channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
  res.json({ messages: (db.messages[req.params.channelId] || []).slice(-200).map(sanitizeMessage) });
});
app.post('/api/channels/:channelId/messages', auth, rateLimit('messages', MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW_MS, (req) => req.user?.id || clientIp(req)), (req, res) => {
  try {
    const channelId = req.params.channelId;
    if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
    if (!assertCanPostInChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu sunucuda zaman aşımındasın (timeout); şu an mesaj gönderemezsin.' });
    const type = String(req.body.type || 'text').toLowerCase();
    const replyTo = sanitizeReplyTo(channelId, req.body.replyTo);
    let message;
    if (type === 'text') {
      if (req.body.encrypted) {
        const e2ee = cleanE2eePayload(req.body.e2ee, { maxCiphertextChars: MAX_E2EE_TEXT_BYTES, maxStoredBytes: MAX_E2EE_METADATA_BYTES });
        message = createMessage({ channelId, userId: req.user.id, type: 'text', text: '', encrypted: true, e2ee, replyTo });
      } else {
        const text = String(req.body.text || '').trim().slice(0, MAX_TEXT_LENGTH);
        if (!text) return res.status(400).json({ error: 'Boş mesaj gönderilemez.' });
        message = createMessage({ channelId, userId: req.user.id, type: 'text', text, replyTo });
      }
    } else if (type === 'voice') {
      const encrypted = Boolean(req.body.encrypted);
      const e2ee = encrypted ? cleanE2eePayload(req.body.e2ee, { allowAttachment: true, maxCiphertextChars: MAX_E2EE_TEXT_BYTES, maxStoredBytes: MAX_E2EE_METADATA_BYTES }) : null;
      if (encrypted) { const uploadRate = checkRateLimit('encrypted_uploads', req.user.id, 30, 60 * 1000); if (!uploadRate.ok) return res.status(429).json({ error: 'Çok hızlı dosya/ses gönderiyorsun. Biraz bekle.' }); }
      const upload = persistUpload({ data: req.body.audioData, mimeType: req.body.mimeType || 'audio/webm', fileName: req.body.fileName || 'voice.webm', prefix: 'voice_', channelId, userId: req.user.id, encrypted });
      if (!encrypted && !upload.mimeType.startsWith('audio/')) return res.status(400).json({ error: 'Ses formatı desteklenmiyor.' });
      message = createMessage({ channelId, userId: req.user.id, type: 'voice', audioUrl: upload.url, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, durationMs: Number(req.body.durationMs || 0) || null, encrypted, e2ee, replyTo });
    } else if (type === 'file') {
      const encrypted = Boolean(req.body.encrypted);
      const e2ee = encrypted ? cleanE2eePayload(req.body.e2ee, { allowAttachment: true, maxCiphertextChars: MAX_E2EE_TEXT_BYTES, maxStoredBytes: MAX_E2EE_METADATA_BYTES }) : null;
      if (encrypted) { const uploadRate = checkRateLimit('encrypted_uploads', req.user.id, 30, 60 * 1000); if (!uploadRate.ok) return res.status(429).json({ error: 'Çok hızlı dosya/ses gönderiyorsun. Biraz bekle.' }); }
      const upload = persistUpload({ data: req.body.fileData, mimeType: req.body.mimeType || 'application/octet-stream', fileName: req.body.fileName || 'dosya', prefix: 'file_', channelId, userId: req.user.id, encrypted });
      message = createMessage({ channelId, userId: req.user.id, type: 'file', fileUrl: upload.url, fileName: encrypted ? 'encrypted.gce' : upload.originalName, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, text: encrypted ? '' : String(req.body.text || '').slice(0, 300), encrypted, e2ee, replyTo });
    } else return res.status(400).json({ error: 'Bilinmeyen mesaj türü.' });
    broadcastMessage(channelId, message);
    notifyNewMessage(channelId, message);
    res.status(201).json({ message });
  } catch (error) { res.status(400).json({ error: error.message || 'Mesaj gönderilemedi.' }); }
});

// ---- V7.4 Feature 1: message actions (edit own plaintext, delete own/owner, reactions) ----
app.patch('/api/channels/:channelId/messages/:messageId', auth, rateLimit('message_actions', 120, 60 * 1000, (req) => req.user.id), (req, res) => {
  const { channelId, messageId } = req.params;
  if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
  const message = findMessageById(channelId, messageId);
  if (!message) return res.status(404).json({ error: 'Mesaj bulunamadı.' });
  if (message.userId !== req.user.id) return res.status(403).json({ error: 'Sadece kendi mesajını düzenleyebilirsin.' });
  if (!assertCanPostInChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu sunucuda zaman aşımındasın (timeout); şu an mesaj gönderemezsin.' }); // editing re-broadcasts content -> same write-restriction as sending
  if (message.encrypted || message.type !== 'text') return res.status(400).json({ error: 'Sadece kendi şifresiz metin mesajların düzenlenebilir.' });
  const text = String(req.body.text || '').trim().slice(0, MAX_TEXT_LENGTH);
  if (!text) return res.status(400).json({ error: 'Boş mesaj olamaz.' });
  message.text = text;
  message.editedAt = now();
  saveDbSoon();
  const view = sanitizeMessage(message);
  broadcastMessageUpdated(channelId, view);
  res.json({ message: view });
});
app.delete('/api/channels/:channelId/messages/:messageId', auth, rateLimit('message_actions', 120, 60 * 1000, (req) => req.user.id), (req, res) => {
  const { channelId, messageId } = req.params;
  if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
  const list = db.messages[channelId] || [];
  const index = list.findIndex((m) => m.id === messageId);
  if (index < 0) return res.status(404).json({ error: 'Mesaj bulunamadı.' });
  const targetMessage = list[index];
  if (!canDeleteMessage(req.user, channelId, targetMessage)) return res.status(403).json({ error: 'Bu mesajı silme yetkin yok.' });
  const moderated = targetMessage.userId !== req.user.id; // a moderator removing someone else's message
  list.splice(index, 1);
  const channel = db.channels[channelId];
  if (channel?.pinnedMessageIds) channel.pinnedMessageIds = channel.pinnedMessageIds.filter((mid) => mid !== messageId);
  if (moderated && channel?.serverId) addAudit(db.servers[channel.serverId], 'message_deleted_by_moderator', req.user.id, targetMessage.userId, { channel: channel.name });
  saveDbSoon();
  broadcastMessageDeleted(channelId, messageId);
  res.json({ ok: true });
});
app.post('/api/channels/:channelId/messages/:messageId/reactions', auth, rateLimit('reactions', 120, 60 * 1000, (req) => req.user?.id || clientIp(req)), (req, res) => {
  const { channelId, messageId } = req.params;
  if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
  const message = findMessageById(channelId, messageId);
  if (!message) return res.status(404).json({ error: 'Mesaj bulunamadı.' });
  const emoji = String(req.body.emoji || '');
  if (!REACTION_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Geçersiz tepki.' });
  message.reactions = (message.reactions && typeof message.reactions === 'object') ? message.reactions : {};
  const ids = Array.isArray(message.reactions[emoji]) ? message.reactions[emoji] : [];
  if (ids.includes(req.user.id)) {
    message.reactions[emoji] = ids.filter((uid) => uid !== req.user.id);
  } else {
    if (ids.length >= 200) return res.status(409).json({ error: 'Bu tepki için sınıra ulaşıldı.' }); // bound stored userIds (matches view cap)
    message.reactions[emoji] = [...ids, req.user.id];
  }
  if (!message.reactions[emoji].length) delete message.reactions[emoji];
  saveDbSoon();
  const view = sanitizeMessage(message);
  broadcastMessageUpdated(channelId, view);
  res.json({ message: view });
});

// ---- V7.4 Feature 2: profile (avatar/banner uploads, bio, profile card) ----
app.post('/api/me/avatar', auth, rateLimit('profile_media', 30, 60 * 1000, (req) => req.user.id), (req, res) => {
  try {
    if (Math.floor(String(req.body.fileData || '').length * 0.75) > PROFILE_MEDIA_MAX_BYTES) return res.status(400).json({ error: `Avatar ${Math.round(PROFILE_MEDIA_MAX_BYTES / 1024 / 1024)} MB sınırını aşıyor.` });
    const upload = persistUpload({ data: req.body.fileData, mimeType: req.body.mimeType || 'image/png', fileName: req.body.fileName || 'avatar.png', prefix: 'avatar_', channelId: '', userId: req.user.id });
    if (!upload.mimeType.startsWith('image/')) { deleteStoredUpload(upload.url, req.user.id); return res.status(400).json({ error: 'Avatar bir görsel olmalı.' }); }
    const previous = req.user.avatarUrl;
    req.user.avatarUrl = upload.url;
    if (previous && previous !== upload.url) deleteStoredUpload(previous, req.user.id);
    saveDbSoon();
    emitToUsers([req.user.id], 'me:updated', { user: meUser(req.user) });
    res.json({ user: { ...meUser(req.user), isAppOwner: isAdminUser(req.user) } });
  } catch (error) { res.status(400).json({ error: error.message || 'Avatar yüklenemedi.' }); }
});
app.post('/api/me/banner', auth, rateLimit('profile_media', 30, 60 * 1000, (req) => req.user.id), (req, res) => {
  try {
    if (Math.floor(String(req.body.fileData || '').length * 0.75) > PROFILE_MEDIA_MAX_BYTES) return res.status(400).json({ error: `Afiş ${Math.round(PROFILE_MEDIA_MAX_BYTES / 1024 / 1024)} MB sınırını aşıyor.` });
    const upload = persistUpload({ data: req.body.fileData, mimeType: req.body.mimeType || 'image/png', fileName: req.body.fileName || 'banner.png', prefix: 'banner_', channelId: '', userId: req.user.id });
    if (!upload.mimeType.startsWith('image/')) { deleteStoredUpload(upload.url, req.user.id); return res.status(400).json({ error: 'Afiş bir görsel olmalı.' }); }
    const previous = req.user.bannerUrl;
    req.user.bannerUrl = upload.url;
    if (previous && previous !== upload.url) deleteStoredUpload(previous, req.user.id);
    saveDbSoon();
    emitToUsers([req.user.id], 'me:updated', { user: meUser(req.user) });
    res.json({ user: { ...meUser(req.user), isAppOwner: isAdminUser(req.user) } });
  } catch (error) { res.status(400).json({ error: error.message || 'Afiş yüklenemedi.' }); }
});
app.get('/api/users/:userId/profile', auth, (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  const mutualServers = Object.values(db.servers).filter((s) => s.memberIds?.includes(user.id) && s.memberIds?.includes(req.user.id)).length;
  res.json({ profile: { ...publicUser(user), bio: String(user.bio || ''), bannerUrl: user.bannerUrl || '', friendship: getFriendship(req.user.id, user.id)?.status || null, mutualServers, isSelf: user.id === req.user.id } });
});

// ---- V7.4 Feature 3: pins (owner/creator only) + personal bookmarks ----
app.get('/api/channels/:channelId/pins', auth, (req, res) => {
  const { channelId } = req.params;
  if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
  const channel = db.channels[channelId];
  const pins = (channel?.pinnedMessageIds || []).map((mid) => findMessageById(channelId, mid)).filter(Boolean).map(sanitizeMessage);
  res.json({ pins, canManage: canManagePins(req.user.id, channelId) });
});
app.post('/api/channels/:channelId/pins/:messageId', auth, rateLimit('message_actions', 120, 60 * 1000, (req) => req.user.id), (req, res) => {
  const { channelId, messageId } = req.params;
  if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
  if (!canManagePins(req.user.id, channelId)) return res.status(403).json({ error: 'Mesaj sabitleme yetkin yok.' });
  if (!findMessageById(channelId, messageId)) return res.status(404).json({ error: 'Mesaj bulunamadı.' });
  const channel = db.channels[channelId];
  channel.pinnedMessageIds = Array.isArray(channel.pinnedMessageIds) ? channel.pinnedMessageIds : [];
  if (!channel.pinnedMessageIds.includes(messageId)) channel.pinnedMessageIds.push(messageId);
  if (channel.pinnedMessageIds.length > 50) channel.pinnedMessageIds = channel.pinnedMessageIds.slice(-50);
  if (channel.serverId) addAudit(db.servers[channel.serverId], 'pin_added', req.user.id, '', { channel: channel.name });
  saveDbSoon();
  emitToChannelSockets(channelId, 'channel:pins', { channelId });
  res.json({ ok: true });
});
app.delete('/api/channels/:channelId/pins/:messageId', auth, rateLimit('message_actions', 120, 60 * 1000, (req) => req.user.id), (req, res) => {
  const { channelId, messageId } = req.params;
  if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
  if (!canManagePins(req.user.id, channelId)) return res.status(403).json({ error: 'Yetkin yok.' });
  const channel = db.channels[channelId];
  if (channel?.pinnedMessageIds) channel.pinnedMessageIds = channel.pinnedMessageIds.filter((mid) => mid !== messageId);
  if (channel?.serverId) addAudit(db.servers[channel.serverId], 'pin_removed', req.user.id, '', { channel: channel.name });
  saveDbSoon();
  emitToChannelSockets(channelId, 'channel:pins', { channelId });
  res.json({ ok: true });
});
app.get('/api/bookmarks', auth, (req, res) => {
  const out = [];
  for (const bm of (req.user.bookmarks || [])) {
    if (!canAccessChannel(req.user.id, bm.channelId)) continue; // never reveal messages from channels the user lost access to
    const message = findMessageById(bm.channelId, bm.messageId);
    if (!message) continue;
    out.push({ ...sanitizeMessage(message), channelName: channelDisplayName(bm.channelId), savedAt: bm.createdAt });
  }
  res.json({ bookmarks: out.reverse() });
});
app.post('/api/bookmarks', auth, rateLimit('user_state', 120, 60 * 1000, (req) => req.user.id), (req, res) => {
  const channelId = String(req.body.channelId || '');
  const messageId = String(req.body.messageId || '');
  if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
  if (!findMessageById(channelId, messageId)) return res.status(404).json({ error: 'Mesaj bulunamadı.' });
  req.user.bookmarks = Array.isArray(req.user.bookmarks) ? req.user.bookmarks : [];
  if (!req.user.bookmarks.some((b) => b.messageId === messageId)) {
    req.user.bookmarks.push({ channelId, messageId, createdAt: now() });
    if (req.user.bookmarks.length > 200) req.user.bookmarks = req.user.bookmarks.slice(-200);
    saveDbSoon();
  }
  res.status(201).json({ ok: true });
});
app.delete('/api/bookmarks/:messageId', auth, rateLimit('user_state', 120, 60 * 1000, (req) => req.user.id), (req, res) => {
  req.user.bookmarks = (req.user.bookmarks || []).filter((b) => b.messageId !== req.params.messageId);
  saveDbSoon();
  res.json({ ok: true });
});

// ---- V7.4 Feature 4: channel media gallery (respects canAccessChannel + protected uploads) ----
app.get('/api/channels/:channelId/media', auth, (req, res) => {
  const { channelId } = req.params;
  if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
  const media = (db.messages[channelId] || []).filter((m) => m.type === 'file' || m.type === 'voice').slice(-120).reverse().map(sanitizeMessage);
  res.json({ media });
});

// ---- V7.4 Feature 5: notification center (unread counts, read markers) ----
app.post('/api/channels/:channelId/read', auth, rateLimit('user_state', 120, 60 * 1000, (req) => req.user.id), (req, res) => {
  const { channelId } = req.params;
  if (!canAccessChannel(req.user.id, channelId)) return res.status(403).json({ error: 'Bu kanala erişimin yok.' });
  req.user.reads = (req.user.reads && typeof req.user.reads === 'object') ? req.user.reads : {};
  req.user.reads[channelId] = now();
  // Prune stale read markers (deleted/left channels) and hard-cap the map so it cannot grow unbounded.
  const keys = Object.keys(req.user.reads);
  if (keys.length > 400) {
    for (const cid of keys) if (!db.channels[cid]) delete req.user.reads[cid];
    const remaining = Object.keys(req.user.reads);
    if (remaining.length > 500) for (const cid of remaining.slice(0, remaining.length - 500)) delete req.user.reads[cid];
  }
  saveDbSoon();
  res.json({ ok: true });
});
app.get('/api/notifications', auth, rateLimit('notifications', 60, 60 * 1000, (req) => req.user.id), (req, res) => {
  const reads = (req.user.reads && typeof req.user.reads === 'object') ? req.user.reads : {};
  const unread = {};
  let totalUnread = 0;
  for (const channelId of accessibleChannelIdsFor(req.user.id)) {
    const since = reads[channelId] ? Date.parse(reads[channelId]) : 0;
    const list = db.messages[channelId] || [];
    let count = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (Date.parse(m.createdAt) <= since) break;
      if (m.userId === req.user.id) continue;
      count += 1;
      if (count >= 99) break;
    }
    if (count) { unread[channelId] = count; totalUnread += count; }
  }
  const friends = friendSummaryFor(req.user.id);
  res.json({ unread, totalUnread, friendRequests: friends.incomingRequests.length });
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
  // Drop stale rooms restored by connectionStateRecovery BEFORE this socket can receive any broadcast.
  revalidateSocketRooms(socket);
  onlineCounts.set(userId, (onlineCounts.get(userId) || 0) + 1);
  emitPresence();
  socket.emit('session', { user: publicUser(socket.user), onlineIds: [...onlineCounts.keys()], recovered: Boolean(socket.recovered) });

  socket.on('channel:join', ({ channelId } = {}, callback = () => {}) => {
    if (!canAccessChannel(userId, channelId)) return callback({ error: 'Bu kanala erişimin yok.' });
    socket.join(channelId);
    callback({ ok: true, messages: (db.messages[channelId] || []).slice(-200).map(sanitizeMessage) });
  });
  socket.on('message:text', ({ channelId, text, replyTo } = {}, callback = () => {}) => {
    try {
      const limited = socketRateLimit(socket, 'messages');
      if (!limited.ok) return callback({ error: limited.error });
      if (!canAccessChannel(userId, channelId)) return callback({ error: 'Bu kanala erişimin yok.' });
      if (!assertCanPostInChannel(userId, channelId)) return callback({ error: 'Bu sunucuda zaman aşımındasın (timeout); şu an mesaj gönderemezsin.' });
      const clean = String(text || '').trim().slice(0, MAX_TEXT_LENGTH);
      if (!clean) return callback({ error: 'Boş mesaj gönderilemez.' });
      const message = createMessage({ channelId, userId, type: 'text', text: clean, replyTo: sanitizeReplyTo(channelId, replyTo) });
      broadcastMessage(channelId, message);
      notifyNewMessage(channelId, message);
      callback({ ok: true, message });
    } catch (error) { callback({ error: error.message || 'Mesaj gönderilemedi.' }); }
  });
  socket.on('message:voice', ({ channelId, audioData, mimeType, durationMs, encrypted, e2ee, replyTo } = {}, callback = () => {}) => {
    try {
      const limited = socketRateLimit(socket, 'messages');
      if (!limited.ok) return callback({ error: limited.error });
      if (!canAccessChannel(userId, channelId)) return callback({ error: 'Bu kanala erişimin yok.' });
      if (!assertCanPostInChannel(userId, channelId)) return callback({ error: 'Bu sunucuda zaman aşımındasın (timeout); şu an mesaj gönderemezsin.' });
      const secure = Boolean(encrypted);
      const secureMeta = secure ? cleanE2eePayload(e2ee, { allowAttachment: true, maxCiphertextChars: MAX_E2EE_TEXT_BYTES, maxStoredBytes: MAX_E2EE_METADATA_BYTES }) : null;
      const upload = persistUpload({ data: audioData, mimeType: mimeType || 'audio/webm', fileName: secure ? 'encrypted-voice.gce' : 'voice.webm', prefix: 'voice_', channelId, userId, encrypted: secure });
      if (!secure && !upload.mimeType.startsWith('audio/')) return callback({ error: 'Ses formatı desteklenmiyor.' });
      const message = createMessage({ channelId, userId, type: 'voice', audioUrl: upload.url, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, durationMs: Number(durationMs || 0) || null, encrypted: secure, e2ee: secureMeta, replyTo: sanitizeReplyTo(channelId, replyTo) });
      broadcastMessage(channelId, message);
      notifyNewMessage(channelId, message);
      callback({ ok: true, message });
    } catch (error) { callback({ error: error.message || 'Sesli mesaj gönderilemedi.' }); }
  });
  socket.on('message:secure', ({ channelId, e2ee, replyTo } = {}, callback = () => {}) => {
    try {
      const limited = socketRateLimit(socket, 'messages');
      if (!limited.ok) return callback({ error: limited.error });
      if (!canAccessChannel(userId, channelId)) return callback({ error: 'Bu kanala erişimin yok.' });
      if (!assertCanPostInChannel(userId, channelId)) return callback({ error: 'Bu sunucuda zaman aşımındasın (timeout); şu an mesaj gönderemezsin.' });
      const message = createMessage({ channelId, userId, type: 'text', text: '', encrypted: true, e2ee: cleanE2eePayload(e2ee, { maxCiphertextChars: MAX_E2EE_TEXT_BYTES, maxStoredBytes: MAX_E2EE_METADATA_BYTES }), replyTo: sanitizeReplyTo(channelId, replyTo) });
      broadcastMessage(channelId, message);
      notifyNewMessage(channelId, message);
      callback({ ok: true, message });
    } catch (error) { callback({ error: error.message || 'Şifreli mesaj gönderilemedi.' }); }
  });
  socket.on('typing', ({ channelId, isTyping } = {}) => {
    if (!canAccessChannel(userId, channelId)) return;
    // Room-scoped relay: recipients are trusted because revalidateSocketRooms (on connect) and
    // revalidateUserRooms (on membership change) keep channel rooms free of unauthorized sockets.
    // Any future kick/ban path MUST call revalidateUserRooms to preserve this invariant.
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
    broadcastNative('voice:user_joined', { channelId, user: publicUser(socket.user) }, (client) => client.voiceChannelId === channelId && canAccessChannel(client.user?.id, channelId));
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
    broadcastNative('voice:frame', { channelId: targetChannelId, from: publicUser(socket.user), pcmBase64: frame }, (client) => client.voiceChannelId === targetChannelId && canAccessChannel(client.user?.id, targetChannelId));
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
      broadcastNative('voice:user_joined', { channelId, user: publicUser(ws.user) }, (client) => client !== ws && client.voiceChannelId === channelId && canAccessChannel(client.user?.id, channelId));
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
      broadcastNative('voice:frame', { channelId, from: publicUser(ws.user), pcmBase64 }, (client) => client !== ws && client.voiceChannelId === channelId && canAccessChannel(client.user?.id, channelId));
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
