const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const CSRF_HEADER = 'x-gaycord-csrf';

function read(fileName) {
  return fs.readFileSync(path.join(ROOT, fileName), 'utf8');
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 12000) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await sleep(150);
  }
  throw new Error('server did not become healthy');
}

function cookieFrom(response) {
  const setCookie = response.headers.get('set-cookie') || '';
  const match = setCookie.match(/sid=[^;]+/);
  assert(match, 'expected sid cookie');
  return match[0];
}

async function api(baseUrl, pathName, { method = 'GET', session = null, body = undefined } = {}) {
  const headers = {};
  if (session?.cookie) headers.Cookie = session.cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && session?.csrf) headers[CSRF_HEADER] = session.csrf;
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { response, json, text };
}

async function register(baseUrl, username) {
  const response = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName: username, password: 'correct horse battery staple' })
  });
  const json = await response.json();
  assert.equal(response.status, 201, `register ${username}: ${JSON.stringify(json)}`);
  return { cookie: cookieFrom(response), csrf: json.csrfToken, user: json.user };
}

async function login(baseUrl, username) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'correct horse battery staple' })
  });
  const json = await response.json();
  assert.equal(response.status, 200, `login ${username}: ${JSON.stringify(json)}`);
  return { cookie: cookieFrom(response), csrf: json.csrfToken, user: json.user };
}

function smallE2eePayload(ciphertext = 'U0VDUkVU') {
  return {
    v: 1,
    alg: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: 250000,
    salt: 'U0FMVA==',
    iv: 'SVZJVklWSVZJVg==',
    ciphertext
  };
}

function connectSocketIo(baseUrl, session) {
  const wsUrl = `${baseUrl.replace(/^http:/, 'ws:')}/socket.io/?EIO=4&transport=websocket`;
  const ws = new WebSocket(wsUrl, { headers: { Cookie: session.cookie } });
  let nextAckId = 1;
  const pending = new Map();
  let connectedResolve;
  let connectedReject;
  const seenPackets = [];
  const receivedEvents = [];
  const eventWaiters = new Map();
  const connected = new Promise((resolve, reject) => {
    connectedResolve = resolve;
    connectedReject = reject;
  });
  const timer = setTimeout(() => connectedReject(new Error(`socket.io connect timeout; packets=${seenPackets.join(' | ')}`)), 5000);

  ws.on('open', () => {});
  ws.on('message', (raw) => {
    const packet = raw.toString();
    seenPackets.push(packet);
    if (packet.startsWith('0')) {
      ws.send('40');
      return;
    }
    if (packet === '2') {
      ws.send('3');
      return;
    }
    if (packet.startsWith('40')) {
      clearTimeout(timer);
      connectedResolve();
      return;
    }
    if (packet.startsWith('44')) {
      clearTimeout(timer);
      connectedReject(new Error(`socket.io connect rejected: ${packet}`));
      return;
    }
    const ack = packet.match(/^43(\d+)(.*)$/);
    if (ack) {
      const callback = pending.get(ack[1]);
      pending.delete(ack[1]);
      if (!callback) return;
      let payload = [];
      try { payload = JSON.parse(ack[2] || '[]'); } catch (error) { callback.reject(error); return; }
      callback.resolve(payload[0] || {});
      return;
    }
    const evt = packet.match(/^42(\d*)(\[[\s\S]*\])$/);
    if (evt) {
      try {
        const arr = JSON.parse(evt[2]);
        const name = arr[0];
        const data = arr[1];
        receivedEvents.push({ name, data });
        const waiters = eventWaiters.get(name) || [];
        eventWaiters.set(name, []);
        for (const w of waiters) { clearTimeout(w.timer); w.resolve(data); }
      } catch {}
    }
  });
  ws.on('error', (error) => connectedReject(error));
  ws.on('unexpected-response', (_request, response) => {
    connectedReject(new Error(`socket.io unexpected response: ${response.statusCode} ${response.statusMessage || ''}`));
  });
  ws.on('close', (code, reason) => connectedReject(new Error(`socket.io closed before connect: ${code} ${reason}`)));

  return {
    async emit(event, payload) {
      await connected;
      const ackId = String(nextAckId++);
      const result = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(ackId);
          reject(new Error(`socket.io ack timeout for ${event}`));
        }, 5000);
        pending.set(ackId, {
          resolve: (value) => { clearTimeout(timeout); resolve(value); },
          reject: (error) => { clearTimeout(timeout); reject(error); }
        });
      });
      ws.send(`42${ackId}${JSON.stringify([event, payload])}`);
      return result;
    },
    waitForEvent(name, ms = 1000) {
      return new Promise((resolve) => {
        const entry = { resolve };
        entry.timer = setTimeout(() => {
          eventWaiters.set(name, (eventWaiters.get(name) || []).filter((e) => e !== entry));
          resolve(null);
        }, ms);
        const arr = eventWaiters.get(name) || [];
        arr.push(entry);
        eventWaiters.set(name, arr);
      });
    },
    receivedEventNames() { return receivedEvents.map((e) => e.name); },
    close() {
      try { ws.close(); } catch {}
    }
  };
}

async function main() {
  const appJs = read('public/app.js');
  assert(!/localStorage\.setItem\s*\(/.test(appJs), 'app must not write backups, tokens, or secrets to localStorage');
  assert(/function setLocalBackup\(\) \{ purgeLegacySensitiveLocalBackups\(\); return false; \}/.test(appJs), 'setLocalBackup must remain disabled');
  assert(/function startAutoBackup\(\)[\s\S]*state\.autoBackupTimer = null;[\s\S]*purgeLegacySensitiveLocalBackups\(\);/.test(appJs), 'admin auto backup timer must stay disabled');

  // --- V7.3 static UI / composer / E2EE / asset checks ---
  const indexHtml = read('public/index.html');
  const stylesCss = read('public/styles.css');
  const swJs = read('public/sw.js');
  const serverJs = read('server.js');

  // Composer + chat layout elements must exist in the shell.
  for (const id of ['messageForm', 'messageInput', 'sendButton', 'fileButton', 'recordButton', 'composerLock', 'voicePanel', 'e2eeWarning', 'typingLine', 'messages']) {
    assert(indexHtml.includes(`id="${id}"`), `index.html must contain #${id}`);
  }

  // Robust always-visible composer layout primitives.
  assert(/100dvh/.test(stylesCss), 'styles.css must use 100dvh for the app shell');
  assert(/minmax\(0,\s*1fr\)/.test(stylesCss), 'styles.css must use minmax(0, 1fr) for the scrollable messages row');

  // Composer reliability: central enable/disable + socket ack timeout guard.
  assert(/function syncComposerEnabled\(/.test(appJs), 'app.js must keep syncComposerEnabled to re-enable composer controls');
  assert(/function emitWithTimeout\(/.test(appJs), 'app.js must guard socket sends with an ack timeout');

  // E2EE UX: compact banner exists with the exact spec copy.
  assert(indexHtml.includes('class="e2ee-warning'), 'index.html must keep the compact e2ee banner');
  assert(appJs.includes('E2EE açık: yeni mesajlar bu sekmedeki anahtarla şifrelenir.'), 'E2EE ON banner copy must match spec');
  assert(appJs.includes('E2EE kapalı: yeni mesajlar sunucuda okunabilir.'), 'E2EE OFF banner copy must match spec');
  assert(appJs.includes('Bu mesaj şifreli. Anahtar gir.'), 'locked message copy must match spec');
  assert(/composerLock/.test(appJs), 'composer lock badge must be wired up');

  // Fresh cache/version strings so clients pull the new CSS/JS.
  for (const asset of ['styles.css?v=7.4.1', 'mobile.css?v=7.4.1', 'app.js?v=7.4.1', 'mobile.js?v=7.4.1']) {
    assert(indexHtml.includes(asset), `index.html must reference ${asset}`);
    assert(swJs.includes(asset), `sw.js must cache ${asset}`);
  }
  assert(/CACHE_NAME = 'gaycord-v7-4-1-shell'/.test(swJs), 'service worker cache name must be bumped for V7.4.1');

  // --- V7.4.1 admin boundary: global backup is App Owner (Super Admin) only ---
  assert(appJs.includes('Yedek alma yalnızca uygulama sahibine açıktır.'), 'non-owner backup note copy must match spec');
  assert(/state\.isAppOwner[\s\S]{0,60}owner-panel[\s\S]{0,600}downloadBackupButton[\s\S]{0,300}importBackupButton/.test(appJs), 'backup controls must render only in the App Owner (isAppOwner) panel');
  assert(/recordSecurityEvent\('admin_denied'/.test(serverJs), 'denied admin access attempts must be logged');
  assert(/recordSecurityEvent\('backup_export'/.test(serverJs), 'backup export must be logged');
  assert(/recordSecurityEvent\('backup_import'/.test(serverJs), 'backup import must be logged');
  assert(/\/api\/admin\/export'[\s\S]{0,120}requireAdmin/.test(serverJs), 'admin export must use requireAdmin');
  assert(/\/api\/admin\/import'[\s\S]{0,160}requireAdmin[\s\S]{0,160}rateLimit\('admin_import'/.test(serverJs), 'admin import must use requireAdmin + a rate limit');
  assert(/\/api\/admin\/security\/invalidate-sessions'[\s\S]{0,120}requireAdmin/.test(serverJs), 'invalidate-sessions must use requireAdmin');
  assert(/function normalizeImportedDb[\s\S]*?next\.sessions = \{\};/.test(serverJs), 'import must never restore active sessions');
  assert(/copy\.sessions = \{\};/.test(serverJs) && /sessions: \{\}/.test(serverJs), 'full + light export must strip sessions');

  // Mobile assets must still be referenced (V7.1 drawer/sheet preserved).
  assert(indexHtml.includes('/mobile.js'), 'index.html must reference mobile.js');
  assert(indexHtml.includes('/mobile.css'), 'index.html must reference mobile.css');

  // V7.2 voice stability must remain intact.
  assert(/\/api\/voice\/keepalive/.test(serverJs), 'voice keepalive endpoint must remain');
  assert(/voice:ping/.test(serverJs), 'server voice:ping handler must remain');
  assert(/voice:ping/.test(appJs), 'client voice keepalive ping must remain');

  // No admin localStorage backup may be reintroduced.
  assert(!/localStorage\.setItem/.test(appJs), 'app.js must not write backups to localStorage');
  assert(!/setLocalBackup\(\)\s*\{[^}]*localStorage\.setItem/.test(appJs), 'admin localStorage backup must not be reintroduced');

  // No V8 injector / social-mega artifacts anywhere in the server tree.
  for (const candidate of ['v8-injector.js', 'v8-social-extension.js', 'public/v8-injector.js', 'public/v8-social-extension.js']) {
    assert(!fs.existsSync(path.join(ROOT, candidate)), `V8 file must not exist: ${candidate}`);
  }
  const assertNoV8 = (dir) => {
    for (const entry of fs.readdirSync(dir)) {
      assert(!/(^|[-_.])v8([-_.]|$)|social-mega|injector/i.test(entry), `V8/injector artifact must not exist: ${entry}`);
    }
  };
  assertNoV8(ROOT);
  assertNoV8(path.join(ROOT, 'public'));

  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaycord-v7-security-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      GAYCORD_DATA_DIR: dataDir,
      MESSAGE_RATE_LIMIT: '2',
      MESSAGE_RATE_WINDOW_MS: '60000',
      SERVER_JOIN_RATE_LIMIT: '2',
      SERVER_JOIN_RATE_WINDOW_MS: '60000',
      MAX_E2EE_TEXT_BYTES: '256',
      MAX_E2EE_METADATA_BYTES: '1024'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    const health = await waitForHealth(baseUrl, child);
    assert.equal(health.storageMode, 'file');
    assert.equal(health.version, '7.2.0');

    const admin = await register(baseUrl, 'admin_v7');
    const created = await api(baseUrl, '/api/servers', { method: 'POST', session: admin, body: { name: 'V7 Lab' } });
    assert.equal(created.response.status, 201, JSON.stringify(created.json));
    const server = created.json.server;
    assert(/^[A-F0-9]{32,}$/.test(server.inviteCode), 'invite code must be at least 128-bit hex');
    const channel = server.channels.find((item) => item.kind === 'text');
    assert(channel, 'expected text channel');
    const voiceChannel = server.channels.find((item) => item.kind === 'voice');
    assert(voiceChannel, 'expected voice channel');

    const keepalive = await api(baseUrl, '/api/voice/keepalive', { method: 'POST', session: admin, body: { channelId: voiceChannel.id } });
    assert.equal(keepalive.response.status, 200, JSON.stringify(keepalive.json));
    assert.equal(keepalive.json.ok, true, 'voice keepalive must return ok');
    assert.equal(keepalive.json.channelId, voiceChannel.id, 'voice keepalive must echo channelId');
    assert(keepalive.json.time, 'voice keepalive must return a server time');

    const voiceSocket = connectSocketIo(baseUrl, admin);
    const joinedVoice = await voiceSocket.emit('voice:join', { channelId: voiceChannel.id });
    assert.equal(joinedVoice.ok, true, JSON.stringify(joinedVoice));
    const voicePing = await voiceSocket.emit('voice:ping', { channelId: voiceChannel.id });
    voiceSocket.close();
    assert.equal(voicePing.ok, true, JSON.stringify(voicePing));
    assert.equal(voicePing.channelId, voiceChannel.id, 'voice:ping must ack the active voice channel');

    const restWarmup = await api(baseUrl, `/api/channels/${channel.id}/messages`, {
      method: 'POST',
      session: admin,
      body: { type: 'text', text: 'REST consumes the shared message bucket' }
    });
    assert.equal(restWarmup.response.status, 201, JSON.stringify(restWarmup.json));

    const socket = connectSocketIo(baseUrl, admin);
    const secure1 = await socket.emit('message:secure', { channelId: channel.id, e2ee: smallE2eePayload('T05F') });
    const secure2 = await socket.emit('message:secure', { channelId: channel.id, e2ee: smallE2eePayload('VFdP') });
    socket.close();
    assert.equal(secure1.ok, true, JSON.stringify(secure1));
    assert(secure2.error && /hızlı|hizli|bekle/i.test(secure2.error), 'message:secure must hit the REST-shared message rate limit');

    const light = await api(baseUrl, '/api/admin/export?light=1', { session: admin });
    assert.equal(light.response.status, 200, JSON.stringify(light.json));
    assert.deepEqual(light.json.db.sessions, {}, 'light export must not contain sessions');
    assert.deepEqual(light.json.db.messages, {}, 'light export must not contain messages');
    assert.deepEqual(light.json.uploads, {}, 'light export must not contain uploads');
    for (const user of Object.values(light.json.db.users || {})) {
      assert(!('passwordHash' in user), 'light export user must not contain passwordHash');
      assert(!('passwordSalt' in user), 'light export user must not contain passwordSalt');
    }

    const member = await register(baseUrl, 'member_v7');
    const join = await api(baseUrl, '/api/servers/join', { method: 'POST', session: member, body: { inviteCode: server.inviteCode } });
    assert.equal(join.response.status, 200, JSON.stringify(join.json));

    const hugeCiphertext = 'A'.repeat(300);
    const oversized = await api(baseUrl, `/api/channels/${channel.id}/messages`, {
      method: 'POST',
      session: member,
      body: { type: 'text', encrypted: true, e2ee: smallE2eePayload(hugeCiphertext) }
    });
    assert.equal(oversized.response.status, 400, `oversized E2EE payload should be rejected: ${JSON.stringify(oversized.json)}`);

    const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
    const upload = await api(baseUrl, `/api/channels/${channel.id}/messages`, {
      method: 'POST',
      session: member,
      body: { type: 'file', fileData: png1x1, fileName: 'pixel.png', mimeType: 'image/png' }
    });
    assert.equal(upload.response.status, 201, JSON.stringify(upload.json));
    const fileUrl = upload.json.message.fileUrl;
    const anonymousUpload = await fetch(`${baseUrl}${fileUrl}`);
    assert.equal(anonymousUpload.status, 401, 'protected upload URL must reject anonymous access');
    const authorizedUpload = await fetch(`${baseUrl}${fileUrl}`, { headers: { Cookie: member.cookie } });
    assert.equal(authorizedUpload.status, 200, 'protected upload URL must allow authorized channel member');

    const nonAdminSecurity = await api(baseUrl, '/api/security/status', { session: member });
    assert.equal(nonAdminSecurity.response.status, 200, JSON.stringify(nonAdminSecurity.json));
    assert.equal(nonAdminSecurity.json.redacted, true, 'non-admin security status must be redacted');
    assert.equal(nonAdminSecurity.json.recentSecurityEvents, undefined, 'non-admin security status must not expose events');

    const full = await api(baseUrl, '/api/admin/export', { session: admin });
    assert.equal(full.response.status, 200, JSON.stringify(full.json));
    full.json.db.sessions = {
      raw_session_token_should_not_restore: {
        userId: admin.user.id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString()
      }
    };
    const imported = await api(baseUrl, '/api/admin/import', {
      method: 'POST',
      session: admin,
      body: { db: full.json.db, uploads: {} }
    });
    assert.equal(imported.response.status, 200, JSON.stringify(imported.json));
    const dbFile = path.join(dataDir, 'db.json');
    const storedDb = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    assert.deepEqual(storedDb.sessions, {}, 'import must not restore sessions');

    console.log('V7.2 security and voice checks passed');

    // --- V7.4: stale recovered room authorization (connectionStateRecovery) ---
    const serverSrc = read('server.js');
    assert(/connectionStateRecovery/.test(serverSrc), 'connectionStateRecovery must remain enabled (must not be disabled)');
    assert(/function revalidateSocketRooms\(/.test(serverSrc), 'revalidateSocketRooms helper must exist');
    assert(/revalidateSocketRooms\(socket\)/.test(serverSrc), 'revalidateSocketRooms must run on the connected socket');
    assert(/function emitToChannelSockets\([\s\S]*?canAccessChannel\(target\.user\.id, channelId\)/.test(serverSrc), 'broadcastMessage must authorize per socket via canAccessChannel');
    assert(/broadcastNative\('message:new'[\s\S]*?canAccessChannel\(ws\.user\.id, channelId\)/.test(serverSrc), 'native message:new must also respect canAccessChannel');

    const ownerA = await register(baseUrl, 'owner_v74');
    const createdA = await api(baseUrl, '/api/servers', { method: 'POST', session: ownerA, body: { name: 'V74 Social Lab' } });
    assert.equal(createdA.response.status, 201, JSON.stringify(createdA.json));
    const serverA = createdA.json.server;
    const textA = serverA.channels.find((c) => c.kind === 'text');
    const leaver = await register(baseUrl, 'leaver_v74');
    const joinedA = await api(baseUrl, '/api/servers/join', { method: 'POST', session: leaver, body: { inviteCode: serverA.inviteCode } });
    assert.equal(joinedA.response.status, 200, JSON.stringify(joinedA.json));

    const ownerSocket = connectSocketIo(baseUrl, ownerA);
    const leaverSocket = connectSocketIo(baseUrl, leaver);
    assert.equal((await ownerSocket.emit('channel:join', { channelId: textA.id })).ok, true, 'owner joins channel');
    assert.equal((await leaverSocket.emit('channel:join', { channelId: textA.id })).ok, true, 'member joins channel while still a member');

    // Member leaves the server; REST access must immediately become 403.
    const left = await api(baseUrl, `/api/servers/${serverA.id}/leave`, { method: 'POST', session: leaver, body: {} });
    assert.equal(left.response.status, 200, JSON.stringify(left.json));
    const restAfter = await api(baseUrl, `/api/channels/${textA.id}/messages`, { session: leaver });
    assert.equal(restAfter.response.status, 403, 'REST access must be 403 after leaving the server');
    // V7.4 social endpoints must also enforce channel access.
    const mediaAfter = await api(baseUrl, `/api/channels/${textA.id}/media`, { session: leaver });
    assert.equal(mediaAfter.response.status, 403, 'media gallery must be 403 for non-members');
    const pinsAfter = await api(baseUrl, `/api/channels/${textA.id}/pins`, { session: leaver });
    assert.equal(pinsAfter.response.status, 403, 'pins must be 403 for non-members');

    // Realtime delivery must also stop: owner (authorized) receives, ex-member (stale socket) does NOT.
    const ownerRecv = ownerSocket.waitForEvent('message:new', 1500);
    const leakRecv = leaverSocket.waitForEvent('message:new', 1000);
    const sent = await ownerSocket.emit('message:text', { channelId: textA.id, text: 'sadece uyeler gorur' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const ownerGot = await ownerRecv;
    assert(ownerGot && ownerGot.text === 'sadece uyeler gorur', 'authorized member must still receive message:new');
    const leak = await leakRecv;
    assert.equal(leak, null, 'a member who left must NOT receive message:new even with a stale recovered room');

    // Normal reconnect while still authorized continues to work.
    const ownerReconnect = connectSocketIo(baseUrl, ownerA);
    const rejoin = await ownerReconnect.emit('channel:join', { channelId: textA.id });
    assert.equal(rejoin.ok, true, 'authorized reconnect must still join the channel');
    assert(Array.isArray(rejoin.messages), 'reconnect join returns channel history');

    ownerSocket.close();
    leaverSocket.close();
    ownerReconnect.close();
    console.log('V7.4 stale recovered room authorization checks passed');

    // --- V7.4.1 admin boundary: global backup/export/import is App Owner only ---
    // owner_v74 owns a server but is NOT the app owner; leaver_v74 is a normal user.
    const ownerExportDenied = await api(baseUrl, '/api/admin/export', { session: ownerA });
    assert.equal(ownerExportDenied.response.status, 403, 'server owner (not app owner) must not export the global backup');
    const leaverImportDenied = await api(baseUrl, '/api/admin/import', { method: 'POST', session: leaver, body: { db: { users: { x: { id: 'x' } }, servers: {} }, uploads: {} } });
    assert.equal(leaverImportDenied.response.status, 403, 'normal user must not import a global backup');
    const ownerImportDenied = await api(baseUrl, '/api/admin/import', { method: 'POST', session: ownerA, body: { db: { users: { x: { id: 'x' } }, servers: {} }, uploads: {} } });
    assert.equal(ownerImportDenied.response.status, 403, 'server owner (not app owner) must not import a global backup');

    // Repeated non-owner export attempts must ALL return 403, but admin_denied logging must be
    // rate-limited so a non-owner cannot spam unbounded securityEvents + DB writes.
    const deniedAttempts = 9;
    for (let i = 0; i < deniedAttempts; i += 1) {
      const denied = await api(baseUrl, '/api/admin/export', { session: leaver });
      assert.equal(denied.response.status, 403, 'every non-owner export attempt must return 403');
    }

    // The app owner (admin_v7, first registered = db.adminUserId) logs back in and CAN export.
    const appOwner = await login(baseUrl, 'admin_v7');
    const appOwnerExport = await api(baseUrl, '/api/admin/export', { session: appOwner });
    assert.equal(appOwnerExport.response.status, 200, 'app owner can export the global backup');
    assert.deepEqual(appOwnerExport.json.db.sessions, {}, 'export must not contain active session tokens');
    assert(appOwnerExport.json.db.adminUserId, 'export carries the app owner id');

    // admin_denied logging for the spammed (user, path) must be capped at the 5/min log limit,
    // not one event per attempt. (securityEvents was reset by the earlier import, so the App Owner's
    // recent-events view contains all of them.)
    const securityStatus = await api(baseUrl, '/api/security/status', { session: appOwner });
    const leaverExportDenials = (securityStatus.json.recentSecurityEvents || []).filter((ev) => ev.type === 'admin_denied' && ev.details && ev.details.userId === leaver.user.id && ev.details.path === '/api/admin/export');
    assert(leaverExportDenials.length >= 1, 'at least one denied admin attempt must be logged');
    assert(leaverExportDenials.length <= 5, `admin_denied logging must be rate-limited; saw ${leaverExportDenials.length} events for ${deniedAttempts} attempts`);
    console.log('V7.4.1 admin boundary checks passed');
  } catch (error) {
    error.message += `\n\nServer output:\n${output}`;
    throw error;
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
