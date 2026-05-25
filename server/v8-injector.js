const fs = require('fs');
const path = require('path');
const Module = require('module');

const originalLoader = Module._extensions['.js'];
const serverPathSuffix = `${path.sep}server.js`;

function replaceBlock(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`V8 injector marker not found: ${startMarker}`);
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

Module._extensions['.js'] = function gaycordV8Loader(module, filename) {
  if (!filename.endsWith(serverPathSuffix)) return originalLoader(module, filename);
  let source = fs.readFileSync(filename, 'utf8');
  source = source.replace("const APP_VERSION = '7.0.0';", "const APP_VERSION = '8.0.0';");
  source = source.replace("const APP_NAME = 'gaycord-v7';", "const APP_NAME = 'gaycord-v8';");
  source = source.replace("version: 7,", "version: 8,");
  source = source.replace(/db\.version = 7;/g, "db.version = 8;");
  source = source.replace(/db\.meta\.version = 7;/g, "db.meta.version = 8;");
  source = source.replace(/console\.log\(`Gaycord V7 veri modu:/g, "console.log(`Gaycord V8 veri modu:");
  source = source.replace(/console\.log\(`Gaycord V7 çalışıyor:/g, "console.log(`Gaycord V8 çalışıyor:");

  source = replaceBlock(source, 'function publicUser(user) {', '\n\nfunction meUser', `function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    status: user.status || '',
    bio: user.bio || '',
    avatarUrl: user.avatarUrl || '',
    bannerUrl: user.bannerUrl || '',
    badges: Array.isArray(user.badges) ? user.badges.slice(0, 8) : [],
    online: onlineCounts.has(user.id),
    createdAt: user.createdAt
  };
}`);

  source = replaceBlock(source, 'function canAccessChannel(userId, channelId) {', '\nfunction channelIsVoice', `function canAccessChannel(userId, channelId) {
  const channel = db.channels[channelId];
  if (!channel) return false;
  if (channel.type === 'dm') return channel.memberIds?.includes(userId);
  const server = db.servers[channel.serverId];
  if (!server || !server.memberIds?.includes(userId)) return false;
  if ((server.bannedUserIds || []).includes(userId)) return false;
  const timeoutUntil = server.timeouts?.[userId];
  if (timeoutUntil && Date.parse(timeoutUntil) > Date.now()) return false;
  if (server.ownerId === userId || db.adminUserId === userId) return true;
  const role = server.roles?.[userId] || 'member';
  if (['admin', 'mod'].includes(role)) return true;
  if (channel.private) {
    if ((channel.allowedUserIds || []).includes(userId)) return true;
    if ((channel.allowedRoles || []).includes(role)) return true;
    return false;
  }
  return true;
}`);

  source = source.replace("channels: (server.channelIds || []).map((channelId) => db.channels[channelId]).filter(Boolean),", "channels: (server.channelIds || []).map((channelId) => db.channels[channelId]).filter(Boolean).filter((channel) => !viewerId || canAccessChannel(viewerId, channel.id)),");

  source = replaceBlock(source, 'function sanitizeMessage(message) {', '\nfunction approxStoredBytes', `function sanitizeMessage(message) {
  const user = db.users[message.userId];
  const replyTo = message.replyToId ? (db.messages[message.channelId] || []).find((item) => item.id === message.replyToId) : null;
  return {
    id: message.id,
    channelId: message.channelId,
    type: message.type,
    user: publicUser(user),
    text: message.deletedAt ? '' : (message.text || ''),
    audioUrl: message.deletedAt ? '' : (message.audioUrl || ''),
    fileUrl: message.deletedAt ? '' : (message.fileUrl || ''),
    fileName: message.deletedAt ? '' : (message.fileName || ''),
    mimeType: message.mimeType || '',
    sizeBytes: message.sizeBytes || null,
    durationMs: message.durationMs || null,
    encrypted: Boolean(message.encrypted),
    e2ee: message.deletedAt ? null : (message.e2ee || null),
    replyToId: message.replyToId || '',
    replyTo: replyTo ? { id: replyTo.id, user: publicUser(db.users[replyTo.userId]), text: String(replyTo.text || '').slice(0, 160), deletedAt: replyTo.deletedAt || '' } : null,
    mentions: Array.isArray(message.mentions) ? message.mentions.slice(0, 20) : [],
    reactions: message.reactions || {},
    readBy: message.readBy || {},
    editedAt: message.editedAt || '',
    deletedAt: message.deletedAt || '',
    createdAt: message.createdAt
  };
}`);

  source = replaceBlock(source, 'function createMessage({ channelId, userId, type, text = \'\', audioUrl = \'\', fileUrl = \'\', fileName = \'\', mimeType = \'\', sizeBytes = null, durationMs = null, encrypted = false, e2ee = null }) {', '\n\nfunction decodeBase64Upload', `function extractMentions(text) {
  const hits = new Set();
  const raw = String(text || '');
  const names = raw.match(/@([a-z0-9_]{3,20}|everyone|admin)/gi) || [];
  for (const tag of names) {
    const key = tag.slice(1).toLowerCase();
    if (key === 'everyone' || key === 'admin') hits.add(key);
    else if (db.usernameIndex[key]) hits.add(db.usernameIndex[key]);
  }
  return [...hits].slice(0, 20);
}
function createMessage({ channelId, userId, type, text = '', audioUrl = '', fileUrl = '', fileName = '', mimeType = '', sizeBytes = null, durationMs = null, encrypted = false, e2ee = null, replyToId = '', mentions = null }) {
  const message = { id: id('msg_'), channelId, userId, type, text, audioUrl, fileUrl, fileName, mimeType, sizeBytes, durationMs, encrypted: Boolean(encrypted), e2ee: e2ee || null, replyToId: replyToId || '', mentions: Array.isArray(mentions) ? mentions.slice(0, 20) : extractMentions(text), reactions: {}, readBy: {}, createdAt: now() };
  const messageBytes = approxStoredBytes(message);
  if (messageBytes > Math.min(MAX_STORED_MESSAGE_BYTES, MAX_CHANNEL_MESSAGE_BYTES, MAX_USER_MESSAGE_BYTES)) throw new Error('Mesaj güvenlik sınırını aşıyor. Büyük dosyaları mesaj gövdesinde değil upload olarak gönder.');
  db.messages[channelId] ||= [];
  db.messages[channelId].push(message);
  enforceMessageAggregateLimits(channelId, userId);
  saveDbSoon();
  return sanitizeMessage(message);
}`);

  source = source.replace('\nasync function start() {', `\ntry {\n  require('./v8-social-extension')({\n    app, io,\n    getDb: () => db,\n    setDb: (next) => { db = next; },\n    saveDbSoon, saveDbNow, now, id, auth, requireAdmin, isAdminUser, publicUser, canAccessChannel,\n    ensureServerView, serversFor, broadcastMessage, broadcastServerUpdated, emitToUsers, recordSecurityEvent,\n    rateLimit, sanitizeMessage, createMessage, persistUpload, MAX_TEXT_LENGTH, MAX_UPLOAD_BYTES\n  });\n} catch (error) {\n  console.error('Gaycord V8 extension failed:', error);\n}\n\nasync function start() {`);

  return module._compile(source, filename);
};
