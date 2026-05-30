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
  for (const asset of ['styles.css?v=7.3.0', 'mobile.css?v=7.3.0', 'app.js?v=7.3.0', 'mobile.js?v=7.3.0']) {
    assert(indexHtml.includes(asset), `index.html must reference ${asset}`);
    assert(swJs.includes(asset), `sw.js must cache ${asset}`);
  }
  assert(/CACHE_NAME = 'gaycord-v7-3-shell'/.test(swJs), 'service worker cache name must be bumped for V7.3');

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
