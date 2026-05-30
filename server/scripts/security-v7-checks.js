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
  // localStorage.setItem is allowed ONLY for non-sensitive voice UI preferences (gaycord:voice-*).
  // Never tokens, E2EE passphrases, backups, or secrets.
  for (const m of appJs.matchAll(/localStorage\.setItem\(([^,]+),/g)) {
    assert(/gaycord:voice-/.test(m[1]), `localStorage.setItem only allowed for non-sensitive voice prefs (gaycord:voice-*); found: ${m[1].trim()}`);
  }
  assert(!/localStorage\.setItem\([^)]*(token|passphrase|password|backup|secret|e2ee|\bsid\b|csrf)/i.test(appJs), 'no sensitive data may be written to localStorage');
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
  for (const asset of ['styles.css?v=7.7.0', 'mobile.css?v=7.7.0', 'app.js?v=7.7.0', 'mobile.js?v=7.7.0']) {
    assert(indexHtml.includes(asset), `index.html must reference ${asset}`);
    assert(swJs.includes(asset), `sw.js must cache ${asset}`);
  }
  assert(/CACHE_NAME = 'gaycord-v7-7-shell'/.test(swJs), 'service worker cache name must be bumped for V7.7');

  // --- V7.7 voice clarity / game ducking static checks ---
  // No NEW sensitive localStorage keys: every localStorage.setItem must still be a gaycord:voice-* pref.
  for (const m of appJs.matchAll(/localStorage\.setItem\(([^,]+),/g)) {
    assert(/gaycord:voice-/.test(m[1]), `localStorage.setItem only allowed for non-sensitive voice prefs; found: ${m[1].trim()}`);
  }
  assert(!/localStorage\.setItem\([^)]*(token|passphrase|password|backup|secret|e2ee|\bsid\b|csrf|session)/i.test(appJs), 'V7.7 must not write sensitive data to localStorage');
  // Voice boost / clarity chain exists (Web Audio gain + compressor for remote voices, supports >100%).
  assert(/function buildRemoteChain\(/.test(appJs) && /createDynamicsCompressor\(/.test(appJs) && /createGain\(/.test(appJs), 'V7.7 remote voice boost/compressor chain must exist');
  assert(/voiceBoost/.test(appJs) && /gameMode/.test(appJs) && /normalizeVoices/.test(appJs), 'V7.7 voice boost / game mode / normalize prefs must exist');
  assert(/MAX_USER_VOLUME\s*=\s*250/.test(appJs), 'V7.7 per-user volume must support up to 250% via Web Audio gain');
  // Honest web fallback: the browser cannot lower other apps' audio.
  assert(appJs.includes('Diğer uygulamaların sesini kısmak Windows uygulamasında desteklenir.'), 'V7.7 web UI must state system ducking is Windows-only');
  assert(appJs.includes('Tarayıcı sürümü diğer uygulamaların sesini kısamaz. Bunun için Windows uygulamasını kullan.'), 'V7.7 web call-focus fallback text must be present');
  // Voice diagnostics with a safe copy (no secrets).
  assert(/function collectVoiceDiagnostics\(/.test(appJs) && /function copyVoiceDiagnostics\(/.test(appJs), 'V7.7 voice diagnostics + copy must exist');
  // Scope to the diagnostics function body only, so unrelated later uses of csrfToken/etc. in app.js
  // don't trigger a false positive.
  const diagBody = (appJs.match(/async function collectVoiceDiagnostics\([\s\S]*?\n\}/) || [''])[0];
  assert(diagBody && !/(document\.cookie|csrfToken|passphrase|DATABASE_URL|sessionToken|\.token\b)/i.test(diagBody), 'V7.7 diagnostics must not include secrets');
  // V7.5 device switching + stale-device fallback preserved.
  assert(/sender\.replaceTrack\(/.test(appJs) && /setSinkId/.test(appJs), 'V7.5 mic/speaker switching must remain');
  assert(/function acquireMicStream\(/.test(appJs) && /function isMissingDeviceError\(/.test(appJs), 'V7.5 stale-device mic fallback must remain');
  // V7.2 voice keepalive / ping preserved.
  assert(/voice:ping/.test(appJs) && /\/api\/voice\/keepalive/.test(serverJs), 'V7.2 voice keepalive/ping must remain');

  // --- V7.7 Windows native ducking static checks (windows-native/, C#/.NET WPF) ---
  const nativeRoot = path.join(ROOT, '..', 'windows-native');
  const nativeDuck = fs.readFileSync(path.join(nativeRoot, 'AudioDuckingService.cs'), 'utf8');
  const nativeMain = fs.readFileSync(path.join(nativeRoot, 'MainWindow.xaml.cs'), 'utf8');
  assert(/DuckOthers \{ get; set; \} = false;/.test(fs.readFileSync(path.join(nativeRoot, 'Models.cs'), 'utf8')), 'native ducking must be OFF by default');
  assert(/public void Deactivate\(/.test(nativeDuck) && /public void RecoverFromCrash\(/.test(nativeDuck), 'native ducking must expose restore + crash recovery');
  assert(/SELF_NAME_RE|gaycord/i.test(nativeDuck) && /Environment\.ProcessId/.test(nativeDuck), 'native ducking must exclude its own (Gaycord) audio session');
  // Flag ACTUAL master-volume usage (member access / master APIs), not the safety comment that
  // documents "AudioEndpointVolume is never written".
  assert(!/AudioEndpointVolume\s*\.|MasterVolumeLevelScalar|MasterVolumeLevel\b|SetMasterVolume/.test(nativeDuck), 'native ducking must not touch the system master volume');
  assert(!/(Process\.Start|ShellExecute|cmd\.exe|powershell)/i.test(nativeDuck), 'native ducking must not run arbitrary commands');
  // V7.7 P2: ducking must only LOWER — never raise an app already quieter than the duck level
  // (target = Math.Min(original, level)), and must never set the raw level unconditionally.
  assert(/Math\.Min\(original, level\)/.test(nativeDuck), 'native ducking must duck to Math.Min(original, level), never raising quiet apps');
  assert(!/simple\.Volume = level;/.test(nativeDuck), 'native ducking must not set session volume to the raw duck level unconditionally');
  // V7.7 P2: leaving a call must restore local volumes even if the network leave throws.
  assert(/_ducking\.Deactivate\(\)[\s\S]{0,120}await _rt\.LeaveVoiceAsync\(\)/.test(nativeMain), 'native leave must restore ducking before/independent of the network leave');
  assert(!/requestedExecutionLevel|requireAdministrator|highestAvailable/i.test(nativeDuck + nativeMain), 'native ducking must not require admin');
  assert(/_ducking\.Deactivate\(\)/.test(nativeMain) && /_ducking\.Dispose\(\)/.test(nativeMain), 'native app must restore volumes on leave + exit');
  assert(/_ducking\.RecoverFromCrash\(\)/.test(nativeMain), 'native app must restore volumes after a crash on next launch');

  // DB_STATE_KEY must remain the fixed V4 key (no migration break).
  assert(/DB_STATE_KEY = String\(process\.env\.DB_STATE_KEY \|\| 'gaycord_state_v4'\)/.test(serverJs), 'DB_STATE_KEY must remain unchanged');

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

  // V7.5 voice controls: new local/per-user controls + device switching present; V7.2 core preserved.
  assert(/function toggleDeafen\(/.test(appJs), 'voice deafen control must exist');
  assert(/getUserVolume|setUserVolume/.test(appJs), 'per-user volume controls must exist');
  assert(/sender\.replaceTrack\(/.test(appJs), 'mic device switching must use sender.replaceTrack (no rejoin needed)');
  assert(/setSinkId/.test(appJs), 'output device switching must use setSinkId');
  assert(appJs.includes('Tarayıcın çıkış cihazı seçimini desteklemiyor.'), 'unsupported output device must degrade gracefully with a clear message');
  assert(/function reconnectVoiceManual\(/.test(appJs) && /rejoinVoiceAfterReconnect/.test(appJs), 'manual reconnect must reuse the V7.2 reconnect path');
  assert(/localStorage\.setItem\(`gaycord:voice-volume:/.test(appJs), 'per-user volume persisted as a non-sensitive gaycord:voice- preference');
  // V7.2 reconnect stability must remain intact.
  assert(/VOICE_RECONNECT_GRACE_MS/.test(appJs) && /function startVoiceReconnectGrace\(/.test(appJs), 'V7.2 reconnect grace must remain');
  assert(/function restartPeerIce\(/.test(appJs), 'V7.2 ICE restart must remain');
  assert(/state\.voice\.manualLeave = true/.test(appJs), 'manual leave must set manualLeave (no auto-rejoin)');

  // V7.5 stale-device hardening: a stale saved mic id must never brick voice join.
  assert(appJs.includes('Sistem varsayılanı'), 'Voice Settings must include a default (system default) device option');
  assert(/function acquireMicStream\(/.test(appJs) && /function isMissingDeviceError\(/.test(appJs), 'mic acquisition must recover from a missing/overconstrained saved device');
  assert(appJs.includes('Kayıtlı mikrofon bulunamadı, sistem varsayılanı kullanılıyor.'), 'stale-device fallback must inform the user');
  assert(/function refreshVoiceDevices\(/.test(appJs) && /inputIds\.has\(p\.inputDeviceId\)/.test(appJs), 'stale saved inputDeviceId must be cleared when not enumerated');
  assert(/state\.voiceDevices\?\.enumerated && !state\.voiceDevices\.inputIds\.has\(dev\)/.test(appJs), 'applyAudioConstraints must not pin an exact deviceId that is not currently enumerated');

  // No admin localStorage backup may be reintroduced.
  assert(!/localStorage\.setItem\([^)]*['"`][^'"`]*backup/i.test(appJs), 'app.js must not write backups to localStorage');
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
      REGISTER_RATE_LIMIT: '50',
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

    // --- V7.6 roles / private channels / moderation / audit (static contract) ---
    assert(/function getServerRole\(/.test(serverSrc) && /function canModerateServer\(/.test(serverSrc), 'centralized role helpers must exist');
    assert(/function canAccessChannel\([\s\S]*?channel\.private[\s\S]*?allowedRoles/.test(serverSrc), 'canAccessChannel must enforce private channel rules (allowedRoles/allowedUserIds)');
    assert(/function broadcastServerUpdated\([\s\S]*?for \(const memberId of[\s\S]*?ensureServerView\(serverObj, memberId\)/.test(serverSrc), 'broadcastServerUpdated must emit a per-viewer server view (no all-channels leak)');
    assert(/canSeeChannelMetadata\(viewerId, channel\.id\)/.test(serverSrc), 'ensureServerView must filter channels by canSeeChannelMetadata');
    assert(/function isMemberTimedOut\(/.test(serverSrc) && /assertCanPostInChannel\(/.test(serverSrc), 'timeout write-restriction helpers must exist');
    assert(/function addAudit\(/.test(serverSrc) && /SERVER_AUDIT_LIMIT/.test(serverSrc), 'a capped per-server audit log helper must exist');
    assert(/members\/:userId\/role'[\s\S]{0,200}rateLimit\('role_update'/.test(serverSrc), 'role assignment must be rate-limited');
    assert(/channels\/:channelId\/privacy'[\s\S]{0,200}rateLimit\('channel_privacy'/.test(serverSrc), 'channel privacy changes must be rate-limited');
    assert(/members\/:userId\/kick'[\s\S]{0,200}rateLimit\('member_moderation'/.test(serverSrc), 'moderation actions must be rate-limited');
    assert(/function clearServerGrantsForUser\([\s\S]*?allowedUserIds\.filter/.test(serverSrc), 'membership removal must purge private-channel allowedUserIds grants (Fix 1)');

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

    // ===================== V7.6 roles, private channels, moderation & audit =====================
    const owner76 = await register(baseUrl, 'owner_v76');
    const created76 = await api(baseUrl, '/api/servers', { method: 'POST', session: owner76, body: { name: 'V76 Lab' } });
    assert.equal(created76.response.status, 201, JSON.stringify(created76.json));
    const server76 = created76.json.server;
    const publicText = server76.channels.find((c) => c.kind === 'text');
    assert.equal(server76.myRole, 'owner', 'server creator must have the owner role (role defaults)');

    const modUser = await register(baseUrl, 'mod_v76');
    const plainMember = await register(baseUrl, 'member_v76');
    const adminUser = await register(baseUrl, 'admin_v76');
    for (const u of [modUser, plainMember, adminUser]) {
      const j = await api(baseUrl, '/api/servers/join', { method: 'POST', session: u, body: { inviteCode: server76.inviteCode } });
      assert.equal(j.response.status, 200, `v76 join: ${JSON.stringify(j.json)}`);
    }

    // Owner can assign Admin/Mod/Member; a normal member cannot assign roles.
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${modUser.user.id}/role`, { method: 'PATCH', session: owner76, body: { role: 'mod' } })).response.status, 200, 'owner assigns mod');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${adminUser.user.id}/role`, { method: 'PATCH', session: owner76, body: { role: 'admin' } })).response.status, 200, 'owner assigns admin');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${modUser.user.id}/role`, { method: 'PATCH', session: plainMember, body: { role: 'admin' } })).response.status, 403, 'a normal member must not assign roles');

    // Admin cannot modify the owner, nor grant a role at/above their own rank.
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${owner76.user.id}/role`, { method: 'PATCH', session: adminUser, body: { role: 'member' } })).response.status, 403, 'admin must not change the owner role');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${plainMember.user.id}/role`, { method: 'PATCH', session: adminUser, body: { role: 'admin' } })).response.status, 403, 'admin must not grant a role at/above their own rank');

    // Private channel visible only to the mod (via allowedUserIds).
    const chCreate = await api(baseUrl, `/api/servers/${server76.id}/channels`, { method: 'POST', session: owner76, body: { name: 'gizli', kind: 'text' } });
    assert.equal(chCreate.response.status, 201, JSON.stringify(chCreate.json));
    const privateChannel = chCreate.json.channel;
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/channels/${privateChannel.id}/privacy`, { method: 'PATCH', session: owner76, body: { private: true, allowedRoles: [], allowedUserIds: [modUser.user.id] } })).response.status, 200, 'owner sets channel private');

    // Hidden from unauthorized member in /api/me; visible to the authorized mod.
    const memberServer = ((await api(baseUrl, '/api/me', { session: plainMember })).json.servers || []).find((s) => s.id === server76.id);
    assert(memberServer && memberServer.channels.every((c) => c.id !== privateChannel.id), 'member must NOT see the private channel in /api/me');
    const modServer = ((await api(baseUrl, '/api/me', { session: modUser })).json.servers || []).find((s) => s.id === server76.id);
    assert(modServer && modServer.channels.some((c) => c.id === privateChannel.id), 'authorized mod must see the private channel in /api/me');
    // Allow-lists are manager-only metadata: an authorized non-manager (mod) must not receive allowedUserIds.
    const modPrivateView = modServer.channels.find((c) => c.id === privateChannel.id);
    assert(modPrivateView && modPrivateView.allowedUserIds === undefined, 'non-manager (mod) must NOT receive private channel allow-lists in /api/me');
    const modPerms = await api(baseUrl, `/api/servers/${server76.id}/channels/${privateChannel.id}/permissions`, { session: modUser });
    assert.equal(modPerms.response.status, 200, 'mod with access can read basic channel permissions');
    assert.equal(modPerms.json.allowedUserIds, undefined, 'non-manager must NOT receive allow-lists from the permissions endpoint');
    const ownerPerms = await api(baseUrl, `/api/servers/${server76.id}/channels/${privateChannel.id}/permissions`, { session: owner76 });
    assert(Array.isArray(ownerPerms.json.allowedUserIds), 'a manager (owner) DOES receive allow-lists from the permissions endpoint');

    // Unauthorized member: no messages/media/pins of the private channel.
    assert.equal((await api(baseUrl, `/api/channels/${privateChannel.id}/messages`, { session: plainMember })).response.status, 403, 'private messages must be 403 for unauthorized member');
    assert.equal((await api(baseUrl, `/api/channels/${privateChannel.id}/media`, { session: plainMember })).response.status, 403, 'private media must be 403');
    assert.equal((await api(baseUrl, `/api/channels/${privateChannel.id}/pins`, { session: plainMember })).response.status, 403, 'private pins must be 403');

    // Socket: cannot join, and server:updated must not leak the private channel.
    const memberSocket76 = connectSocketIo(baseUrl, plainMember);
    assert((await memberSocket76.emit('channel:join', { channelId: privateChannel.id })).error, 'unauthorized member must not channel:join a private channel');
    const memberUpdateWait = memberSocket76.waitForEvent('server:updated', 1500);
    await api(baseUrl, `/api/servers/${server76.id}`, { method: 'PATCH', session: owner76, body: { name: 'V76 Lab!' } });
    const memberUpdate = await memberUpdateWait;
    assert(memberUpdate && memberUpdate.server, 'member receives server:updated');
    assert(memberUpdate.server.channels.every((c) => c.id !== privateChannel.id), 'server:updated must NOT leak private channel metadata to an unauthorized member');

    // Protected upload in the private channel is not fetchable by the unauthorized member.
    const modUpload = await api(baseUrl, `/api/channels/${privateChannel.id}/messages`, { method: 'POST', session: modUser, body: { type: 'file', fileData: png1x1, fileName: 'secret.png', mimeType: 'image/png' } });
    assert.equal(modUpload.response.status, 201, JSON.stringify(modUpload.json));
    const secretUrl = modUpload.json.message.fileUrl;
    assert.equal((await fetch(`${baseUrl}${secretUrl}`, { headers: { Cookie: plainMember.cookie } })).status, 403, 'unauthorized member must not fetch a private channel upload');
    assert.equal((await fetch(`${baseUrl}${secretUrl}`, { headers: { Cookie: modUser.cookie } })).status, 200, 'authorized mod can fetch the private channel upload');

    // Revoking access stops realtime delivery even on an already-joined socket.
    const modSocket76 = connectSocketIo(baseUrl, modUser);
    assert.equal((await modSocket76.emit('channel:join', { channelId: privateChannel.id })).ok, true, 'mod joins the private channel');
    const ownerSocket76 = connectSocketIo(baseUrl, owner76);
    assert.equal((await ownerSocket76.emit('channel:join', { channelId: privateChannel.id })).ok, true, 'owner joins the private channel');
    await api(baseUrl, `/api/servers/${server76.id}/channels/${privateChannel.id}/privacy`, { method: 'PATCH', session: owner76, body: { private: true, allowedRoles: [], allowedUserIds: [] } });
    const ownerGet76 = ownerSocket76.waitForEvent('message:new', 1500);
    const modLeak76 = modSocket76.waitForEvent('message:new', 1000);
    assert.equal((await ownerSocket76.emit('message:text', { channelId: privateChannel.id, text: 'sadece yetkili gorur' })).ok, true, 'owner can still post to the channel');
    assert((await ownerGet76)?.text === 'sadece yetkili gorur', 'owner (still authorized) receives the private message');
    assert.equal(await modLeak76, null, 'a member whose private access was revoked must NOT receive message:new (stale joined room)');
    memberSocket76.close(); modSocket76.close(); ownerSocket76.close();

    // Timeout: timed-out member can read but cannot send (and cannot edit/re-broadcast existing content).
    const memberMsg = await api(baseUrl, `/api/channels/${publicText.id}/messages`, { method: 'POST', session: plainMember, body: { type: 'text', text: 'merhaba' } });
    assert.equal(memberMsg.response.status, 201, JSON.stringify(memberMsg.json));
    const memberMsgId = memberMsg.json.message.id;
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${plainMember.user.id}/timeout`, { method: 'POST', session: owner76, body: { minutes: 30 } })).response.status, 200, 'owner times out a member');
    assert.equal((await api(baseUrl, `/api/channels/${publicText.id}/messages`, { session: plainMember })).response.status, 200, 'timed-out member can still read');
    assert.equal((await api(baseUrl, `/api/channels/${publicText.id}/messages`, { method: 'POST', session: plainMember, body: { type: 'text', text: 'denerim' } })).response.status, 403, 'timed-out member must not send messages');
    assert.equal((await api(baseUrl, `/api/channels/${publicText.id}/messages/${memberMsgId}`, { method: 'PATCH', session: plainMember, body: { text: 'duzenleme denemesi' } })).response.status, 403, 'timed-out member must not edit (re-broadcast) an existing message');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${plainMember.user.id}/timeout`, { method: 'DELETE', session: owner76, body: {} })).response.status, 200, 'owner removes the timeout');

    // Moderation hierarchy: a mod cannot lift a timeout the owner placed on an admin.
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${adminUser.user.id}/timeout`, { method: 'POST', session: owner76, body: { minutes: 5 } })).response.status, 200, 'owner can timeout the admin');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${adminUser.user.id}/timeout`, { method: 'DELETE', session: modUser })).response.status, 403, 'a mod must not lift a timeout placed on an admin (hierarchy)');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${adminUser.user.id}/timeout`, { method: 'DELETE', session: owner76 })).response.status, 200, 'owner can lift the admin timeout');

    // Audit log: capped + permission protected.
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/audit-log`, { session: plainMember })).response.status, 403, 'a normal member must not read the audit log');
    const auditView = await api(baseUrl, `/api/servers/${server76.id}/audit-log`, { session: owner76 });
    assert.equal(auditView.response.status, 200, JSON.stringify(auditView.json));
    assert(Array.isArray(auditView.json.auditLog) && auditView.json.auditLog.some((e) => e.type === 'role_updated'), 'audit log records V7.6 admin actions');

    // Fix 2 (Codex P2): a Mod has backend authority for a LIMITED Members tab — list members and
    // kick/timeout Members only; cannot change roles, cannot ban, cannot act on Admin/Owner/Mod.
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members`, { session: modUser })).response.status, 200, 'a mod can list members (data behind the Members tab)');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${plainMember.user.id}/role`, { method: 'PATCH', session: modUser, body: { role: 'mod' } })).response.status, 403, 'a mod cannot change roles');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${plainMember.user.id}/ban`, { method: 'POST', session: modUser, body: {} })).response.status, 403, 'a mod cannot ban');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${adminUser.user.id}/kick`, { method: 'POST', session: modUser, body: {} })).response.status, 403, 'a mod cannot kick an admin (hierarchy)');
    const modTimeout = await api(baseUrl, `/api/servers/${server76.id}/members/${plainMember.user.id}/timeout`, { method: 'POST', session: modUser, body: { minutes: 5 } });
    assert.equal(modTimeout.response.status, 200, 'a mod can timeout a member');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${plainMember.user.id}/timeout`, { method: 'DELETE', session: modUser })).response.status, 200, 'a mod can lift a timeout it can apply (member)');

    // Fix 1 (Codex P2): removing a member purges private-channel grants, so rejoining does NOT
    // regain explicit allowedUserIds access without re-approval.
    const regrant = await register(baseUrl, 'regrant_v76');
    assert.equal((await api(baseUrl, '/api/servers/join', { method: 'POST', session: regrant, body: { inviteCode: server76.inviteCode } })).response.status, 200, 'regrant user joins');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/channels/${privateChannel.id}/privacy`, { method: 'PATCH', session: owner76, body: { private: true, allowedRoles: [], allowedUserIds: [regrant.user.id] } })).response.status, 200, 'owner grants regrant user explicit private access');
    let rgMe = ((await api(baseUrl, '/api/me', { session: regrant })).json.servers || []).find((s) => s.id === server76.id);
    assert(rgMe && rgMe.channels.some((c) => c.id === privateChannel.id), 'granted user sees the private channel before removal');
    assert.equal((await api(baseUrl, `/api/channels/${privateChannel.id}/messages`, { session: regrant })).response.status, 200, 'granted user can read the private channel before removal');
    // A socket joined before the kick must stop receiving after the kick.
    const rgSock = connectSocketIo(baseUrl, regrant);
    assert.equal((await rgSock.emit('channel:join', { channelId: privateChannel.id })).ok, true, 'granted user joins the private channel room');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${regrant.user.id}/kick`, { method: 'POST', session: owner76, body: {} })).response.status, 200, 'owner kicks the granted user');
    const rgOwnerSock = connectSocketIo(baseUrl, owner76);
    await rgOwnerSock.emit('channel:join', { channelId: privateChannel.id });
    const rgLeak = rgSock.waitForEvent('message:new', 1000);
    await rgOwnerSock.emit('message:text', { channelId: privateChannel.id, text: 'kick sonrasi gizli' });
    assert.equal(await rgLeak, null, 'kicked user stale socket must NOT receive private message:new');
    rgSock.close(); rgOwnerSock.close();
    // Rejoin via a valid invite must NOT restore the stale grant.
    assert.equal((await api(baseUrl, '/api/servers/join', { method: 'POST', session: regrant, body: { inviteCode: server76.inviteCode } })).response.status, 200, 'kicked user rejoins via valid invite');
    rgMe = ((await api(baseUrl, '/api/me', { session: regrant })).json.servers || []).find((s) => s.id === server76.id);
    assert(rgMe && rgMe.channels.every((c) => c.id !== privateChannel.id), 'rejoined user must NOT see the private channel (stale allowedUserIds purged)');
    assert.equal((await api(baseUrl, `/api/channels/${privateChannel.id}/messages`, { session: regrant })).response.status, 403, 'rejoined user must get 403 on private channel messages');
    assert.equal((await api(baseUrl, `/api/channels/${privateChannel.id}/media`, { session: regrant })).response.status, 403, 'rejoined user must get 403 on private channel media');
    assert.equal((await api(baseUrl, `/api/channels/${privateChannel.id}/pins`, { session: regrant })).response.status, 403, 'rejoined user must get 403 on private channel pins');
    const rgUpdSock = connectSocketIo(baseUrl, regrant);
    await rgUpdSock.emit('channel:join', { channelId: publicText.id }); // await an emit first so the socket is fully connected before we wait for the broadcast
    const rgUpd = rgUpdSock.waitForEvent('server:updated', 2000);
    await api(baseUrl, `/api/servers/${server76.id}`, { method: 'PATCH', session: owner76, body: { name: 'V76 Lab regrant' } });
    const rgUpdData = await rgUpd;
    assert(rgUpdData && rgUpdData.server && rgUpdData.server.channels.every((c) => c.id !== privateChannel.id), 'server:updated must NOT leak the private channel to a rejoined non-granted user');
    rgUpdSock.close();
    const ownerPermsAfterKick = await api(baseUrl, `/api/servers/${server76.id}/channels/${privateChannel.id}/permissions`, { session: owner76 });
    assert(Array.isArray(ownerPermsAfterKick.json.allowedUserIds) && !ownerPermsAfterKick.json.allowedUserIds.includes(regrant.user.id), 'kicked user must be removed from allowedUserIds');

    // Kick: removes membership, stops realtime, blocks REST.
    const kickSocket = connectSocketIo(baseUrl, plainMember);
    assert.equal((await kickSocket.emit('channel:join', { channelId: publicText.id })).ok, true, 'member joins a public channel before being kicked');
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${plainMember.user.id}/kick`, { method: 'POST', session: owner76, body: {} })).response.status, 200, 'owner kicks the member');
    assert.equal((await api(baseUrl, `/api/channels/${publicText.id}/messages`, { session: plainMember })).response.status, 403, 'kicked member loses REST access');
    const kickLeak = kickSocket.waitForEvent('message:new', 1000);
    await api(baseUrl, `/api/channels/${publicText.id}/messages`, { method: 'POST', session: owner76, body: { type: 'text', text: 'kick sonrasi' } });
    assert.equal(await kickLeak, null, 'a kicked member must not receive realtime messages');
    kickSocket.close();

    // Ban: banned user cannot rejoin.
    assert.equal((await api(baseUrl, `/api/servers/${server76.id}/members/${adminUser.user.id}/ban`, { method: 'POST', session: owner76, body: { reason: 'test' } })).response.status, 200, 'owner bans the admin');
    assert.equal((await api(baseUrl, '/api/servers/join', { method: 'POST', session: adminUser, body: { inviteCode: server76.inviteCode } })).response.status, 403, 'a banned user must not rejoin');

    console.log('V7.6 roles, private channels, moderation & audit checks passed');
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
