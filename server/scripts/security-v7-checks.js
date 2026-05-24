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
    assert.equal(health.version, '7.0.0');

    const admin = await register(baseUrl, 'admin_v7');
    const created = await api(baseUrl, '/api/servers', { method: 'POST', session: admin, body: { name: 'V7 Lab' } });
    assert.equal(created.response.status, 201, JSON.stringify(created.json));
    const server = created.json.server;
    assert(/^[A-F0-9]{32,}$/.test(server.inviteCode), 'invite code must be at least 128-bit hex');
    const channel = server.channels.find((item) => item.kind === 'text');
    assert(channel, 'expected text channel');

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

    console.log('V7 security checks passed');
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
