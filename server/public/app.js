const $ = (id) => document.getElementById(id);

const els = {
  auth: $('auth'), app: $('app'), loginTab: $('loginTab'), registerTab: $('registerTab'), authForm: $('authForm'),
  displayNameWrap: $('displayNameWrap'), displayNameInput: $('displayNameInput'), usernameInput: $('usernameInput'), passwordInput: $('passwordInput'), authSubmit: $('authSubmit'),
  homeButton: $('homeButton'), serverDots: $('serverDots'), createServerButton: $('createServerButton'), joinServerButton: $('joinServerButton'),
  sidebarMode: $('sidebarMode'), sidebarTitle: $('sidebarTitle'), connectionState: $('connectionState'), dynamicPanel: $('dynamicPanel'),
  meAvatar: $('meAvatar'), meName: $('meName'), meUsername: $('meUsername'), settingsButton: $('settingsButton'), logoutButton: $('logoutButton'),
  chatKicker: $('chatKicker'), chatTitle: $('chatTitle'), chatSubtitle: $('chatSubtitle'), e2eeButton: $('e2eeButton'), e2eeWarning: $('e2eeWarning'), copyInviteButton: $('copyInviteButton'), voicePanel: $('voicePanel'),
  messages: $('messages'), typingLine: $('typingLine'), messageForm: $('messageForm'), fileButton: $('fileButton'), fileInput: $('fileInput'), recordButton: $('recordButton'), messageInput: $('messageInput'), sendButton: $('sendButton'), composerLock: $('composerLock'),
  membersTitle: $('membersTitle'), membersList: $('membersList'), settingsModal: $('settingsModal'), settingsContent: $('settingsContent'), remoteAudio: $('remoteAudio'), toast: $('toast'),
  publicDataStatus: $('publicDataStatus'), bootstrapRestoreWrap: $('bootstrapRestoreWrap'), restoreLocalBackupButton: $('restoreLocalBackupButton'), restoreBackupFileButton: $('restoreBackupFileButton'), bootstrapFileInput: $('bootstrapFileInput'),
  notificationsButton: $('notificationsButton'), notifBadge: $('notifBadge'), savedButton: $('savedButton'), pinsButton: $('pinsButton'), mediaButton: $('mediaButton'), replyBar: $('replyBar'), replyBarText: $('replyBarText'), replyCancelButton: $('replyCancelButton')
};

const state = {
  authMode: 'login',
  user: null,
  csrfToken: '',
  isAppOwner: false,
  settings: { theme: 'dark', compactMode: false, reduceMotion: false },
  dataStatus: null,
  friends: { friends: [], incomingRequests: [], outgoingRequests: [] },
  servers: [],
  onlineIds: new Set(),
  socket: null,
  view: 'home',
  currentServerId: null,
  currentChannelId: null,
  currentChannel: null,
  currentInviteCode: '',
  currentDmFriend: null,
  typingTimeout: null,
  remoteTypingTimeout: null,
  recorder: null,
  recordStream: null,
  recordChunks: [],
  recordStartedAt: 0,
  recordChannelId: '',
  recordMaxTimer: null,
  sendingFile: false,
  sendInFlight: false,
  voice: { channelId: null, stream: null, peers: new Map(), participants: new Map(), muted: false, selfId: null, keepaliveTimer: null, reconnectGraceTimer: null, reconnecting: false, manualLeave: false, peerRestartTimers: new Map() },
  publicStatus: null,
  autoBackupTimer: null,
  replyTo: null,
  notify: { unread: {}, total: 0, items: [], friendRequests: 0 },
  voicePrefs: null,
  voiceDevices: { inputIds: new Set(), outputIds: new Set(), enumerated: false },
  e2ee: { passphrases: new Map(), enabled: new Set(), objectUrls: new Map() }
};
const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🔥', '👀', '✅', '🙏'];

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
const VOICE_KEEPALIVE_MS = 27000;
const VOICE_RECONNECT_GRACE_MS = 90000;
const VOICE_ICE_RESTART_DELAY_MS = 5000;
const VOICE_SPEAKING_THRESHOLD = 14; // 0-255 average frequency energy above which a stream is "speaking"

/* ===================== V7.5 Voice Controls (client-only; non-sensitive UI prefs) ===================== */
const voicePrefsDefault = { inputDeviceId: '', outputDeviceId: '', echoCancellation: true, noiseSuppression: true, autoGainControl: true, inputGain: 100 };
function loadVoicePrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem('gaycord:voice-prefs') || '{}') || {};
    return {
      inputDeviceId: typeof parsed.inputDeviceId === 'string' ? parsed.inputDeviceId : '',
      outputDeviceId: typeof parsed.outputDeviceId === 'string' ? parsed.outputDeviceId : '',
      echoCancellation: parsed.echoCancellation !== false,
      noiseSuppression: parsed.noiseSuppression !== false,
      autoGainControl: parsed.autoGainControl !== false,
      inputGain: Math.min(200, Math.max(0, Number(parsed.inputGain ?? 100) || 0))
    };
  } catch { return { ...voicePrefsDefault }; }
}
function saveVoicePrefs() {
  // Only non-sensitive voice UI preferences are persisted. Never tokens/E2EE keys/secrets.
  try { localStorage.setItem('gaycord:voice-prefs', JSON.stringify(state.voicePrefs || voicePrefsDefault)); } catch {}
}
function getUserVolume(userId) {
  if (!userId) return 100;
  try { const v = localStorage.getItem(`gaycord:voice-volume:${userId}`); return v == null ? 100 : Math.min(100, Math.max(0, Number(v) || 0)); } catch { return 100; }
}
function setUserVolume(userId, vol) {
  if (!userId) return;
  try { localStorage.setItem(`gaycord:voice-volume:${userId}`, String(Math.min(100, Math.max(0, Math.round(vol))))); } catch {}
}
function applyAudioConstraints(deviceId) {
  const p = state.voicePrefs || voicePrefsDefault;
  const audio = { echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.autoGainControl };
  let dev = deviceId !== undefined ? deviceId : p.inputDeviceId;
  // Only pin to an exact device once we've reliably confirmed it still exists, so a stale saved
  // microphone id can never produce an OverconstrainedError. Otherwise request the system default.
  if (dev && state.voiceDevices?.enumerated && !state.voiceDevices.inputIds.has(dev)) dev = '';
  if (dev) audio.deviceId = { exact: dev };
  return audio;
}
function isMissingDeviceError(err) {
  return ['NotFoundError', 'OverconstrainedError', 'NotReadableError', 'DevicesNotFoundError'].includes(err?.name || '');
}
// Acquire the mic with the saved device, recovering once to the system default if that device is
// missing/overconstrained — a stale saved id must never brick voice join.
async function acquireMicStream(deviceId) {
  const wantId = deviceId !== undefined ? deviceId : (state.voicePrefs?.inputDeviceId || '');
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: applyAudioConstraints(wantId) });
  } catch (err) {
    if (wantId && isMissingDeviceError(err)) {
      if (state.voicePrefs) { state.voicePrefs.inputDeviceId = ''; saveVoicePrefs(); }
      toast('Kayıtlı mikrofon bulunamadı, sistem varsayılanı kullanılıyor.');
      return await navigator.mediaDevices.getUserMedia({ audio: applyAudioConstraints('') });
    }
    throw err;
  }
}
// Enumerate audio devices, cache real ids, and drop saved device prefs that no longer exist.
async function refreshVoiceDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    const inputIds = new Set(inputs.map((d) => d.deviceId).filter(Boolean));
    const outputIds = new Set(outputs.map((d) => d.deviceId).filter(Boolean));
    const reliable = inputIds.size > 0; // real ids => permission granted => enumeration is trustworthy
    state.voiceDevices = { inputIds, outputIds, enumerated: reliable };
    if (reliable) {
      const p = state.voicePrefs || (state.voicePrefs = loadVoicePrefs());
      let changed = false;
      if (p.inputDeviceId && !inputIds.has(p.inputDeviceId)) { p.inputDeviceId = ''; changed = true; }
      if (p.outputDeviceId && outputIds.size > 0 && !outputIds.has(p.outputDeviceId)) { p.outputDeviceId = ''; changed = true; }
      if (changed) saveVoicePrefs();
    }
    return { inputs, outputs };
  } catch { return { inputs: [], outputs: [] }; }
}
function setSinkIdSupported() { return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype; }
function ensureVoiceAudioCtx() {
  if (state.voice.audioCtx) return state.voice.audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try { state.voice.audioCtx = new Ctx(); } catch { return null; }
  return state.voice.audioCtx;
}
// Outgoing track: raw mic track by default (V7.2 behavior, zero risk). Only when gain != 100% do we
// route through a Web Audio GainNode and send the processed track, with a safe fallback to raw.
function teardownGain() {
  try { state.voice.gainSource?.disconnect(); } catch {}
  try { state.voice.gainNode?.disconnect(); } catch {}
  state.voice.gainDest?.stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
  state.voice.gainSource = null; state.voice.gainNode = null; state.voice.gainDest = null;
}
function buildSendTrack() {
  const raw = state.voice.stream?.getAudioTracks()[0] || null;
  const gainValue = state.voicePrefs?.inputGain ?? 100;
  if (gainValue === 100 || !raw) { teardownGain(); return raw; }
  const ctx = ensureVoiceAudioCtx();
  if (!ctx) { toast('Mikrofon kazancı bu tarayıcıda uygulanamadı.'); return raw; }
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    teardownGain();
    const source = ctx.createMediaStreamSource(state.voice.stream);
    const gain = ctx.createGain(); gain.gain.value = gainValue / 100;
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain); gain.connect(dest);
    state.voice.gainSource = source; state.voice.gainNode = gain; state.voice.gainDest = dest;
    return dest.stream.getAudioTracks()[0] || raw;
  } catch (e) { console.warn('gain pipeline failed', e); toast('Mikrofon kazancı uygulanamadı; ham mikrofon kullanılıyor.'); return raw; }
}
function applyMicEnabled() {
  const enabled = !state.voice.muted;
  if (state.voice.sendTrack) state.voice.sendTrack.enabled = enabled;
  state.voice.stream?.getAudioTracks().forEach((t) => { t.enabled = enabled; });
}
function applySendTrack(track) {
  if (!track) return;
  const prev = state.voice.sendTrack;
  state.voice.sendTrack = track;
  applyMicEnabled();
  for (const pc of state.voice.peers.values()) {
    const sender = pc.getSenders?.().find((s) => s.track && s.track.kind === 'audio') || pc.getSenders?.()[0];
    if (sender) sender.replaceTrack(track).catch((e) => console.warn('replaceTrack failed', e));
  }
  const rawTrack = state.voice.stream?.getAudioTracks()[0];
  if (prev && prev !== track && prev !== rawTrack) { try { prev.stop(); } catch {} }
}
async function changeMicDevice(deviceId) {
  if (state.voicePrefs) { state.voicePrefs.inputDeviceId = deviceId || ''; saveVoicePrefs(); }
  if (!state.voice.channelId) return;
  try {
    const newStream = await acquireMicStream(deviceId);
    const oldStream = state.voice.stream;
    state.voice.stream = newStream;
    const track = buildSendTrack();
    applySendTrack(track);
    attachAnalyser('self', newStream);
    oldStream?.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    toast('Mikrofon güncellendi.');
  } catch (e) { toast('Mikrofon değiştirilemedi: ' + (e?.message || 'izin reddedildi')); }
}
async function changeOutputDevice(deviceId) {
  if (state.voicePrefs) { state.voicePrefs.outputDeviceId = deviceId || ''; saveVoicePrefs(); }
  if (!setSinkIdSupported()) { toast('Tarayıcın çıkış cihazı seçimini desteklemiyor.'); return; }
  for (const audio of els.remoteAudio.querySelectorAll('audio')) { try { await audio.setSinkId(deviceId); } catch (e) { console.warn('setSinkId failed', e); } }
}
function setInputGain(value) {
  if (!state.voicePrefs) return;
  state.voicePrefs.inputGain = Math.min(200, Math.max(0, Math.round(value || 0))); saveVoicePrefs();
  if (!state.voice.channelId) return;
  if (state.voice.gainNode && state.voicePrefs.inputGain !== 100) { state.voice.gainNode.gain.value = state.voicePrefs.inputGain / 100; return; }
  applySendTrack(buildSendTrack());
}
async function setAudioToggle(key, value) {
  if (!state.voicePrefs) return;
  state.voicePrefs[key] = Boolean(value); saveVoicePrefs();
  if (state.voice.channelId) await changeMicDevice(state.voicePrefs.inputDeviceId);
}
function configureRemoteAudio(audio, participant) {
  const userId = participant?.user?.id;
  audio.volume = Math.min(1, getUserVolume(userId) / 100);
  const locallyMuted = userId && state.voice.localMuted?.has(userId);
  audio.muted = Boolean(state.voice.deafened || locallyMuted);
  if (state.voicePrefs?.outputDeviceId && setSinkIdSupported()) audio.setSinkId(state.voicePrefs.outputDeviceId).catch(() => {});
}
function setRemoteVolume(socketId, vol) {
  const userId = state.voice.participants.get(socketId)?.user?.id;
  setUserVolume(userId, vol);
  const audio = document.getElementById(`remote-${socketId}`);
  if (audio) audio.volume = Math.min(1, vol / 100);
}
function toggleLocalMuteUser(socketId) {
  const userId = state.voice.participants.get(socketId)?.user?.id;
  if (!userId) return;
  state.voice.localMuted ||= new Set();
  if (state.voice.localMuted.has(userId)) state.voice.localMuted.delete(userId); else state.voice.localMuted.add(userId);
  const audio = document.getElementById(`remote-${socketId}`);
  if (audio) audio.muted = Boolean(state.voice.deafened || state.voice.localMuted.has(userId));
  renderVoicePanel();
}
function toggleDeafen() {
  if (!state.voice.channelId) return;
  state.voice.deafened = !state.voice.deafened;
  if (state.voice.deafened) { state.voice.preDeafenMuted = state.voice.muted; state.voice.muted = true; }
  else { state.voice.muted = Boolean(state.voice.preDeafenMuted); }
  applyMicEnabled();
  for (const audio of els.remoteAudio.querySelectorAll('audio')) {
    const uid = state.voice.participants.get(audio.id.replace('remote-', ''))?.user?.id;
    audio.muted = Boolean(state.voice.deafened || (uid && state.voice.localMuted?.has(uid)));
  }
  renderVoicePanel();
}
async function reconnectVoiceManual() {
  if (!state.voice.channelId || !state.voice.stream) return;
  if (!state.socket?.connected) return toast('Önce sunucu bağlantısı kurulmalı.');
  toast('Ses yeniden bağlanıyor…');
  await rejoinVoiceAfterReconnect();
}
function attachAnalyser(key, stream) {
  const ctx = ensureVoiceAudioCtx();
  if (!ctx || !stream) return;
  detachAnalyser(key);
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser); // read-only tap, not connected to destination (no feedback)
    state.voice.analysers.set(key, { source, analyser, data: new Uint8Array(analyser.frequencyBinCount) });
    startSpeakingLoop();
  } catch (e) { console.warn('analyser attach failed', e); }
}
function detachAnalyser(key) {
  const a = state.voice.analysers?.get(key);
  if (a) { try { a.source.disconnect(); } catch {} state.voice.analysers.delete(key); }
}
function startSpeakingLoop() {
  if (state.voice.speakingRaf || typeof requestAnimationFrame !== 'function') return;
  let last = 0;
  const tick = (ts) => {
    if (!state.voice.channelId) { state.voice.speakingRaf = null; return; }
    state.voice.speakingRaf = requestAnimationFrame(tick);
    if (ts - last < 90) return; // ~11 fps
    last = ts;
    for (const [key, a] of state.voice.analysers) {
      a.analyser.getByteFrequencyData(a.data);
      let sum = 0; for (let i = 0; i < a.data.length; i += 1) sum += a.data[i];
      const avg = sum / a.data.length;
      const speaking = avg > VOICE_SPEAKING_THRESHOLD && (key !== 'self' || (!state.voice.muted && !state.voice.deafened));
      const el = key === 'self' ? els.voicePanel.querySelector('.voice-self-chip') : els.voicePanel.querySelector(`[data-voice-peer="${CSS.escape(key)}"]`);
      if (el) el.classList.toggle('speaking', speaking);
    }
  };
  state.voice.speakingRaf = requestAnimationFrame(tick);
}
function stopSpeakingLoop() {
  if (state.voice.speakingRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.voice.speakingRaf);
  state.voice.speakingRaf = null;
}
async function openVoiceSettings() {
  openDrawer('voice', '🎧 Ses ayarları', async (body) => {
    body.innerHTML = '<div class="empty-state compact">Cihazlar yükleniyor…</div>';
    const { inputs: mics, outputs: speakers } = await refreshVoiceDevices(); // also clears stale saved device ids
    const p = state.voicePrefs || (state.voicePrefs = loadVoicePrefs());
    const micDefault = `<option value=""${!p.inputDeviceId ? ' selected' : ''}>Sistem varsayılanı</option>`;
    const micOptions = mics.map((d, i) => `<option value="${escapeHTML(d.deviceId)}"${d.deviceId && d.deviceId === p.inputDeviceId ? ' selected' : ''}>${escapeHTML(d.label || ('Mikrofon ' + (i + 1)))}</option>`).join('');
    const spkSupported = setSinkIdSupported();
    const spkDefault = `<option value=""${!p.outputDeviceId ? ' selected' : ''}>Sistem varsayılanı</option>`;
    const spkOptions = speakers.map((d, i) => `<option value="${escapeHTML(d.deviceId)}"${d.deviceId && d.deviceId === p.outputDeviceId ? ' selected' : ''}>${escapeHTML(d.label || ('Hoparlör ' + (i + 1)))}</option>`).join('');
    body.innerHTML = `
      <div class="settings-section"><h3>Mikrofon</h3>
        <label>Giriş cihazı<select id="voiceMicSelect">${micDefault}${micOptions}</select></label>
        <label>Kazanç: <span id="voiceGainVal">${p.inputGain}%</span><input id="voiceGain" type="range" min="0" max="200" value="${p.inputGain}"></label>
        <label class="toggle-row"><input id="voiceEC" type="checkbox"${p.echoCancellation ? ' checked' : ''}> Yankı engelleme</label>
        <label class="toggle-row"><input id="voiceNS" type="checkbox"${p.noiseSuppression ? ' checked' : ''}> Gürültü bastırma</label>
        <label class="toggle-row"><input id="voiceAGC" type="checkbox"${p.autoGainControl ? ' checked' : ''}> Otomatik kazanç</label>
        <div class="voice-meter"><div id="voiceMeterBar" class="voice-meter-bar"></div></div>
        <button id="voiceMicTest" class="ghost" type="button">Mikrofonu test et</button>
      </div>
      <div class="settings-section"><h3>Hoparlör / çıkış</h3>
        ${spkSupported ? `<label>Çıkış cihazı<select id="voiceSpkSelect">${spkDefault}${spkOptions}</select></label>` : '<p>Tarayıcın çıkış cihazı seçimini desteklemiyor.</p>'}
      </div>`;
    $('voiceMicSelect')?.addEventListener('change', (e) => changeMicDevice(e.target.value));
    $('voiceGain')?.addEventListener('input', (e) => { const el = $('voiceGainVal'); if (el) el.textContent = e.target.value + '%'; });
    $('voiceGain')?.addEventListener('change', (e) => setInputGain(Number(e.target.value)));
    $('voiceEC')?.addEventListener('change', (e) => setAudioToggle('echoCancellation', e.target.checked));
    $('voiceNS')?.addEventListener('change', (e) => setAudioToggle('noiseSuppression', e.target.checked));
    $('voiceAGC')?.addEventListener('change', (e) => setAudioToggle('autoGainControl', e.target.checked));
    if (spkSupported) $('voiceSpkSelect')?.addEventListener('change', (e) => changeOutputDevice(e.target.value));
    $('voiceMicTest')?.addEventListener('click', () => testMicrophone($('voiceMeterBar')));
  });
}
async function testMicrophone(barEl) {
  let stream = null; let ownStream = false; let ctx = null;
  try {
    if (state.voice.channelId && state.voice.stream) { stream = state.voice.stream; }
    else { stream = await acquireMicStream(); ownStream = true; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { toast('Tarayıcı ses ölçümünü desteklemiyor.'); if (ownStream) stream.getTracks().forEach((t) => t.stop()); return; }
    ctx = new Ctx();
    const source = ctx.createMediaStreamSource(stream); const analyser = ctx.createAnalyser(); analyser.fftSize = 256; source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount); let frames = 0;
    const loop = () => {
      if (frames++ > 260 || !barEl || !barEl.isConnected) { try { source.disconnect(); } catch {} ctx.close().catch(() => {}); if (ownStream) stream.getTracks().forEach((t) => t.stop()); if (barEl && barEl.isConnected) barEl.style.width = '0%'; return; }
      analyser.getByteFrequencyData(data); let sum = 0; for (let i = 0; i < data.length; i += 1) sum += data[i];
      if (barEl) barEl.style.width = Math.min(100, Math.round((sum / data.length) / 1.4)) + '%';
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } catch { toast('Mikrofon test edilemedi: izin reddedildi.'); if (ownStream && stream) stream.getTracks().forEach((t) => t.stop()); if (ctx) ctx.close().catch(() => {}); }
}

function toast(message) {
  els.toast.textContent = String(message || '');
  els.toast.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.add('hidden'), 3600);
}
function escapeHTML(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || '?';
}
function formatTime(iso) {
  try { return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch { return ''; }
}
function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10000 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function absoluteUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url, location.origin).href;
}
// Only accept server-generated upload-style URLs; rejects anything with quotes/parens/whitespace so a
// value can never break out of an HTML attribute or a CSS url('...') context (defense-in-depth).
function safeMediaUrl(url) {
  const u = absoluteUrl(url);
  return /^(https?:\/\/|\/)[^"'()\s<>]*$/.test(u) ? u : '';
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function autoGrowInput() {
  if (!els.messageInput || els.messageInput.tagName !== 'TEXTAREA') return;
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = `${Math.min(132, els.messageInput.scrollHeight)}px`;
}
async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = options.body ? { 'Content-Type': 'application/json' } : {};
  if (options.body && state.csrfToken) headers['x-gaycord-csrf'] = state.csrfToken;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: Object.keys(headers).length ? headers : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'İstek başarısız oldu.');
  return data;
}

const E2EE_ITERATIONS = 250000;
const E2EE_ENCODER = new TextEncoder();
const E2EE_DECODER = new TextDecoder();
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
function dataUrlFromBytes(mimeType, bytes) { return `data:${mimeType || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`; }
function base64ToBytes(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function deriveE2eeKey(passphrase, salt) {
  const keyMaterial = await crypto.subtle.importKey('raw', E2EE_ENCODER.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: E2EE_ITERATIONS }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function e2eeChannelKey(channelId = state.currentChannelId) { return String(channelId || ''); }
function e2eeEnabled(channelId = state.currentChannelId) { return Boolean(channelId && state.e2ee.enabled.has(e2eeChannelKey(channelId)) && state.e2ee.passphrases.has(e2eeChannelKey(channelId))); }
function e2eeIntended(channelId = state.currentChannelId) { return Boolean(channelId && state.e2ee.enabled.has(e2eeChannelKey(channelId))); }
function requireE2eeKeyOrPrompt(channelId) {
  if (!e2eeIntended(channelId) || e2eePassphrase(channelId)) return true;
  toast('E2EE açık ama bu sekmede anahtar yok. Mesaj göndermek için anahtar gir.');
  promptE2eeKey();
  return false;
}
function e2eePassphrase(channelId = state.currentChannelId) { return state.e2ee.passphrases.get(e2eeChannelKey(channelId)) || ''; }
function setE2eePassphrase(channelId, passphrase, enabled = true) {
  const key = e2eeChannelKey(channelId);
  if (!key) return;
  if (!passphrase) { state.e2ee.passphrases.delete(key); state.e2ee.enabled.delete(key); }
  else { state.e2ee.passphrases.set(key, passphrase); if (enabled) state.e2ee.enabled.add(key); }
  renderE2eeButton();
  decryptVisibleMessages();
}
async function encryptPayload(channelId, payload) {
  if (!crypto.subtle) throw new Error('Tarayıcı Web Crypto desteklemiyor.');
  const passphrase = e2eePassphrase(channelId);
  if (!passphrase) throw new Error('Bu kanal için E2EE anahtarı yok.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveE2eeKey(passphrase, salt);
  const plaintext = E2EE_ENCODER.encode(JSON.stringify(payload));
  const aad = E2EE_ENCODER.encode(`gaycord-v6:${channelId}`);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext));
  return { v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iterations: E2EE_ITERATIONS, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) };
}
async function decryptPayload(channelId, e2ee) {
  const passphrase = e2eePassphrase(channelId);
  if (!passphrase) throw new Error('Anahtar yok');
  const salt = base64ToBytes(e2ee.salt); const iv = base64ToBytes(e2ee.iv); const ciphertext = base64ToBytes(e2ee.ciphertext);
  const key = await deriveE2eeKey(passphrase, salt);
  const aad = E2EE_ENCODER.encode(`gaycord-v6:${channelId}`);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext);
  return JSON.parse(E2EE_DECODER.decode(plaintext));
}
function attachmentAad(channelId, part) { return E2EE_ENCODER.encode(`gaycord-v6.1:${channelId}:attachment:${part}`); }
async function encryptAttachmentForUpload(channelId, blob, meta = {}) {
  if (!crypto.subtle) throw new Error('Tarayıcı Web Crypto desteklemiyor.');
  const passphrase = e2eePassphrase(channelId);
  if (!passphrase) throw new Error('Bu kanal için E2EE anahtarı yok.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const metaIv = crypto.getRandomValues(new Uint8Array(12));
  const fileIv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveE2eeKey(passphrase, salt);
  const metadata = E2EE_ENCODER.encode(JSON.stringify(meta));
  const encryptedMeta = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: metaIv, additionalData: attachmentAad(channelId, 'meta') }, key, metadata));
  const encryptedFile = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fileIv, additionalData: attachmentAad(channelId, 'file') }, key, await blob.arrayBuffer()));
  return {
    fileData: dataUrlFromBytes('application/octet-stream', encryptedFile),
    e2ee: { v: 2, mode: 'attachment', alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iterations: E2EE_ITERATIONS, salt: bytesToBase64(salt), iv: bytesToBase64(metaIv), fileIv: bytesToBase64(fileIv), ciphertext: bytesToBase64(encryptedMeta) }
  };
}
async function decryptAttachmentPayload(message) {
  const passphrase = e2eePassphrase(message.channelId);
  if (!passphrase) throw new Error('Anahtar yok');
  const e2ee = message.e2ee || {};
  const key = await deriveE2eeKey(passphrase, base64ToBytes(e2ee.salt));
  const metaBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(e2ee.iv), additionalData: attachmentAad(message.channelId, 'meta') }, key, base64ToBytes(e2ee.ciphertext));
  const meta = JSON.parse(E2EE_DECODER.decode(metaBytes));
  const url = message.fileUrl || message.audioUrl;
  if (!url) throw new Error('Şifreli dosya yolu yok');
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Şifreli dosya alınamadı');
  const encryptedBytes = new Uint8Array(await response.arrayBuffer());
  const clearBytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(e2ee.fileIv), additionalData: attachmentAad(message.channelId, 'file') }, key, encryptedBytes));
  const mimeType = meta.mimeType || (meta.kind === 'voice' ? 'audio/wav' : 'application/octet-stream');
  return { ...meta, fileData: dataUrlFromBytes(mimeType, clearBytes), audioData: dataUrlFromBytes(mimeType, clearBytes), mimeType, sizeBytes: clearBytes.length };
}
function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl || '').split(',');
  const mime = (head.match(/^data:([^;]+)/) || [])[1] || 'application/octet-stream';
  return new Blob([base64ToBytes(body || '')], { type: mime });
}
function objectUrlForMessage(messageId, dataUrl) {
  const old = state.e2ee.objectUrls.get(messageId);
  if (old) return old;
  const url = URL.createObjectURL(dataUrlToBlob(dataUrl));
  state.e2ee.objectUrls.set(messageId, url);
  return url;
}
function renderE2eeButton() {
  if (!els.e2eeButton) return;
  const hasChannel = Boolean(state.currentChannelId);
  els.e2eeButton.classList.toggle('hidden', !hasChannel);
  els.e2eeWarning?.classList.toggle('hidden', !hasChannel);
  if (!hasChannel) { els.composerLock?.classList.add('hidden'); return; }
  const on = e2eeEnabled(state.currentChannelId);
  els.e2eeButton.classList.toggle('e2ee-on', on);
  els.e2eeButton.textContent = on ? '🔒 E2EE' : '🔓 E2EE';
  els.e2eeButton.title = on ? 'E2EE açık — anahtarı değiştir' : 'E2EE aç / anahtar gir';
  els.messageInput.placeholder = on ? 'Şifreli mesaj yaz… server yalnızca şifreli metni görür.' : 'Mesaj yaz, fotoğraf yapıştır veya dosya sürükle...';
  els.composerLock?.classList.toggle('hidden', !on);
  if (els.e2eeWarning) {
    els.e2eeWarning.classList.toggle('e2ee-warning-on', on);
    els.e2eeWarning.innerHTML = on
      ? '<span class="e2ee-dot" aria-hidden="true">🔒</span><span class="e2ee-text">E2EE açık: yeni mesajlar bu sekmedeki anahtarla şifrelenir.</span><button type="button" class="mini-button e2ee-key">Anahtar</button>'
      : '<span class="e2ee-dot" aria-hidden="true">🔓</span><span class="e2ee-text">E2EE kapalı: yeni mesajlar sunucuda okunabilir.</span><button type="button" class="mini-button e2ee-key">E2EE aç</button>';
    els.e2eeWarning.querySelector('.e2ee-key')?.addEventListener('click', promptE2eeKey);
  }
}
function promptE2eeKey() {
  if (!state.currentChannelId) return;
  const current = e2eePassphrase(state.currentChannelId);
  const passphrase = prompt('Bu kanal/DM için E2EE anahtarı yaz. Aynı anahtarı arkadaşlarınla uygulama dışından paylaş. Server bu anahtarı görmez.', current ? '********' : '');
  if (passphrase === null) return;
  if (!passphrase || passphrase === '********') return;
  if (passphrase.length < 8) return toast('E2EE anahtarı en az 8 karakter olsun.');
  setE2eePassphrase(state.currentChannelId, passphrase, true);
  toast('E2EE bu sekmede açıldı. Yeni mesajlar şifreli gönderilecek.');
}
async function decryptVisibleMessages() {
  const items = [...els.messages.querySelectorAll('[data-secure-message="1"]')];
  for (const item of items) {
    const raw = item.dataset.messageJson;
    if (!raw) continue;
    try { await renderDecryptedMessage(JSON.parse(raw), item); } catch {}
  }
}

const LEGACY_LOCAL_BACKUP_KEYS = ['gaycord:last-light-backup:v1', 'gaycord:last-light-backup-time:v1'];
function purgeLegacySensitiveLocalBackups() {
  try { for (const key of LEGACY_LOCAL_BACKUP_KEYS) localStorage.removeItem(key); } catch {}
}
function getLocalBackup() { purgeLegacySensitiveLocalBackups(); return null; }
function setLocalBackup() { purgeLegacySensitiveLocalBackups(); return false; }
function localBackupLabel() { return 'Güvenlik nedeniyle tarayıcı içi otomatik yedek kapatıldı'; }
purgeLegacySensitiveLocalBackups();
async function refreshPublicStatus() {
  try {
    const info = await api('/api/public-status');
    state.publicStatus = info;
    const hasLocal = false;
    if (els.publicDataStatus) {
      const persistent = info.persistentData;
      els.publicDataStatus.classList.remove('hidden', 'good');
      els.publicDataStatus.classList.toggle('good', persistent);
      els.publicDataStatus.innerHTML = persistent
        ? `Kalıcı veri aktif: <strong>${escapeHTML(info.storageMode)}</strong>. Güncellemelerde hesaplar/sunucular korunur.`
        : `Uyarı: Bu servis şu an <strong>geçici dosya</strong> modunda. Render deploy edince hesaplar/sunucular silinebilir. Ayarlar > Yedek indir ve PostgreSQL kullan.`;
      if (info.userCount === 0) {
        els.bootstrapRestoreWrap?.classList.remove('hidden');
        els.restoreLocalBackupButton?.classList.toggle('hidden', !hasLocal);
        if (els.restoreLocalBackupButton) els.restoreLocalBackupButton.textContent = localBackupLabel();
      } else {
        els.bootstrapRestoreWrap?.classList.add('hidden');
      }
    }
  } catch {
    if (els.publicDataStatus) {
      els.publicDataStatus.classList.remove('hidden');
      els.publicDataStatus.textContent = 'Veri durumu alınamadı.';
    }
  }
}
async function restoreBackupObject(backup) {
  if (!backup?.db) throw new Error('Geçersiz yedek.');
  await api('/api/bootstrap-import', { method: 'POST', body: backup });
  toast('Yedek geri yüklendi. Artık eski hesabınla giriş yapabilirsin.');
  await refreshPublicStatus();
}
async function autoSaveLightBackup() { purgeLegacySensitiveLocalBackups(); }
function startAutoBackup() {
  clearInterval(state.autoBackupTimer);
  state.autoBackupTimer = null;
  purgeLegacySensitiveLocalBackups();
}

function setAuthMode(mode) {
  state.authMode = mode;
  els.loginTab.classList.toggle('active', mode === 'login');
  els.registerTab.classList.toggle('active', mode === 'register');
  els.displayNameWrap.classList.toggle('hidden', mode !== 'register');
  els.authSubmit.textContent = mode === 'login' ? 'Giriş yap' : 'Hesap oluştur';
  els.passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
}
function showAuth() { els.auth.classList.remove('hidden'); els.app.classList.add('hidden'); refreshPublicStatus(); setTimeout(() => els.usernameInput.focus(), 0); }
function showApp() { els.auth.classList.add('hidden'); els.app.classList.remove('hidden'); }
function applySettings() {
  const settings = state.settings || {};
  document.body.dataset.theme = settings.theme || 'dark';
  document.body.classList.toggle('compact-mode', Boolean(settings.compactMode));
  document.body.classList.toggle('reduce-motion', Boolean(settings.reduceMotion));
}
function hasPersistentData() {
  const status = state.dataStatus || {};
  return Boolean(status.persistentData || status.persistentDataDir || status.persistentDataDirConfigured || status.storageMode === 'postgres');
}
function persistenceCardHTML() {
  if (hasPersistentData()) return '';
  return `<section class="warning-card"><strong>Kalıcı veri henüz açık değil</strong><span>Render yeniden deploy/restart yapınca hesaplar, sunucular ve mesajlar sıfırlanabilir. Kalıcı olması için Render Environment içine <code>DATABASE_URL</code> ekle veya disk bağla. Ayarlar → Veri kalıcılığı bölümünden kontrol edebilirsin.</span></section>`;
}
function warnTemporaryStorageOnce() {
  if (hasPersistentData() || sessionStorage.getItem('gaycord-persistence-warning-seen')) return;
  sessionStorage.setItem('gaycord-persistence-warning-seen', '1');
  setTimeout(() => toast('Uyarı: Kalıcı veri kapalı. Güncellemede hesap/sunucu silinebilir; DATABASE_URL ekle.'), 700);
}
function ingestMe(data) {
  state.user = data.user || state.user;
  if (data.csrfToken) state.csrfToken = data.csrfToken;
  state.isAppOwner = Boolean(data.isAppOwner || state.user?.isAppOwner);
  state.settings = { theme: 'dark', compactMode: false, reduceMotion: false, ...(state.user?.settings || {}) };
  state.dataStatus = data.dataStatus || data.appInfo?.dataStatus || null;
  state.friends = data.friends || state.friends;
  state.servers = data.servers || [];
  state.onlineIds = new Set(data.onlineIds || []);
  applySettings();
}
async function refreshMe({ keepPanel = true } = {}) {
  ingestMe(await api('/api/me'));
  renderMe();
  renderRail();
  if (!keepPanel || state.view === 'home') renderFriendsPanel();
  else if (state.view === 'server') renderServerPanel(state.currentServerId);
  else renderMembersForCurrent();
}
function enterApp(data) {
  ingestMe(data);
  showApp();
  renderMe();
  renderRail();
  renderFriendsPanel();
  connectSocket();
  loadNotifications();
  warnTemporaryStorageOnce();
  startAutoBackup();
}


function avatarInner(user) {
  const url = safeMediaUrl(user?.avatarUrl);
  return url ? `<img src="${url}" alt="" loading="lazy">` : escapeHTML(initials(user?.displayName || user?.username || '?'));
}
function renderMe() {
  setAvatar(els.meAvatar, state.user);
  els.meName.textContent = state.user?.displayName || '-';
  els.meUsername.textContent = state.user ? `@${state.user.username}` : '-';
}
function replaceServer(server) {
  const index = state.servers.findIndex((item) => item.id === server.id);
  if (index >= 0) state.servers.splice(index, 1, server); else state.servers.push(server);
  state.servers.sort((a, b) => String(a.name).localeCompare(String(b.name), 'tr'));
}
function renderRail() {
  els.homeButton.classList.toggle('active', state.view === 'home');
  els.serverDots.innerHTML = '';
  for (const server of state.servers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `rail-button server-dot ${state.view === 'server' && state.currentServerId === server.id ? 'active' : ''}`;
    button.title = `${server.name} • ${server.memberCount || server.memberIds?.length || 0} üye`;
    button.textContent = initials(server.name);
    button.addEventListener('click', () => renderServerPanel(server.id));
    els.serverDots.appendChild(button);
  }
}
function renderMembers(server) {
  if (!server) {
    if (state.currentDmFriend) {
      const f = state.currentDmFriend;
      els.membersTitle.textContent = 'DM';
      els.membersList.innerHTML = `<div class="member-row"><span class="avatar ${state.onlineIds.has(f.id) ? 'online' : ''}">${avatarInner(f)}</span><span class="row-grow"><strong>${escapeHTML(f.displayName || f.username)}</strong><br><small>@${escapeHTML(f.username)} • ${state.onlineIds.has(f.id) ? 'çevrimiçi' : 'çevrimdışı'}</small></span></div>`;
    } else {
      els.membersTitle.textContent = 'Kişiler';
      els.membersList.innerHTML = '<div class="empty-state compact">Sunucu seçince üyeler burada görünür.</div>';
    }
    return;
  }
  const members = [...(server.members || [])].sort((a, b) => Number(b.online) - Number(a.online) || Number(b.isOwner || b.owner) - Number(a.isOwner || a.owner) || String(a.displayName || a.username).localeCompare(String(b.displayName || b.username), 'tr'));
  els.membersTitle.textContent = `${server.name} üyeleri`;
  els.membersList.innerHTML = members.length ? '' : '<div class="empty-state compact">Üye yok.</div>';
  for (const member of members) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'member-row';
    const role = member.role || ((member.isOwner || member.owner) ? 'owner' : 'member');
    const badge = role !== 'member' ? `<span class="role-badge role-${role}">${escapeHTML(ROLE_LABEL[role] || role)}</span>` : '';
    const timeoutMark = member.timedOut ? '<span class="role-badge role-timeout">⏳</span>' : '';
    row.innerHTML = `<span class="avatar ${member.online ? 'online' : ''}">${avatarInner(member)}</span><span class="row-grow"><span class="member-name-row"><strong>${escapeHTML(member.displayName || member.username)}</strong>${badge}${timeoutMark}</span><small>@${escapeHTML(member.username)} • ${member.online ? 'çevrimiçi' : 'çevrimdışı'}</small></span>`;
    row.addEventListener('click', () => openProfile(member.id));
    els.membersList.appendChild(row);
  }
}
function renderMembersForCurrent() { renderMembers(state.servers.find((server) => server.id === state.currentServerId) || null); }

function resetChat(title = 'Hoş geldin', subtitle = 'Bir kanal veya DM seç.') {
  state.currentChannelId = null;
  state.currentChannel = null;
  state.currentInviteCode = '';
  state.currentDmFriend = null;
  els.chatKicker.textContent = 'Hazır';
  els.chatTitle.textContent = title;
  els.chatSubtitle.textContent = subtitle;
  els.copyInviteButton.classList.add('hidden');
  els.e2eeButton?.classList.add('hidden');
  els.e2eeWarning?.classList.add('hidden');
  els.composerLock?.classList.add('hidden');
  els.pinsButton?.classList.add('hidden');
  els.mediaButton?.classList.add('hidden');
  cancelReply();
  els.messageInput.value = '';
  autoGrowInput();
  els.messageInput.disabled = true;
  els.sendButton.disabled = true;
  els.recordButton.disabled = true;
  els.fileButton.disabled = true;
  els.typingLine.textContent = '';
  els.messages.innerHTML = '<div class="empty-state"><strong>Bir sohbet seç</strong><span>DM aç, sunucu kanalı seç veya yeni sunucu oluştur.</span></div>';
  renderVoicePanel();
}
function scrollMessages() { els.messages.scrollTop = els.messages.scrollHeight; }
function renderMessages(messages = []) {
  els.messages.innerHTML = '';
  if (!messages.length) { els.messages.innerHTML = '<div class="empty-state"><strong>Henüz mesaj yok</strong><span>İlk mesajı sen gönder.</span></div>'; return; }
  for (const message of messages) appendMessage(message, { scroll: false });
  scrollMessages();
}
function renderDecryptedPayloadInto(bubble, message, payload) {
  bubble.innerHTML = '';
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const name = document.createElement('strong'); name.textContent = `${message.user?.displayName || message.user?.username || 'Bilinmeyen'} 🔒`;
  const time = document.createElement('time'); time.textContent = formatTime(message.createdAt);
  meta.append(name, time); bubble.appendChild(meta);
  if (payload.kind === 'voice') {
    const label = document.createElement('div'); label.className = 'message-body secure-ok'; label.textContent = `🔒🎙️ Şifreli sesli mesaj${payload.durationMs ? ` • ${Math.max(1, Math.round(payload.durationMs / 1000))} sn` : ''}`;
    const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = objectUrlForMessage(message.id, payload.audioData);
    bubble.append(label, audio);
  } else if (payload.kind === 'file') {
    if (payload.text) { const caption = document.createElement('div'); caption.className = 'file-caption secure-ok'; caption.textContent = `🔒 ${payload.text}`; bubble.appendChild(caption); }
    const mime = String(payload.mimeType || '').toLowerCase();
    const url = objectUrlForMessage(message.id, payload.fileData);
    if (!state.settings.compactMode && mime.startsWith('image/')) { const img = document.createElement('img'); img.className = 'message-image'; img.src = url; img.alt = payload.fileName || 'şifreli fotoğraf'; img.loading = 'lazy'; bubble.appendChild(img); }
    else if (!state.settings.compactMode && mime.startsWith('video/')) { const video = document.createElement('video'); video.className = 'message-video'; video.src = url; video.controls = true; video.preload = 'metadata'; bubble.appendChild(video); }
    else if (!state.settings.compactMode && mime.startsWith('audio/')) { const audio = document.createElement('audio'); audio.src = url; audio.controls = true; audio.preload = 'metadata'; bubble.appendChild(audio); }
    const link = document.createElement('a'); link.className = 'message-file'; link.href = url; link.download = payload.fileName || 'encrypted-file'; link.textContent = `🔒📎 ${payload.fileName || 'şifreli dosya'} ${formatBytes(payload.sizeBytes)}`; bubble.appendChild(link);
  } else {
    const text = document.createElement('div'); text.className = 'message-body secure-ok'; text.textContent = `🔒 ${payload.text || ''}`; bubble.appendChild(text);
  }
}
async function renderDecryptedMessage(message, article) {
  const bubble = article.querySelector('.message-bubble');
  if (!bubble) return;
  try {
    const payload = message.e2ee?.mode === 'attachment' ? await decryptAttachmentPayload(message) : await decryptPayload(message.channelId, message.e2ee);
    renderDecryptedPayloadInto(bubble, message, payload);
    decorateBubble(bubble, getArticleMessage(article) || message);
    article.classList.remove('secure-locked'); article.classList.add('secure-unlocked');
  } catch {
    article.classList.add('secure-locked'); article.classList.remove('secure-unlocked');
  }
}
function buildSecureArticle(message) {
  const article = document.createElement('article');
  article.className = `message secure-message ${message.user?.id === state.user?.id ? 'own' : ''}`;
  article.dataset.messageId = message.id;
  article.dataset.secureMessage = '1';
  const avatar = document.createElement('div'); avatar.className = `avatar ${state.onlineIds.has(message.user?.id) || message.user?.online ? 'online' : ''}`; setAvatar(avatar, message.user); avatar.addEventListener('click', () => openProfile(message.user?.id));
  const bubble = document.createElement('div'); bubble.className = 'message-bubble';
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const name = document.createElement('strong'); name.textContent = message.user?.displayName || message.user?.username || 'Bilinmeyen'; name.addEventListener('click', () => openProfile(message.user?.id));
  const time = document.createElement('time'); time.textContent = formatTime(message.createdAt); meta.append(name, time); bubble.appendChild(meta);
  const locked = document.createElement('div'); locked.className = 'secure-card'; locked.innerHTML = '<strong>🔒 Bu mesaj şifreli. Anahtar gir.</strong><small>Açmak için bu kanalın E2EE anahtarını gir. Server içeriği göremez.</small>';
  const unlock = document.createElement('button'); unlock.type = 'button'; unlock.className = 'mini-button'; unlock.textContent = 'Anahtar gir / çöz'; unlock.addEventListener('click', promptE2eeKey);
  locked.appendChild(unlock); bubble.appendChild(locked);
  article.append(avatar, bubble);
  decorateBubble(bubble, message);
  decorateArticle(article, message);
  if (e2eePassphrase(message.channelId)) renderDecryptedMessage(message, article);
  return article;
}
function appendSecureMessage(message, { scroll = true } = {}) {
  if (!message || message.channelId !== state.currentChannelId) return;
  if (els.messages.querySelector('.empty-state')) els.messages.innerHTML = '';
  if (els.messages.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
  els.messages.appendChild(buildSecureArticle(message));
  if (scroll) scrollMessages();
}

function buildArticle(message) {
  if (message?.encrypted && message?.e2ee) return buildSecureArticle(message);
  return buildPlainArticle(message);
}
function appendMessage(message, { scroll = true } = {}) {
  if (!message || message.channelId !== state.currentChannelId) return;
  if (els.messages.querySelector('.empty-state')) els.messages.innerHTML = '';
  if (els.messages.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
  els.messages.appendChild(buildArticle(message));
  if (scroll) scrollMessages();
}
function buildPlainArticle(message) {
  const article = document.createElement('article');
  article.className = `message ${message.user?.id === state.user?.id ? 'own' : ''}`;
  article.dataset.messageId = message.id;
  const avatar = document.createElement('div');
  avatar.className = `avatar ${state.onlineIds.has(message.user?.id) || message.user?.online ? 'online' : ''}`;
  setAvatar(avatar, message.user);
  avatar.addEventListener('click', () => openProfile(message.user?.id));
  const bubble = document.createElement('div'); bubble.className = 'message-bubble';
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const name = document.createElement('strong'); name.textContent = message.user?.displayName || message.user?.username || 'Bilinmeyen';
  name.addEventListener('click', () => openProfile(message.user?.id));
  const time = document.createElement('time'); time.textContent = formatTime(message.createdAt);
  meta.append(name, time); bubble.appendChild(meta);
  if (message.type === 'voice') {
    const label = document.createElement('div'); label.className = 'message-body'; label.textContent = `🎙️ Sesli mesaj${message.durationMs ? ` • ${Math.max(1, Math.round(message.durationMs / 1000))} sn` : ''}`;
    const baseUrl = absoluteUrl(message.audioUrl);
    const audioUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(message.id || message.createdAt || Date.now())}`;
    const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = audioUrl;
    const source = document.createElement('source'); source.src = audioUrl; source.type = String(message.mimeType || 'audio/wav').split(';')[0]; audio.appendChild(source);
    const actions = document.createElement('div'); actions.className = 'row-actions wrap-actions';
    const play = document.createElement('button'); play.type = 'button'; play.className = 'mini-button'; play.textContent = '▶ Dinle';
    play.addEventListener('click', () => { audio.load(); audio.play().catch(() => toast('Ses oynatılamadı; dosyayı aç/indir bağlantısını dene.')); });
    const link = document.createElement('a'); link.className = 'message-file subtle'; link.href = baseUrl; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'aç / indir';
    audio.addEventListener('error', () => link.classList.remove('subtle'));
    actions.append(play, link); bubble.append(label, audio, actions);
  } else if (message.type === 'file') {
    if (message.text) { const caption = document.createElement('div'); caption.className = 'file-caption'; caption.textContent = message.text; bubble.appendChild(caption); }
    const url = absoluteUrl(message.fileUrl);
    const mime = String(message.mimeType || '').toLowerCase();
    if (!state.settings.compactMode && mime.startsWith('image/')) { const img = document.createElement('img'); img.className = 'message-image'; img.src = url; img.alt = message.fileName || 'fotoğraf'; img.loading = 'lazy'; img.addEventListener('click', () => window.open(url, '_blank', 'noopener')); bubble.appendChild(img); }
    else if (!state.settings.compactMode && mime.startsWith('video/')) { const video = document.createElement('video'); video.className = 'message-video'; video.src = url; video.controls = true; video.preload = 'metadata'; bubble.appendChild(video); }
    else if (!state.settings.compactMode && mime.startsWith('audio/')) { const audio = document.createElement('audio'); audio.src = url; audio.controls = true; audio.preload = 'metadata'; bubble.appendChild(audio); }
    const link = document.createElement('a'); link.className = 'message-file'; link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = `📎 ${message.fileName || 'dosya'} ${formatBytes(message.sizeBytes)}`; bubble.appendChild(link);
  } else {
    const text = document.createElement('div'); text.className = 'message-body'; text.textContent = message.text || ''; bubble.appendChild(text);
  }
  article.append(avatar, bubble);
  decorateBubble(bubble, message);
  decorateArticle(article, message);
  return article;
}

function renderFriendsPanel() {
  state.view = 'home'; state.currentServerId = null; state.currentDmFriend = null;
  renderRail(); resetChat('Arkadaşlar', 'Arkadaş ekle, istek kabul et veya DM aç.'); renderMembers(null);
  els.sidebarMode.textContent = 'DM ve arkadaşlar'; els.sidebarTitle.textContent = 'Arkadaşlar';
  const incoming = state.friends.incomingRequests || [], outgoing = state.friends.outgoingRequests || [], friends = state.friends.friends || [];
  els.dynamicPanel.innerHTML = `
    ${persistenceCardHTML()}
    <section class="stack"><div class="section-title">Arkadaş ekle</div><input id="friendSearchInput" placeholder="Kullanıcı adı ara" autocomplete="off"><button id="friendSearchButton" class="primary" type="button">Ara</button><div id="friendSearchResults" class="stack"></div></section>
    <section class="stack"><div class="section-title-row"><div class="section-title">Gelen istekler</div><small>${incoming.length}</small></div><div id="incomingRequests"></div></section>
    <section class="stack"><div class="section-title-row"><div class="section-title">Arkadaşlar</div><small>${friends.length}</small></div><div id="friendList"></div></section>
    <section class="stack"><div class="section-title-row"><div class="section-title">Bekleyen</div><small>${outgoing.length}</small></div><div id="outgoingRequests"></div></section>`;
  const incomingWrap = els.dynamicPanel.querySelector('#incomingRequests');
  incomingWrap.innerHTML = incoming.length ? '' : '<div class="empty-state compact">Gelen istek yok.</div>';
  for (const req of incoming) {
    const row = document.createElement('div'); row.className = 'user-row';
    row.innerHTML = `<span class="avatar">${escapeHTML(initials(req.from.displayName || req.from.username))}</span><span class="row-grow"><strong>${escapeHTML(req.from.displayName || req.from.username)}</strong><br><small>@${escapeHTML(req.from.username)}</small></span><span class="row-actions"><button class="mini-button success" data-accept="${escapeHTML(req.id)}">Kabul</button><button class="mini-button danger" data-reject="${escapeHTML(req.id)}">Sil</button></span>`;
    incomingWrap.appendChild(row);
  }
  const friendList = els.dynamicPanel.querySelector('#friendList');
  friendList.innerHTML = friends.length ? '' : '<div class="empty-state compact">Henüz arkadaş yok.</div>';
  for (const friend of friends) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'user-row';
    button.innerHTML = `<span class="avatar ${state.onlineIds.has(friend.id) ? 'online' : ''}">${avatarInner(friend)}</span><span class="row-grow"><strong>${escapeHTML(friend.displayName || friend.username)}</strong><br><small>@${escapeHTML(friend.username)} • ${state.onlineIds.has(friend.id) ? 'çevrimiçi' : 'çevrimdışı'}</small></span>${unreadBadgeHTML(dmChannelIdFor(friend.id))}`;
    button.addEventListener('click', () => openDm(friend)); friendList.appendChild(button);
  }
  const outgoingWrap = els.dynamicPanel.querySelector('#outgoingRequests');
  outgoingWrap.innerHTML = outgoing.length ? outgoing.map((req) => `<div class="user-row"><span class="avatar">${escapeHTML(initials(req.to.displayName || req.to.username))}</span><span class="row-grow"><strong>${escapeHTML(req.to.displayName || req.to.username)}</strong><br><small>bekliyor</small></span></div>`).join('') : '<div class="empty-state compact">Bekleyen istek yok.</div>';
  els.dynamicPanel.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', async () => { await respondFriend(b.dataset.accept, true); }));
  els.dynamicPanel.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => { await respondFriend(b.dataset.reject, false); }));
  const searchInput = els.dynamicPanel.querySelector('#friendSearchInput');
  const results = els.dynamicPanel.querySelector('#friendSearchResults');
  const doSearch = async () => {
    try {
      const q = searchInput.value.trim(); if (q.length < 2) return toast('En az 2 karakter yaz.');
      const data = await api(`/api/search-users?q=${encodeURIComponent(q)}`);
      results.innerHTML = data.users?.length ? '' : '<div class="empty-state compact">Kullanıcı bulunamadı.</div>';
      for (const user of data.users || []) {
        const row = document.createElement('div'); row.className = 'user-row';
        row.innerHTML = `<span class="avatar ${user.online ? 'online' : ''}">${escapeHTML(initials(user.displayName || user.username))}</span><span class="row-grow"><strong>${escapeHTML(user.displayName || user.username)}</strong><br><small>@${escapeHTML(user.username)} ${user.friendship ? '• ' + escapeHTML(user.friendship) : ''}</small></span><button class="mini-button success" ${user.friendship ? 'disabled' : ''}>Ekle</button>`;
        row.querySelector('button')?.addEventListener('click', async () => { await api('/api/friends/request', { method: 'POST', body: { username: user.username } }); toast('Arkadaşlık isteği gönderildi.'); await refreshMe({ keepPanel: false }); });
        results.appendChild(row);
      }
    } catch (e) { toast(e.message); }
  };
  els.dynamicPanel.querySelector('#friendSearchButton').addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
}
async function respondFriend(requestId, accept) { try { await api('/api/friends/respond', { method: 'POST', body: { requestId, accept } }); await refreshMe({ keepPanel: false }); toast(accept ? 'Arkadaş eklendi.' : 'İstek silindi.'); } catch (e) { toast(e.message); } }
async function openDm(friend) {
  try {
    const data = await api(`/api/dms/${friend.id}`);
    state.view = 'dm'; state.currentServerId = null; state.currentDmFriend = friend;
    renderRail(); renderMembers(null);
    openChannel(data.channel, { title: `@${friend.displayName || friend.username}`, subtitle: `Özel mesaj • @${friend.username}`, inviteCode: '' });
  } catch (e) { toast(e.message); }
}

function renderServerPanel(serverId) {
  const server = state.servers.find((item) => item.id === serverId);
  if (!server) return renderFriendsPanel();
  state.view = 'server'; state.currentServerId = server.id; state.currentDmFriend = null;
  renderRail(); renderMembers(server);
  els.sidebarMode.textContent = 'Sunucu'; els.sidebarTitle.textContent = server.name;
  const isOwner = server.isOwner || server.ownerId === state.user?.id;
  const canManage = canManageServerClient(server);
  const canModerate = canModerateServerClient(server);
  const myRole = serverRoleClient(server);
  const roleBadge = myRole !== 'member' ? `<span class="role-badge role-${myRole}">${escapeHTML(ROLE_LABEL[myRole] || myRole)}</span>` : '';
  els.dynamicPanel.innerHTML = `
    ${persistenceCardHTML()}
    <section class="stack panel-card"><div class="section-title">Sunucu</div><div class="info-card"><span class="avatar server">${escapeHTML(initials(server.name))}</span><span class="row-grow"><strong>${escapeHTML(server.name)} ${roleBadge}</strong><br><small>${server.memberCount || server.memberIds?.length || 0} üye • Davet: <code>${escapeHTML(server.inviteCode)}</code></small></span></div><div class="server-actions"><button id="copyInvitePanelButton" class="ghost" type="button">Davet kodunu kopyala</button>${canModerate ? '<button id="serverAdminButton" class="ghost" type="button">🛡 Yönetim</button>' : ''}${canManage ? '<button id="renameServerButton" class="ghost" type="button">Ad değiştir</button><button id="renewInviteButton" class="ghost" type="button">Davet kodunu yenile</button>' : ''}${isOwner ? '<button id="deleteServerButton" class="ghost danger" type="button">Sunucuyu sil</button>' : '<button id="leaveServerButton" class="ghost danger" type="button">Sunucudan çık</button>'}</div></section>
    <section class="stack"><div class="section-title-row"><div class="section-title">Metin kanalları</div>${canManage ? '<button id="addTextChannelButton" class="mini-button">＋</button>' : ''}</div><div id="textChannelList"></div></section>
    <section class="stack"><div class="section-title-row"><div class="section-title">Ses kanalları</div>${canManage ? '<button id="addVoiceChannelButton" class="mini-button">＋</button>' : ''}</div><div id="voiceChannelList"></div></section>`;
  renderChannelGroup(els.dynamicPanel.querySelector('#textChannelList'), (server.channels || []).filter((c) => c.kind !== 'voice'), server, canManage);
  renderChannelGroup(els.dynamicPanel.querySelector('#voiceChannelList'), (server.channels || []).filter((c) => c.kind === 'voice'), server, canManage);
  els.dynamicPanel.querySelector('#copyInvitePanelButton')?.addEventListener('click', () => copyInvite(server.inviteCode));
  els.dynamicPanel.querySelector('#serverAdminButton')?.addEventListener('click', () => openServerAdmin(server.id));
  els.dynamicPanel.querySelector('#renameServerButton')?.addEventListener('click', async () => { const name = prompt('Yeni sunucu adı?', server.name); if (!name) return; try { const data = await api(`/api/servers/${server.id}`, { method: 'PATCH', body: { name } }); replaceServer(data.server); renderServerPanel(server.id); } catch (e) { toast(e.message); } });
  els.dynamicPanel.querySelector('#renewInviteButton')?.addEventListener('click', async () => { if (!confirm('Davet kodu yenilensin mi? Eski kod çalışmaz.')) return; try { const data = await api(`/api/servers/${server.id}`, { method: 'PATCH', body: { regenerateInvite: true } }); replaceServer(data.server); renderServerPanel(server.id); toast(`Yeni kod: ${data.server.inviteCode}`); } catch (e) { toast(e.message); } });
  els.dynamicPanel.querySelector('#deleteServerButton')?.addEventListener('click', () => deleteServer(server));
  els.dynamicPanel.querySelector('#leaveServerButton')?.addEventListener('click', () => leaveServer(server));
  els.dynamicPanel.querySelector('#addTextChannelButton')?.addEventListener('click', () => createChannel(server, 'text'));
  els.dynamicPanel.querySelector('#addVoiceChannelButton')?.addEventListener('click', () => createChannel(server, 'voice'));
}
function renderChannelGroup(container, channels, server, canManage) {
  container.innerHTML = channels.length ? '' : '<div class="empty-state compact">Kanal yok.</div>';
  for (const channel of channels) {
    const row = document.createElement('div'); row.className = `channel-row ${state.currentChannelId === channel.id ? 'active' : ''}`;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'channel-main';
    const lock = channel.private ? '<span class="channel-lock" title="Özel kanal">🔒</span>' : '';
    button.innerHTML = `<span class="avatar">${channel.kind === 'voice' ? '🔊' : '#'}</span><span class="row-grow"><strong>${escapeHTML(channel.name)} ${lock}</strong><br><small>${channel.private ? 'özel • ' : ''}${channel.kind === 'voice' ? 'sesli oda' : 'metin kanalı'}</small></span>${unreadBadgeHTML(channel.id)}`;
    button.addEventListener('click', () => openChannel(channel, { title: `${channel.kind === 'voice' ? '🔊' : '#'} ${channel.name}`, subtitle: `${server.name} • ${channel.kind === 'voice' ? 'canlı ses' : 'metin'}${channel.private ? ' • özel' : ''} • Davet kodu: ${server.inviteCode}`, inviteCode: server.inviteCode, serverId: server.id }));
    row.appendChild(button);
    if (canManage) {
      const gear = document.createElement('button'); gear.type = 'button'; gear.className = 'mini-button'; gear.textContent = '⚙'; gear.title = 'İzinler'; gear.addEventListener('click', () => openChannelPrivacy(server, channel)); row.appendChild(gear);
      if ((server.channels?.length || 0) > 1) { const del = document.createElement('button'); del.type = 'button'; del.className = 'mini-button danger'; del.textContent = 'Sil'; del.addEventListener('click', () => deleteChannel(server, channel)); row.appendChild(del); }
    }
    container.appendChild(row);
  }
}
async function createChannel(server, kind) {
  const name = prompt(kind === 'voice' ? 'Ses kanal adı?' : 'Metin kanal adı?', kind === 'voice' ? 'ses-odasi' : 'sohbet'); if (!name) return;
  try { const data = await api(`/api/servers/${server.id}/channels`, { method: 'POST', body: { name, kind } }); replaceServer(data.server); renderServerPanel(server.id); toast('Kanal oluşturuldu.'); } catch (e) { toast(e.message); }
}
async function deleteChannel(server, channel) {
  if (!confirm(`${channel.name} kanalı silinsin mi? Mesajlar da silinir.`)) return;
  try { const data = await api(`/api/servers/${server.id}/channels/${channel.id}`, { method: 'DELETE', body: {} }); replaceServer(data.server); if (state.currentChannelId === channel.id) resetChat('Kanal silindi', 'Başka bir kanal seç.'); renderServerPanel(server.id); } catch (e) { toast(e.message); }
}
async function deleteServer(server) {
  const typed = prompt(`Sunucuyu tamamen silmek için adını yaz: ${server.name}`); if (typed !== server.name) return toast('Sunucu silme iptal edildi.');
  try { await api(`/api/servers/${server.id}`, { method: 'DELETE', body: {} }); state.servers = state.servers.filter((item) => item.id !== server.id); toast('Sunucu silindi.'); renderFriendsPanel(); } catch (e) { toast(e.message); }
}
async function leaveServer(server) {
  if (!confirm(`${server.name} sunucusundan çıkmak istiyor musun?`)) return;
  try { await api(`/api/servers/${server.id}/leave`, { method: 'POST', body: {} }); state.servers = state.servers.filter((item) => item.id !== server.id); toast('Sunucudan çıkıldı.'); renderFriendsPanel(); } catch (e) { toast(e.message); }
}
async function copyInvite(inviteCode = state.currentInviteCode) { if (!inviteCode) return; try { await navigator.clipboard.writeText(inviteCode); toast(`Davet kodu kopyalandı: ${inviteCode}`); } catch { toast(`Davet kodu: ${inviteCode}`); } }

async function openChannel(channel, context = {}) {
  state.currentChannel = channel;
  state.currentChannelId = channel.id;
  state.currentInviteCode = context.inviteCode || '';
  if (context.serverId) state.currentServerId = context.serverId;
  els.chatKicker.textContent = channel.kind === 'voice' ? 'Ses kanalı' : (channel.type === 'dm' ? 'DM' : 'Metin kanalı');
  els.chatTitle.textContent = context.title || channel.name || 'Sohbet';
  els.chatSubtitle.textContent = context.subtitle || 'Mesajlaşmaya başla.';
  els.copyInviteButton.classList.toggle('hidden', !state.currentInviteCode);
  els.pinsButton?.classList.remove('hidden');
  els.mediaButton?.classList.remove('hidden');
  cancelReply();
  renderE2eeButton();
  syncComposerEnabled();
  els.messageInput.focus(); renderVoicePanel();
  if (state.socket?.connected) {
    state.socket.emit('channel:join', { channelId: channel.id }, (response) => { if (response?.error) return toast(response.error); renderMessages(response.messages || []); });
  } else {
    try { const data = await api(`/api/channels/${channel.id}/messages`); renderMessages(data.messages || []); } catch (e) { toast(e.message); }
  }
  markChannelRead(channel.id);
  if (state.currentServerId) renderServerPanel(state.currentServerId);
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io();
  state.socket.on('connect', () => {
    els.connectionState.textContent = 'çevrimiçi';
    els.connectionState.classList.remove('offline');
    // A reconnect creates a fresh server-side socket that is no longer in any channel room,
    // so re-join the open text channel (and reconcile history) or messages silently stop flowing.
    if (state.currentChannelId) {
      state.socket.emit('channel:join', { channelId: state.currentChannelId }, (response) => {
        if (response?.error) return;
        if (state.currentChannelId) renderMessages(response?.messages || []);
      });
    }
    rejoinVoiceAfterReconnect().catch((error) => console.warn('voice rejoin error', error));
  });
  state.socket.on('disconnect', () => {
    els.connectionState.textContent = 'çevrimdışı';
    els.connectionState.classList.add('offline');
    startVoiceReconnectGrace();
  });
  state.socket.on('connect_error', (error) => { els.connectionState.textContent = 'hata'; els.connectionState.classList.add('offline'); toast(error.message || 'Bağlantı hatası.'); });
  state.socket.on('presence:update', ({ onlineIds }) => { state.onlineIds = new Set(onlineIds || []); renderMe(); if (state.view === 'home') renderFriendsPanel(); else if (state.currentServerId) refreshMe({ keepPanel: true }).catch(() => {}); });
  state.socket.on('message:new', (message) => appendMessage(message));
  state.socket.on('message:updated', (message) => updateMessageInDom(message));
  state.socket.on('message:deleted', ({ channelId, messageId } = {}) => { if (channelId === state.currentChannelId) removeMessageFromDom(messageId); });
  state.socket.on('channel:pins', ({ channelId } = {}) => { if (currentDrawerKind === 'pins' && channelId === state.currentChannelId) openPinsDrawer(); });
  state.socket.on('notify', (item) => pushNotify(item));
  state.socket.on('me:updated', ({ user } = {}) => { if (user) { state.user = { ...state.user, ...user }; renderMe(); } });
  state.socket.on('typing', ({ channelId, user, isTyping }) => { if (channelId !== state.currentChannelId || !isTyping || user?.id === state.user?.id) return; els.typingLine.textContent = `${user.displayName || user.username} yazıyor...`; clearTimeout(state.remoteTypingTimeout); state.remoteTypingTimeout = setTimeout(() => { els.typingLine.textContent = ''; }, 1500); });
  state.socket.on('server:updated', ({ server } = {}) => { if (!server) return; replaceServer(server); renderRail(); if (state.currentServerId === server.id) renderServerPanel(server.id); });
  state.socket.on('server:deleted', ({ serverId } = {}) => { state.servers = state.servers.filter((server) => server.id !== serverId); if (state.currentServerId === serverId) { cleanupVoice({ manual: true }); renderFriendsPanel(); resetChat('Sunucu silindi', 'Başka bir sunucu seç.'); } else renderRail(); });
  state.socket.on('server:removed', ({ serverId, reason } = {}) => { state.servers = state.servers.filter((server) => server.id !== serverId); closeDrawer(); if (state.currentServerId === serverId) { cleanupVoice({ manual: true }); renderFriendsPanel(); resetChat(reason === 'ban' ? 'Sunucudan yasaklandın' : 'Sunucudan çıkarıldın', 'Başka bir sunucu seç.'); } else renderRail(); toast(reason === 'ban' ? 'Bir sunucudan yasaklandın.' : 'Bir sunucudan çıkarıldın.'); });
  state.socket.on('server:member_timeout', ({ until } = {}) => { toast(until ? 'Bir sunucuda zaman aşımı (timeout) aldın; süre dolana kadar mesaj gönderemezsin.' : 'Timeout’un kaldırıldı.'); });
  state.socket.on('channel:deleted', ({ channelId, serverId } = {}) => { if (state.voice.channelId === channelId) cleanupVoice({ manual: true }); if (state.currentChannelId === channelId) resetChat('Kanal silindi', 'Başka bir kanal seç.'); const server = state.servers.find((s) => s.id === serverId); if (server) server.channels = server.channels.filter((c) => c.id !== channelId); if (state.currentServerId === serverId) renderServerPanel(serverId); });
  state.socket.on('data:imported', () => { toast('Yedek yüklendi; sayfa yenileniyor.'); setTimeout(() => location.reload(), 900); });
  state.socket.on('voice:user_joined', ({ channelId, peer } = {}) => { if (channelId !== state.voice.channelId || !peer?.socketId || peer.socketId === state.voice.selfId) return; createPeer(peer.socketId, peer.user); renderVoicePanel(); });
  state.socket.on('voice:user_left', ({ socketId } = {}) => { if (socketId) closePeer(socketId); });
  state.socket.on('voice:members', ({ channelId, members } = {}) => { if (channelId !== state.voice.channelId) return; state.voice.roster = members || []; renderVoicePanel(); });
  state.socket.on('voice:signal', handleVoiceSignal);
}

async function sendSecurePayload(payload) {
  if (!state.currentChannelId) return;
  const e2ee = await encryptPayload(state.currentChannelId, payload);
  const data = await api(`/api/channels/${state.currentChannelId}/messages`, { method: 'POST', body: { type: 'text', encrypted: true, e2ee, replyTo: consumeReplyTo() } });
  appendMessage(data.message); // optimistic; appendMessage dedups by id when the socket echo also arrives
  return data.message;
}
// Keeps composer controls in a sane state. Never leaves inputs permanently disabled.
function syncComposerEnabled() {
  const hasChannel = Boolean(state.currentChannelId);
  if (els.messageInput) els.messageInput.disabled = !hasChannel;
  if (els.recordButton) els.recordButton.disabled = !hasChannel;
  if (els.fileButton) els.fileButton.disabled = !hasChannel || state.sendingFile;
  if (els.sendButton) {
    const hasText = Boolean(els.messageInput && els.messageInput.value.trim());
    els.sendButton.disabled = !hasChannel || !hasText || state.sendInFlight;
  }
}
// Socket emit with an ack timeout so a lost ack can never wedge the composer.
function emitWithTimeout(event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!state.socket?.connected) { reject(new Error('socket-offline')); return; }
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('ack-timeout')); } }, timeoutMs);
    try {
      state.socket.emit(event, payload, (response) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (response?.error) reject(new Error(response.error)); else resolve(response || {});
      });
    } catch (error) { if (!settled) { settled = true; clearTimeout(timer); reject(error); } }
  });
}
async function sendPlainText(channelId, text) {
  const replyTo = consumeReplyTo();
  if (state.socket?.connected) {
    const response = await emitWithTimeout('message:text', { channelId, text, replyTo });
    if (response?.message) appendMessage(response.message); // render own message even if not in the room
    return;
  }
  const data = await api(`/api/channels/${channelId}/messages`, { method: 'POST', body: { type: 'text', text, replyTo } });
  appendMessage(data.message);
}
async function sendTextMessage() {
  const channelId = state.currentChannelId;
  if (!channelId) { toast('Önce bir kanal veya DM seç.'); return; }
  const text = els.messageInput.value.trim();
  if (!text) { syncComposerEnabled(); return; }
  if (state.sendInFlight) return;
  if (!requireE2eeKeyOrPrompt(channelId)) return;
  state.sendInFlight = true;
  syncComposerEnabled();
  try {
    if (e2eeEnabled(channelId)) await sendSecurePayload({ kind: 'text', text });
    else await sendPlainText(channelId, text);
    els.messageInput.value = '';
    autoGrowInput();
    clearReplyAfterSend();
    if (state.socket?.connected) state.socket.emit('typing', { channelId, isTyping: false });
  } catch (error) {
    const reason = error && error.message;
    if (reason === 'ack-timeout') toast('Yanıt gecikti. Mesaj gönderilmemişse tekrar dene.');
    else toast(reason && reason !== 'socket-offline' ? reason : 'Mesaj gönderilemedi, tekrar dene.');
  } finally {
    state.sendInFlight = false;
    syncComposerEnabled();
    if (state.currentChannelId === channelId && els.messageInput && !els.messageInput.disabled) els.messageInput.focus();
  }
}
function blobToDataURL(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }); }
function fileToDataURL(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }
function mergeFloat32(buffers) {
  const length = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const buffer of buffers) { result.set(buffer, offset); offset += buffer.length; }
  return result;
}
function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  const writeString = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}
function cleanupRecorderUi() {
  clearTimeout(state.recordMaxTimer);
  state.recordMaxTimer = null;
  state.recordChannelId = '';
  els.recordButton.classList.remove('recording');
  els.recordButton.textContent = '🎙';
}
// Tear down an in-progress recording WITHOUT uploading (used on logout to avoid a doomed post-signout send).
function discardRecording() {
  const recorder = state.recorder;
  cleanupRecorderUi();
  if (!recorder) return;
  recorder.stopped = true;
  try { recorder.processor?.disconnect(); } catch {}
  try { recorder.source?.disconnect(); } catch {}
  try { recorder.silence?.disconnect(); } catch {}
  state.recordStream?.getTracks().forEach((track) => track.stop());
  state.recordStream = null;
  state.recorder = null;
  state.recordChunks = [];
  try { recorder.context?.close?.(); } catch {}
}
async function startRecording() {
  if (!state.currentChannelId) return toast('Önce kanal veya DM seç.');
  if (!requireE2eeKeyOrPrompt(state.currentChannelId)) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !AudioContextClass) return toast('Tarayıcı ses kaydını desteklemiyor.');
  try {
    state.recordStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(state.recordStream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silence = context.createGain();
    silence.gain.value = 0;
    state.recordChunks = [];
    state.recordStartedAt = Date.now();
    state.recordChannelId = state.currentChannelId;
    processor.onaudioprocess = (event) => {
      if (!state.recorder) return;
      state.recordChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(silence);
    silence.connect(context.destination);
    state.recorder = { context, source, processor, silence, sampleRate: context.sampleRate, stopped: false };
    state.recordMaxTimer = setTimeout(() => { if (state.recorder) stopRecording(); }, 65000);
    els.recordButton.classList.add('recording');
    els.recordButton.textContent = '⏹';
    toast('Kayıt başladı. Bitirmek için tekrar bas.');
  } catch { toast('Mikrofon izni alınamadı.'); cleanupRecorderUi(); }
}
async function stopRecording() {
  const recorder = state.recorder;
  if (!recorder || recorder.stopped) return;
  recorder.stopped = true;
  const channelId = state.recordChannelId || state.currentChannelId;
  const durationMs = Date.now() - state.recordStartedAt;
  try { recorder.processor?.disconnect(); } catch {}
  try { recorder.source?.disconnect(); } catch {}
  try { recorder.silence?.disconnect(); } catch {}
  state.recordStream?.getTracks().forEach((track) => track.stop());
  state.recordStream = null;
  const chunks = state.recordChunks.slice();
  state.recorder = null;
  state.recordChunks = [];
  cleanupRecorderUi();
  try {
    if (!chunks.length || durationMs < 250) throw new Error('Ses kaydı boş geldi. Tekrar deneyip 1 saniyeden uzun tut.');
    const blob = encodeWav(mergeFloat32(chunks), recorder.sampleRate || 48000);
    if (!blob.size) throw new Error('Ses kaydı boş geldi.');
    const dataUrl = await blobToDataURL(blob);
    if (e2eeEnabled(channelId)) {
      const encrypted = await encryptAttachmentForUpload(channelId, blob, { kind: 'voice', mimeType: 'audio/wav', fileName: 'voice.wav', durationMs });
      const response = await api(`/api/channels/${channelId}/messages`, { method: 'POST', body: { type: 'voice', audioData: encrypted.fileData, mimeType: 'application/octet-stream', fileName: 'encrypted-voice.gce', durationMs, encrypted: true, e2ee: encrypted.e2ee, replyTo: consumeReplyTo() } });
      appendMessage(response.message);
      clearReplyAfterSend();
      toast('Şifreli sesli mesaj gönderildi.');
    } else {
      const response = await api(`/api/channels/${channelId}/messages`, { method: 'POST', body: { type: 'voice', audioData: dataUrl, mimeType: 'audio/wav', fileName: 'voice.wav', durationMs, replyTo: consumeReplyTo() } });
      appendMessage(response.message);
      clearReplyAfterSend();
      toast('Sesli mesaj gönderildi.');
    }
  } catch (error) { toast(error.message || 'Sesli mesaj gönderilemedi.'); }
  finally { try { await recorder.context?.close?.(); } catch {} }
}
async function sendFile(file) {
  if (!file || !state.currentChannelId || state.sendingFile) return;
  if (file.size > 15 * 1024 * 1024) return toast('Dosya 15 MB sınırını aşıyor.');
  if (!requireE2eeKeyOrPrompt(state.currentChannelId)) return;
  state.sendingFile = true; els.fileButton.disabled = true;
  try {
    const fileData = await fileToDataURL(file); const caption = els.messageInput.value.trim();
    if (e2eeEnabled(state.currentChannelId)) {
      const encrypted = await encryptAttachmentForUpload(state.currentChannelId, file, { kind: 'file', fileName: file.name || 'dosya', mimeType: file.type || 'application/octet-stream', sizeBytes: file.size || 0, text: caption });
      const data = await api(`/api/channels/${state.currentChannelId}/messages`, { method: 'POST', body: { type: 'file', fileData: encrypted.fileData, fileName: 'encrypted-file.gce', mimeType: 'application/octet-stream', encrypted: true, e2ee: encrypted.e2ee, replyTo: consumeReplyTo() } });
      if (caption) { els.messageInput.value = ''; autoGrowInput(); syncComposerEnabled(); }
      appendMessage(data.message);
      clearReplyAfterSend();
      toast('Şifreli dosya gönderildi.');
    } else {
      const data = await api(`/api/channels/${state.currentChannelId}/messages`, { method: 'POST', body: { type: 'file', fileData, fileName: file.name || 'dosya', mimeType: file.type || 'application/octet-stream', text: caption, replyTo: consumeReplyTo() } });
      if (caption) { els.messageInput.value = ''; autoGrowInput(); syncComposerEnabled(); }
      appendMessage(data.message);
      clearReplyAfterSend();
      toast('Dosya gönderildi.');
    }
  } catch (e) { toast(e.message); }
  finally { state.sendingFile = false; els.fileInput.value = ''; syncComposerEnabled(); }
}
async function sendFiles(files) { for (const file of [...(files || [])]) await sendFile(file); }

function canCallCurrentChannel() { return Boolean(state.currentChannelId && (state.currentChannel?.kind === 'voice' || state.currentChannel?.type === 'dm')); }
function callLabel() { return state.currentChannel?.type === 'dm' ? 'DM araması' : `🔊 ${state.currentChannel?.name || 'Sesli oda'}`; }
function freshVoiceState(overrides = {}) {
  return {
    channelId: null,
    stream: null,
    sendTrack: null,
    peers: new Map(),
    participants: new Map(),
    roster: [],
    muted: false,
    deafened: false,
    preDeafenMuted: false,
    localMuted: new Set(),
    selfId: state.socket?.id || null,
    keepaliveTimer: null,
    reconnectGraceTimer: null,
    reconnecting: false,
    manualLeave: false,
    peerRestartTimers: new Map(),
    analysers: new Map(),
    audioCtx: null,
    speakingRaf: null,
    gainSource: null,
    gainNode: null,
    gainDest: null,
    ...overrides
  };
}
function clearVoiceKeepalive() {
  if (state.voice.keepaliveTimer) clearInterval(state.voice.keepaliveTimer);
  state.voice.keepaliveTimer = null;
}
function clearVoiceReconnectGrace() {
  if (state.voice.reconnectGraceTimer) clearTimeout(state.voice.reconnectGraceTimer);
  state.voice.reconnectGraceTimer = null;
}
function clearPeerRestartTimer(socketId) {
  const timer = state.voice.peerRestartTimers?.get(socketId);
  if (timer) clearTimeout(timer);
  state.voice.peerRestartTimers?.delete(socketId);
}
async function sendVoiceKeepalive() {
  const channelId = state.voice.channelId;
  if (!channelId || !state.voice.stream) return;
  try { await api('/api/voice/keepalive', { method: 'POST', body: { channelId } }); } catch (e) { console.warn('voice keepalive error', e); }
  if (state.socket?.connected) state.socket.emit('voice:ping', { channelId }, () => {});
}
function startVoiceKeepalive() {
  clearVoiceKeepalive();
  if (!state.voice.channelId || !state.voice.stream) return;
  state.voice.keepaliveTimer = setInterval(() => { sendVoiceKeepalive().catch(() => {}); }, VOICE_KEEPALIVE_MS);
  sendVoiceKeepalive().catch(() => {});
}
function startVoiceReconnectGrace() {
  if (!state.voice.channelId || !state.voice.stream || state.voice.manualLeave) return;
  const alreadyReconnecting = state.voice.reconnecting;
  state.voice.reconnecting = true;
  clearVoiceReconnectGrace();
  state.voice.reconnectGraceTimer = setTimeout(() => {
    if (!state.voice.manualLeave && state.voice.reconnecting) {
      toast('Ses bağlantısı zaman aşımına uğradı.');
      cleanupVoice({ manual: false });
    }
  }, VOICE_RECONNECT_GRACE_MS);
  renderVoicePanel();
  if (!alreadyReconnecting) toast('Bağlantı koptu, ses odasına yeniden bağlanılıyor...');
}
function closeAllVoicePeers() {
  for (const socketId of [...state.voice.peers.keys()]) closePeer(socketId);
}
function emitVoiceJoin(channelId) {
  return new Promise((resolve, reject) => {
    if (!state.socket?.connected) return reject(new Error('Önce sunucu bağlantısı kurulmalı.'));
    state.socket.emit('voice:join', { channelId }, async (response) => {
      if (response?.error) return reject(new Error(response.error));
      try {
        state.voice.channelId = channelId;
        state.voice.selfId = response.selfId || state.socket.id;
        state.voice.manualLeave = false;
        state.voice.reconnecting = false;
        state.voice.participants.clear();
        state.voice.roster = response.members || []; // server-authoritative roster (separate from socketId-keyed peers)
        for (const peer of response.peers || []) { createPeer(peer.socketId, peer.user); await offerPeer(peer.socketId); }
        startVoiceKeepalive();
        renderVoicePanel(response.members || null);
        resolve(response);
      } catch (error) {
        reject(error);
      }
    });
  });
}
async function rejoinVoiceAfterReconnect() {
  const channelId = state.voice.channelId;
  if (!channelId || !state.voice.stream || state.voice.manualLeave) return;
  state.voice.reconnecting = true;
  closeAllVoicePeers();
  state.voice.participants.clear();
  renderVoicePanel();
  try {
    await emitVoiceJoin(channelId);
    clearVoiceReconnectGrace();
    state.voice.reconnecting = false;
    renderVoicePanel();
    toast('Ses odasına yeniden bağlandın.');
  } catch (e) {
    state.voice.reconnecting = true;
    renderVoicePanel();
    toast(e.message || 'Ses odasına yeniden bağlanılamadı.');
  }
}
function renderVoicePanel() {
  const inCall = Boolean(state.voice.channelId);
  const viewingCallable = canCallCurrentChannel();
  if (!inCall && !viewingCallable) { els.voicePanel.classList.add('hidden'); els.voicePanel.classList.remove('reconnecting', 'in-call'); els.voicePanel.innerHTML = ''; return; }
  els.voicePanel.classList.remove('hidden');
  els.voicePanel.classList.toggle('reconnecting', Boolean(inCall && state.voice.reconnecting));
  els.voicePanel.classList.toggle('in-call', inCall);
  const activeHere = inCall && state.voice.channelId === state.currentChannelId;
  // Roster (server-authoritative member list) drives the list + count so it is accurate immediately,
  // even before WebRTC peers finish (re)connecting. Per-peer controls target the remote <audio> by socketId.
  const userSocket = new Map();
  for (const sid of state.voice.peers.keys()) { const uid = state.voice.participants.get(sid)?.user?.id; if (uid) userSocket.set(uid, sid); }
  const others = inCall ? (state.voice.roster || []).filter((m) => m && m.id && m.id !== state.user?.id) : [];
  const seenIds = new Set(others.map((m) => m.id));
  for (const sid of state.voice.peers.keys()) { const u = state.voice.participants.get(sid)?.user; if (u && u.id && !seenIds.has(u.id)) { others.push(u); seenIds.add(u.id); } }
  const count = inCall ? others.length + 1 : 0;
  const title = state.voice.reconnecting ? 'Yeniden bağlanılıyor…' : (activeHere ? callLabel() : (inCall ? 'Başka bir ses kanalında' : callLabel()));
  const stateLabel = state.voice.reconnecting ? 'Yeniden bağlanıyor' : state.voice.deafened ? 'Sağırlaştırıldı' : state.voice.muted ? 'Mikrofon kapalı' : 'Bağlı';
  const status = inCall ? `${count} kişi • ${escapeHTML(stateLabel)}` : 'Canlı konuşmak için katıl.';
  const localActions = inCall
    ? `<button id="muteVoiceButton" class="voice-ctl ${state.voice.muted ? 'on' : ''}" type="button" title="${state.voice.muted ? 'Mikrofonu aç' : 'Mikrofonu kapat'}">${state.voice.muted ? '🔇' : '🎙'}</button>`
      + `<button id="deafenVoiceButton" class="voice-ctl ${state.voice.deafened ? 'on' : ''}" type="button" title="${state.voice.deafened ? 'Sesi aç' : 'Sağırlaştır'}">${state.voice.deafened ? '🔇🎧' : '🎧'}</button>`
      + `<button id="voiceSettingsButton" class="voice-ctl" type="button" title="Ses ayarları">⚙</button>`
      + `<button id="reconnectVoiceButton" class="voice-ctl" type="button" title="Yeniden bağlan">⟳</button>`
      + `<button id="leaveVoiceButton" class="ghost danger" type="button">Ayrıl</button>`
    : '<button id="joinVoiceButton" class="primary" type="button">Sese katıl</button>';
  const selfRow = `<div class="voice-prow voice-self-chip ${state.voice.muted ? 'self-muted' : ''}"><span class="voice-dot"></span><strong class="row-grow min-0">Sen</strong><span class="voice-self-state">${state.voice.deafened ? '🔇🎧' : state.voice.muted ? '🔇' : '🎙'}</span></div>`;
  const peerRows = others.map((m) => {
    const sid = userSocket.get(m.id);
    const lm = state.voice.localMuted?.has(m.id);
    const controls = sid
      ? `<input class="voice-vol" type="range" min="0" max="100" value="${getUserVolume(m.id)}" data-peer-vol="${escapeHTML(sid)}" aria-label="Ses düzeyi"><button class="voice-mute-user ${lm ? 'on' : ''}" type="button" data-peer-mute="${escapeHTML(sid)}" title="Bu kullanıcıyı yerel olarak sustur">${lm ? '🔇' : '🔈'}</button>`
      : '<small class="voice-connecting">bağlanıyor…</small>';
    return `<div class="voice-prow"${sid ? ` data-voice-peer="${escapeHTML(sid)}"` : ''}><span class="voice-dot"></span><strong class="row-grow min-0">${escapeHTML(m.displayName || m.username || 'Kullanıcı')}</strong>${controls}</div>`;
  }).join('');
  els.voicePanel.innerHTML = `
    <div class="voice-head"><div class="min-0"><strong>${escapeHTML(title)}</strong><small>${status}</small></div><div class="voice-local-actions">${localActions}</div></div>
    ${inCall ? `<div class="voice-participants">${selfRow}${peerRows}</div>` : ''}`;
  $('joinVoiceButton')?.addEventListener('click', joinVoice);
  $('leaveVoiceButton')?.addEventListener('click', () => leaveVoice(true));
  $('muteVoiceButton')?.addEventListener('click', toggleMute);
  $('deafenVoiceButton')?.addEventListener('click', toggleDeafen);
  $('voiceSettingsButton')?.addEventListener('click', openVoiceSettings);
  $('reconnectVoiceButton')?.addEventListener('click', reconnectVoiceManual);
  els.voicePanel.querySelectorAll('[data-peer-vol]').forEach((sl) => sl.addEventListener('input', () => setRemoteVolume(sl.dataset.peerVol, Number(sl.value))));
  els.voicePanel.querySelectorAll('[data-peer-mute]').forEach((b) => b.addEventListener('click', () => toggleLocalMuteUser(b.dataset.peerMute)));
}
function createPeer(socketId, user) {
  if (!state.voice.stream) return null;
  if (state.voice.peers.has(socketId)) return state.voice.peers.get(socketId);
  const pc = new RTCPeerConnection(rtcConfig);
  state.voice.peers.set(socketId, pc); state.voice.participants.set(socketId, { socketId, user });
  const sendTrack = state.voice.sendTrack || state.voice.stream.getAudioTracks()[0];
  if (sendTrack) pc.addTrack(sendTrack, state.voice.stream);
  pc.onicecandidate = (event) => { if (event.candidate) state.socket?.emit('voice:signal', { to: socketId, signal: { candidate: event.candidate } }); };
  pc.ontrack = (event) => {
    let audio = document.getElementById(`remote-${socketId}`);
    if (!audio) { audio = document.createElement('audio'); audio.id = `remote-${socketId}`; audio.autoplay = true; audio.playsInline = true; els.remoteAudio.appendChild(audio); }
    audio.srcObject = event.streams[0]; audio.play?.().catch(() => {});
    configureRemoteAudio(audio, { socketId, user });
    attachAnalyser(socketId, event.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'closed') { closePeer(socketId); return; }
    if (pc.connectionState === 'failed') { restartPeerIce(socketId).catch(() => closePeer(socketId)); return; }
    if (pc.connectionState === 'disconnected') {
      clearPeerRestartTimer(socketId);
      const timer = setTimeout(() => {
        const current = state.voice.peers.get(socketId);
        if (current?.connectionState === 'disconnected') restartPeerIce(socketId).catch((error) => console.warn('voice ice restart error', error));
      }, VOICE_ICE_RESTART_DELAY_MS);
      state.voice.peerRestartTimers.set(socketId, timer);
      return;
    }
    if (pc.connectionState === 'connected') clearPeerRestartTimer(socketId);
  };
  renderVoicePanel(); return pc;
}
async function offerPeer(socketId, options = {}) {
  const pc = state.voice.peers.get(socketId);
  if (!pc || pc.connectionState === 'closed') return;
  const offer = await pc.createOffer(options.iceRestart ? { iceRestart: true } : undefined);
  await pc.setLocalDescription(offer);
  state.socket?.emit('voice:signal', { to: socketId, signal: { description: pc.localDescription } });
}
async function restartPeerIce(socketId) {
  const pc = state.voice.peers.get(socketId);
  if (!pc || !state.socket?.connected || pc.connectionState === 'closed') return;
  clearPeerRestartTimer(socketId);
  try { pc.restartIce?.(); } catch {}
  await offerPeer(socketId, { iceRestart: true });
}
async function handleVoiceSignal({ from, user, signal } = {}) {
  if (!from || !signal || !state.voice.channelId) return;
  const pc = createPeer(from, user); if (!pc) return;
  try {
    if (signal.description) { await pc.setRemoteDescription(signal.description); if (signal.description.type === 'offer') { const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); state.socket?.emit('voice:signal', { to: from, signal: { description: pc.localDescription } }); } }
    else if (signal.candidate) await pc.addIceCandidate(signal.candidate);
  } catch (e) { console.warn('voice signal error', e); }
}
function closePeer(socketId) {
  const pc = state.voice.peers.get(socketId);
  clearPeerRestartTimer(socketId);
  detachAnalyser(socketId);
  state.voice.peers.delete(socketId);
  state.voice.participants.delete(socketId);
  document.getElementById(`remote-${socketId}`)?.remove();
  try { if (pc && pc.connectionState !== 'closed') pc.close(); } catch {}
  renderVoicePanel();
}
async function joinVoice() {
  if (!state.socket?.connected) return toast('Önce sunucu bağlantısı kurulmalı.');
  if (!canCallCurrentChannel()) return toast('Bir ses kanalı veya DM seç.');
  if (state.voice.channelId === state.currentChannelId) return;
  if (state.voice.channelId) await leaveVoice(true);
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return toast('Tarayıcı canlı sesi desteklemiyor.');
  if (!state.voicePrefs) state.voicePrefs = loadVoicePrefs();
  try {
    const stream = await acquireMicStream();
    state.voice = freshVoiceState({ channelId: state.currentChannelId, stream, selfId: state.socket.id, manualLeave: false });
    state.voice.sendTrack = buildSendTrack();
    applyMicEnabled();
    attachAnalyser('self', stream);
    refreshVoiceDevices().catch(() => {}); // permission granted now: cache real device ids
    renderVoicePanel();
    await emitVoiceJoin(state.currentChannelId);
    toast('Sesli odaya bağlandın.');
  } catch (e) {
    toast(e.message || 'Mikrofon izni alınamadı.');
    cleanupVoice({ manual: false });
  }
}
async function leaveVoice(emit = true) {
  state.voice.manualLeave = true;
  clearVoiceKeepalive();
  clearVoiceReconnectGrace();
  if (emit && state.socket?.connected && state.voice.channelId) state.socket.emit('voice:leave', {}, () => {});
  cleanupVoice({ manual: true });
}
function cleanupVoice(options = {}) {
  const manual = typeof options === 'boolean' ? options : Boolean(options.manual);
  state.voice.manualLeave = manual;
  clearVoiceKeepalive();
  clearVoiceReconnectGrace();
  stopSpeakingLoop();
  for (const key of [...(state.voice.analysers?.keys() || [])]) detachAnalyser(key);
  teardownGain();
  try { state.voice.audioCtx?.close(); } catch {}
  for (const socketId of [...(state.voice.peerRestartTimers?.keys() || [])]) clearPeerRestartTimer(socketId);
  closeAllVoicePeers();
  state.voice.stream?.getTracks().forEach((track) => track.stop());
  state.voice = freshVoiceState({ manualLeave: manual });
  els.remoteAudio.innerHTML = '';
  renderVoicePanel();
}
function toggleMute() {
  if (!state.voice.channelId) return;
  if (state.voice.deafened) { toggleDeafen(); return; }
  state.voice.muted = !state.voice.muted;
  applyMicEnabled();
  renderVoicePanel();
}

async function showSettings() {
  const settings = { theme: 'dark', compactMode: false, reduceMotion: false, ...(state.settings || {}) };
  const ownedServers = (state.servers || []).filter((s) => s.isOwner || s.ownerId === state.user?.id);
  els.settingsContent.innerHTML = `
    <section class="settings-section"><h3>Profil</h3><div class="profile-edit-row"><span class="avatar small" id="settingsAvatarPreview"></span><div class="row-grow"><button id="settingsAvatarButton" class="ghost" type="button">Avatar yükle</button> <button id="settingsBannerButton" class="ghost" type="button">Afiş yükle</button></div></div><input id="settingsAvatarInput" class="hidden" type="file" accept="image/*"><input id="settingsBannerInput" class="hidden" type="file" accept="image/*"><label>Görünen ad<input id="settingsDisplayName" value="${escapeHTML(state.user?.displayName || '')}" maxlength="32"></label><label>Durum yazısı<input id="settingsStatus" value="${escapeHTML(state.user?.status || '')}" maxlength="80" placeholder="Müsait, oyundayım..."></label><label>Hakkımda<textarea id="settingsBio" maxlength="280" rows="3" placeholder="Kısa bir bio...">${escapeHTML(state.user?.bio || '')}</textarea></label><button id="saveProfileButton" class="primary" type="button">Kaydet</button></section>
    <section class="settings-section"><h3>Görünüm</h3><label>Tema<select id="settingsTheme"><option value="dark">Dark</option><option value="midnight">Midnight</option><option value="rainbow">Rainbow</option></select></label><label class="toggle-row"><input id="compactModeToggle" type="checkbox"> Kompakt görünüm</label><label class="toggle-row"><input id="reduceMotionToggle" type="checkbox"> Animasyonları azalt</label><button id="saveUiButton" class="ghost" type="button">Görünümü kaydet</button></section>
    <section class="settings-section"><h3>Ses</h3><p>Mikrofon iznini buradan test edebilirsin. Sesli mesaj ve arama HTTPS üzerinde çalışır.</p><div class="wrap-actions"><button id="testMicButton" class="ghost" type="button">Mikrofonu test et</button><button id="openVoiceSettingsButton" class="ghost" type="button">🎧 Cihaz ve gelişmiş ses ayarları</button></div><div id="micTestResult" class="info-card"><span class="row-grow"><strong>Hazır</strong><br><small>Butona basınca tarayıcı mikrofon izni ister.</small></span></div></section>
    <section class="settings-section"><h3>Güvenlik</h3><div id="securityInfo" class="info-card"><span class="row-grow"><strong>Kontrol ediliyor...</strong><br><small>CSRF, rate-limit, upload yetkisi ve E2EE durumu.</small></span></div><ul class="security-list"><li>E2EE kanal başlığındaki kilit butonuyla açılır. Anahtar servera gönderilmez.</li><li>Yeni şifreli mesajları sadece aynı anahtarı bilen kişiler okuyabilir.</li><li>E2EE kapalıyken yeni mesajlar sunucuda okunabilir biçimde saklanır; kanal üstünde ayrıca uyarı görünür.</li><li>Canlı ses odası içeriği bu sürümde WebRTC/HTTPS ile gider; E2EE kilidi canlı ses için değil, mesaj/dosya/sesli mesaj içindir.</li><li>V7 otomatik tarayıcı yedeğini kapatır ve eski hassas localStorage yedeğini temizler.</li></ul><button id="logoutAllButton" class="ghost danger" type="button">Kendi oturumlarımı kapat</button></section>
    <section class="settings-section"><h3>Veri kalıcılığı</h3><div id="storageInfo" class="info-card"><span class="row-grow"><strong>Kontrol ediliyor...</strong><br><small>Hesaplar, sunucular, mesajlar ve dosyalar server tarafında saklanır.</small></span></div><p>Render Free dosya sistemi deploy/restart sonrası silinebilir. Hesaplar ve sunucular kesin kalsın istiyorsan PostgreSQL bağlantısı (DATABASE_URL) kullan. Yedek indir butonu acil geri dönüş içindir.</p></section>
    ${ownedServers.length ? `<section class="settings-section"><h3>Sunucu yönetimi</h3><p>Sahibi olduğun sunucuları yönet: kanal/üye düzeni, sabitlenen mesajlar ve mesaj moderasyonu (kendi sunucundaki mesajları silebilirsin). Sunucu yöneticiliği yalnızca kendi sunucunla sınırlıdır; genel uygulama yedeğine erişim vermez.</p><div id="ownedServerList" class="stack"></div></section>` : ''}
    ${state.isAppOwner
      ? `<section class="settings-section owner-panel"><h3>Uygulama sahibi paneli <span class="security-pill">Super Admin</span></h3><p>Bu panel yalnızca uygulama sahibine (ilk kayıt olan Super Admin) görünür. Genel yedek tüm hesapları, sunucuları, mesajları ve dosyaları içerir; aktif oturum anahtarları yedeğe <strong>dahil edilmez</strong>.</p><div class="wrap-actions"><button id="downloadBackupButton" class="ghost" type="button">Yedek indir</button><input id="backupFileInput" type="file" accept="application/json,.json"><button id="importBackupButton" class="ghost danger" type="button">Yedek yükle</button><button id="invalidateAllSessionsButton" class="ghost danger" type="button">Tüm oturumları sıfırla</button></div><div class="section-title-row"><div class="section-title">Güvenlik olayları</div><button id="refreshSecurityEventsButton" class="mini-button" type="button">Yenile</button></div><div id="securityEventsList" class="security-events"><small>Yükleniyor…</small></div></section>`
      : '<section class="settings-section"><h3>Yedek</h3><p>Yedek alma yalnızca uygulama sahibine açıktır.</p></section>'}`;
  const theme = $('settingsTheme'), compact = $('compactModeToggle'), reduce = $('reduceMotionToggle');
  theme.value = settings.theme || 'dark'; compact.checked = Boolean(settings.compactMode); reduce.checked = Boolean(settings.reduceMotion);
  setAvatar($('settingsAvatarPreview'), state.user);
  $('settingsAvatarButton')?.addEventListener('click', () => $('settingsAvatarInput')?.click());
  $('settingsBannerButton')?.addEventListener('click', () => $('settingsBannerInput')?.click());
  $('settingsAvatarInput')?.addEventListener('change', async (event) => { await uploadProfileMedia('avatar', event.target.files?.[0]); setAvatar($('settingsAvatarPreview'), state.user); event.target.value = ''; });
  $('settingsBannerInput')?.addEventListener('change', async (event) => { await uploadProfileMedia('banner', event.target.files?.[0]); event.target.value = ''; });
  $('saveProfileButton')?.addEventListener('click', async () => {
    try { const response = await api('/api/me', { method: 'PATCH', body: { displayName: $('settingsDisplayName').value, status: $('settingsStatus').value, bio: $('settingsBio')?.value || '', settings: state.settings } }); state.user = { ...state.user, ...response.user }; renderMe(); toast('Profil kaydedildi.'); } catch (e) { toast(e.message); }
  });
  $('saveUiButton')?.addEventListener('click', async () => {
    try { const newSettings = { theme: theme.value, compactMode: compact.checked, reduceMotion: reduce.checked }; const response = await api('/api/me', { method: 'PATCH', body: { displayName: state.user.displayName, status: state.user.status || '', settings: newSettings } }); state.user = { ...state.user, ...response.user }; state.settings = { ...newSettings, ...(response.user?.settings || {}) }; applySettings(); toast('Görünüm kaydedildi.'); } catch (e) { toast(e.message); }
  });
  $('testMicButton')?.addEventListener('click', async () => {
    const target = $('micTestResult');
    try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); target.innerHTML = '<span class="avatar online">✓</span><span class="row-grow"><strong>Mikrofon çalışıyor</strong><br><small>İzin verildi. Artık sesli mesaj ve arama kullanabilirsin.</small></span>'; stream.getTracks().forEach((track) => track.stop()); }
    catch { target.innerHTML = '<span class="avatar">!</span><span class="row-grow"><strong>Mikrofon izni alınamadı</strong><br><small>Tarayıcı adres çubuğundan mikrofon iznini kontrol et.</small></span>'; }
  });
  $('openVoiceSettingsButton')?.addEventListener('click', () => { els.settingsModal.close?.(); openVoiceSettings(); });
  try {
    const info = await api('/api/storage-info'); const ok = Boolean(info.persistentData);
    $('storageInfo').innerHTML = `<span class="avatar ${ok ? 'online' : ''}">${ok ? '✓' : '!'}</span><span class="row-grow"><strong>${ok ? 'Kalıcı veri aktif' : 'Kalıcı veri garanti değil'}</strong><br><small>${escapeHTML(info.storageMode || 'file')} • ${escapeHTML(info.dataDir || '')} • ${info.uploadCount || 0} dosya • ${escapeHTML(info.warning || '')}</small></span>`;
  } catch { $('storageInfo').innerHTML = '<span class="row-grow"><strong>Veri bilgisi alınamadı</strong><br><small>/api/storage-info yanıt vermedi.</small></span>'; }
  const renderSecurityEvents = (events) => {
    const list = $('securityEventsList');
    if (!list) return;
    if (!Array.isArray(events) || !events.length) { list.innerHTML = '<small>Henüz güvenlik olayı yok.</small>'; return; }
    list.innerHTML = '';
    for (const ev of events.slice(0, 25)) {
      const row = document.createElement('div'); row.className = 'security-event';
      const head = document.createElement('div'); head.className = 'security-event-head';
      head.innerHTML = `<strong>${escapeHTML(ev.type || '?')}</strong><time>${escapeHTML(formatTime(ev.createdAt))}</time>`;
      const detail = document.createElement('small'); detail.textContent = JSON.stringify(ev.details || {}).slice(0, 220);
      row.append(head, detail); list.appendChild(row);
    }
  };
  const loadSecurityStatus = async () => {
    try {
      const sec = await api('/api/security/status');
      $('securityInfo').innerHTML = `<span class="avatar online">✓</span><span class="row-grow"><strong>V7 Security aktif</strong><br><small>${escapeHTML(sec.sessionStorage)} • ${escapeHTML(sec.passwordKdf)} • CSRF/rate-limit/upload yetkisi açık</small></span>`;
      if (state.isAppOwner) renderSecurityEvents(sec.recentSecurityEvents);
    } catch { $('securityInfo').innerHTML = '<span class="row-grow"><strong>Güvenlik durumu alınamadı</strong><br><small>/api/security/status yanıt vermedi.</small></span>'; }
  };
  await loadSecurityStatus();
  $('refreshSecurityEventsButton')?.addEventListener('click', loadSecurityStatus);
  const ownedList = $('ownedServerList');
  if (ownedList) {
    ownedList.innerHTML = ownedServers.length ? '' : '<div class="empty-state compact">Sahibi olduğun sunucu yok.</div>';
    for (const server of ownedServers) {
      const row = document.createElement('div'); row.className = 'info-card';
      row.innerHTML = `<span class="avatar server">${escapeHTML(initials(server.name))}</span><span class="row-grow"><strong>${escapeHTML(server.name)}</strong><br><small>${server.memberCount || server.memberIds?.length || 0} üye • sahip</small></span>`;
      const manage = document.createElement('button'); manage.type = 'button'; manage.className = 'mini-button'; manage.textContent = 'Yönet';
      manage.addEventListener('click', () => { els.settingsModal.close?.(); renderServerPanel(server.id); });
      row.appendChild(manage); ownedList.appendChild(row);
    }
  }
  $('logoutAllButton')?.addEventListener('click', async () => { if (!confirm('Tüm cihazlardaki oturumların kapatılsın mı?')) return; try { await api('/api/security/logout-all', { method: 'POST', body: {} }); purgeLegacySensitiveLocalBackups(); toast('Oturumlar kapatıldı.'); setTimeout(() => location.reload(), 500); } catch (e) { toast(e.message); } });
  $('invalidateAllSessionsButton')?.addEventListener('click', async () => { if (!confirm('Tüm kullanıcıların tüm oturumları kapatılsın mı? Herkes yeniden giriş yapmak zorunda kalır.')) return; try { await api('/api/admin/security/invalidate-sessions', { method: 'POST', body: {} }); purgeLegacySensitiveLocalBackups(); toast('Tüm oturumlar sıfırlandı. Yeniden giriş yapman gerekecek.'); setTimeout(() => location.reload(), 700); } catch (e) { toast(e.message); } });
  $('downloadBackupButton')?.addEventListener('click', async () => {
    try { const response = await fetch('/api/admin/export', { credentials: 'same-origin' }); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Yedek indirilemedi.'); const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `gaycord-backup-${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(url); } catch (e) { toast(e.message); }
  });
  $('importBackupButton')?.addEventListener('click', async () => {
    const file = $('backupFileInput')?.files?.[0]; if (!file) return toast('Önce yedek dosyası seç.'); if (!confirm('Yedek yüklemek mevcut verinin üstüne yazar. Emin misin?')) return;
    try { await api('/api/admin/import', { method: 'POST', body: JSON.parse(await file.text()) }); toast('Yedek yüklendi. Sayfa yenileniyor.'); setTimeout(() => location.reload(), 900); } catch (e) { toast(e.message); }
  });
  els.settingsModal.showModal?.();
}

/* ===================== V7.6 Server Admin Panel (roles / private channels / moderation / audit) ===================== */
function canActOnRoleClient(myRole, targetRole) {
  if (targetRole === 'owner') return false;
  if (myRole === 'owner') return true;
  return (ROLE_RANK_CLIENT[myRole] || 0) > (ROLE_RANK_CLIENT[targetRole] || 0);
}
function openServerAdmin(serverId, activeTab = 'overview') {
  const server = state.servers.find((s) => s.id === serverId);
  if (!server) return toast('Sunucu bulunamadı.');
  const tabs = canManageServerClient(server)
    ? [['overview', 'Genel'], ['members', 'Üyeler'], ['channels', 'Kanallar'], ['moderation', 'Moderasyon'], ['audit', 'Denetim'], ['reports', 'Raporlar']]
    : [['moderation', 'Moderasyon'], ['audit', 'Denetim']]; // mods get a limited view
  if (!tabs.some(([k]) => k === activeTab)) activeTab = tabs[0][0];
  openDrawer('admin', `🛡 ${server.name} • Yönetim`, (body) => {
    const tabbar = document.createElement('div'); tabbar.className = 'admin-tabs';
    for (const [key, label] of tabs) {
      const b = document.createElement('button'); b.type = 'button'; b.className = `admin-tab ${key === activeTab ? 'active' : ''}`; b.textContent = label;
      b.addEventListener('click', () => openServerAdmin(serverId, key));
      tabbar.appendChild(b);
    }
    const content = document.createElement('div'); content.className = 'admin-tab-content';
    body.append(tabbar, content);
    renderAdminTab(content, server, activeTab);
  });
}
async function renderAdminTab(content, server, tab) {
  content.innerHTML = '<div class="empty-state compact">Yükleniyor…</div>';
  try {
    if (tab === 'overview') return renderAdminOverview(content, server);
    if (tab === 'members') return await renderAdminMembers(content, server);
    if (tab === 'channels') return renderAdminChannels(content, server);
    if (tab === 'moderation') return await renderAdminModeration(content, server);
    if (tab === 'audit') return await renderAdminAudit(content, server);
    if (tab === 'reports') return renderAdminReports(content);
  } catch (e) {
    content.innerHTML = '';
    const d = document.createElement('div'); d.className = 'empty-state compact'; d.textContent = e.message || 'Yüklenemedi.';
    content.appendChild(d);
  }
}
function renderAdminOverview(content, server) {
  const owner = (server.members || []).find((m) => m.id === server.ownerId || m.isOwner);
  const counts = { admin: 0, mod: 0 };
  for (const m of server.members || []) if (m.role === 'admin' || m.role === 'mod') counts[m.role] += 1;
  content.innerHTML = `
    <div class="info-card"><span class="avatar server">${escapeHTML(initials(server.name))}</span><span class="row-grow"><strong>${escapeHTML(server.name)}</strong><br><small>Sahip: ${escapeHTML(owner?.displayName || owner?.username || '—')}</small></span></div>
    <div class="admin-stat-grid">
      <div class="admin-stat"><strong>${server.memberCount || server.members?.length || 0}</strong><small>üye</small></div>
      <div class="admin-stat"><strong>${server.channelCount ?? server.channels?.length ?? 0}</strong><small>kanal</small></div>
      <div class="admin-stat"><strong>${counts.admin}</strong><small>admin</small></div>
      <div class="admin-stat"><strong>${counts.mod}</strong><small>mod</small></div>
    </div>
    <div class="section-title">Davet kodu</div>
    <div class="info-card"><span class="row-grow"><code>${escapeHTML(server.inviteCode)}</code></span></div>`;
}
async function renderAdminMembers(content, server) {
  const data = await api(`/api/servers/${server.id}/members`);
  const members = data.members || [];
  const isManager = canManageServerClient(server);
  const canModerate = canModerateServerClient(server);
  const myRole = serverRoleClient(server);
  content.innerHTML = members.length ? '' : '<div class="empty-state compact">Üye yok.</div>';
  for (const m of members) {
    const role = m.role || 'member';
    const card = document.createElement('div'); card.className = 'admin-member';
    const head = document.createElement('div'); head.className = 'admin-member-head';
    head.innerHTML = `<span class="avatar small ${m.online ? 'online' : ''}">${avatarInner(m)}</span><span class="row-grow"><strong>${escapeHTML(m.displayName || m.username)} <span class="role-badge role-${role}">${escapeHTML(ROLE_LABEL[role] || role)}</span>${m.timedOut ? ' <span class="role-badge role-timeout">⏳ timeout</span>' : ''}</strong><br><small>@${escapeHTML(m.username)} • ${m.online ? 'çevrimiçi' : 'çevrimdışı'}</small></span>`;
    card.appendChild(head);
    const actions = document.createElement('div'); actions.className = 'admin-member-actions';
    const actionable = m.id !== state.user?.id && role !== 'owner' && canActOnRoleClient(myRole, role);
    if (isManager && actionable) {
      const sel = document.createElement('select'); sel.className = 'admin-role-select'; sel.setAttribute('aria-label', 'Rol');
      for (const r of ['member', 'mod', 'admin']) {
        if (myRole !== 'owner' && (ROLE_RANK_CLIENT[r] || 0) >= (ROLE_RANK_CLIENT[myRole] || 0)) continue; // can't grant at/above own rank
        const opt = document.createElement('option'); opt.value = r; opt.textContent = ROLE_LABEL[r]; if (r === role) opt.selected = true; sel.appendChild(opt);
      }
      sel.addEventListener('change', async () => {
        try { await api(`/api/servers/${server.id}/members/${m.id}/role`, { method: 'PATCH', body: { role: sel.value } }); toast(`${m.displayName || m.username} → ${ROLE_LABEL[sel.value]}`); await refreshMe({ keepPanel: true }); openServerAdmin(server.id, 'members'); }
        catch (e) { toast(e.message); }
      });
      actions.appendChild(sel);
    }
    if (canModerate && actionable) {
      if (m.timedOut) { const b = document.createElement('button'); b.type = 'button'; b.className = 'mini-button'; b.textContent = 'Timeout kaldır'; b.addEventListener('click', () => removeTimeout(server, m)); actions.appendChild(b); }
      else { const b = document.createElement('button'); b.type = 'button'; b.className = 'mini-button warn'; b.textContent = 'Timeout'; b.addEventListener('click', () => timeoutMember(server, m)); actions.appendChild(b); }
      const k = document.createElement('button'); k.type = 'button'; k.className = 'mini-button danger'; k.textContent = 'At'; k.addEventListener('click', () => kickMember(server, m)); actions.appendChild(k);
      if (isManager) { const ban = document.createElement('button'); ban.type = 'button'; ban.className = 'mini-button danger'; ban.textContent = 'Yasakla'; ban.addEventListener('click', () => banMember(server, m)); actions.appendChild(ban); }
    }
    if (actions.childElementCount) card.appendChild(actions);
    content.appendChild(card);
  }
}
function renderAdminChannels(content, server) {
  const list = server.channels || [];
  content.innerHTML = list.length ? '' : '<div class="empty-state compact">Kanal yok.</div>';
  for (const ch of list) {
    const card = document.createElement('div'); card.className = 'info-card';
    card.innerHTML = `<span class="avatar">${ch.kind === 'voice' ? '🔊' : '#'}</span><span class="row-grow"><strong>${escapeHTML(ch.name)} ${ch.private ? '🔒' : ''}</strong><br><small>${ch.private ? 'özel' : 'herkese açık'} • ${ch.kind === 'voice' ? 'ses' : 'metin'}</small></span>`;
    if (canManageServerClient(server)) { const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'mini-button'; edit.textContent = 'İzinler'; edit.addEventListener('click', () => openChannelPrivacy(server, ch)); card.appendChild(edit); }
    content.appendChild(card);
  }
}
async function renderAdminModeration(content, server) {
  const [membersData, ] = await Promise.all([api(`/api/servers/${server.id}/members`).catch(() => ({ members: [], bans: [] }))]);
  const timedOut = (membersData.members || []).filter((m) => m.timedOut);
  const bans = membersData.bans || [];
  content.innerHTML = '';
  const t1 = document.createElement('div'); t1.className = 'section-title'; t1.textContent = 'Zaman aşımındaki üyeler'; content.appendChild(t1);
  if (!timedOut.length) { const e = document.createElement('div'); e.className = 'empty-state compact'; e.textContent = 'Şu an timeout’ta üye yok.'; content.appendChild(e); }
  for (const m of timedOut) {
    const card = document.createElement('div'); card.className = 'info-card';
    card.innerHTML = `<span class="avatar small">${avatarInner(m)}</span><span class="row-grow"><strong>${escapeHTML(m.displayName || m.username)}</strong><br><small>bitiş: ${escapeHTML(formatTime(m.timeoutUntil))}</small></span>`;
    if (canModerateServerClient(server)) { const r = document.createElement('button'); r.type = 'button'; r.className = 'mini-button'; r.textContent = 'Kaldır'; r.addEventListener('click', () => removeTimeout(server, m)); card.appendChild(r); }
    content.appendChild(card);
  }
  if (canManageServerClient(server)) {
    const t2 = document.createElement('div'); t2.className = 'section-title'; t2.textContent = 'Yasaklılar'; content.appendChild(t2);
    if (!bans.length) { const e = document.createElement('div'); e.className = 'empty-state compact'; e.textContent = 'Yasaklı üye yok.'; content.appendChild(e); }
    for (const b of bans) {
      const card = document.createElement('div'); card.className = 'info-card';
      card.innerHTML = `<span class="avatar small">${avatarInner(b.user || {})}</span><span class="row-grow"><strong>${escapeHTML(b.user?.displayName || b.user?.username || b.user?.id || '?')}</strong><br><small>${escapeHTML(b.reason || 'sebep belirtilmemiş')}</small></span>`;
      const u = document.createElement('button'); u.type = 'button'; u.className = 'mini-button'; u.textContent = 'Yasağı kaldır';
      u.addEventListener('click', async () => { try { await api(`/api/servers/${server.id}/bans/${b.user.id}`, { method: 'DELETE', body: {} }); toast('Yasak kaldırıldı.'); openServerAdmin(server.id, 'moderation'); } catch (e) { toast(e.message); } });
      card.appendChild(u); content.appendChild(card);
    }
  }
}
function auditLabel(e) {
  const actor = e.actor?.displayName || e.actor?.username || 'Birisi';
  const target = e.target?.displayName || e.target?.username || '';
  const d = e.details || {};
  switch (e.type) {
    case 'role_updated': return `${actor}, ${target} kişisinin rolünü ${ROLE_LABEL[d.role] || d.role} yaptı`;
    case 'member_kicked': return `${actor}, ${target} kişisini sunucudan attı`;
    case 'member_banned': return `${actor}, ${target} kişisini yasakladı`;
    case 'member_unbanned': return `${actor}, ${target} kişisinin yasağını kaldırdı`;
    case 'member_timed_out': return `${actor}, ${target} kişisine ${d.minutes || ''}dk timeout verdi`;
    case 'member_timeout_removed': return `${actor}, ${target} kişisinin timeout’unu kaldırdı`;
    case 'channel_created': return `${actor}, #${d.channel || ''} kanalını oluşturdu`;
    case 'channel_deleted': return `${actor}, #${d.channel || ''} kanalını sildi`;
    case 'channel_privacy_updated': return `${actor}, #${d.channel || ''} kanalını ${d.private ? 'özel' : 'herkese açık'} yaptı`;
    case 'server_updated': return `${actor}, sunucu adını “${d.name || ''}” yaptı`;
    case 'invite_regenerated': return `${actor}, davet kodunu yeniledi`;
    case 'message_deleted_by_moderator': return `${actor}, ${target} kişisinin mesajını sildi (#${d.channel || ''})`;
    case 'pin_added': return `${actor}, #${d.channel || ''} kanalında mesaj sabitledi`;
    case 'pin_removed': return `${actor}, #${d.channel || ''} kanalında sabiti kaldırdı`;
    default: return `${actor}: ${e.type}`;
  }
}
async function renderAdminAudit(content, server) {
  const data = await api(`/api/servers/${server.id}/audit-log`);
  const entries = data.auditLog || [];
  content.innerHTML = entries.length ? '' : '<div class="empty-state compact">Henüz audit log yok.</div>';
  for (const e of entries) {
    const row = document.createElement('div'); row.className = 'audit-row';
    const text = document.createElement('div'); text.className = 'audit-text'; text.textContent = auditLabel(e);
    const time = document.createElement('time'); time.textContent = formatTime(e.createdAt);
    row.append(text, time); content.appendChild(row);
  }
}
function renderAdminReports(content) {
  content.innerHTML = '<div class="empty-state compact">Bu sunucuda yönetilecek rapor yok.</div>';
}
async function kickMember(server, m) {
  if (!confirm(`${m.displayName || m.username} sunucudan atılsın mı?`)) return;
  try { await api(`/api/servers/${server.id}/members/${m.id}/kick`, { method: 'POST', body: {} }); toast(`${m.displayName || m.username} atıldı.`); await refreshMe({ keepPanel: true }); openServerAdmin(server.id, 'members'); } catch (e) { toast(e.message); }
}
async function banMember(server, m) {
  if (!confirm(`${m.displayName || m.username} yasaklansın mı? Tekrar katılamaz.`)) return;
  const reason = prompt('Yasak sebebi (opsiyonel):', '');
  if (reason === null) return;
  try { await api(`/api/servers/${server.id}/members/${m.id}/ban`, { method: 'POST', body: { reason } }); toast(`${m.displayName || m.username} yasaklandı.`); await refreshMe({ keepPanel: true }); openServerAdmin(server.id, 'members'); } catch (e) { toast(e.message); }
}
async function timeoutMember(server, m) {
  const minsRaw = prompt('Kaç dakika timeout? (1-10080)', '10');
  if (minsRaw === null) return;
  const minutes = Number(minsRaw);
  if (!Number.isFinite(minutes) || minutes < 1) return toast('Geçerli bir dakika gir.');
  try { await api(`/api/servers/${server.id}/members/${m.id}/timeout`, { method: 'POST', body: { minutes } }); toast(`${m.displayName || m.username} ${minutes}dk timeout aldı.`); await refreshMe({ keepPanel: true }); openServerAdmin(server.id, 'members'); } catch (e) { toast(e.message); }
}
async function removeTimeout(server, m) {
  try { await api(`/api/servers/${server.id}/members/${m.id}/timeout`, { method: 'DELETE', body: {} }); toast('Timeout kaldırıldı.'); await refreshMe({ keepPanel: true }); openServerAdmin(server.id, 'members'); } catch (e) { toast(e.message); }
}
function openChannelPrivacy(server, channel) {
  openDrawer('channel-perms', `⚙ #${channel.name} • İzinler`, async (body) => {
    body.innerHTML = '<div class="empty-state compact">Yükleniyor…</div>';
    let perms;
    try { perms = await api(`/api/servers/${server.id}/channels/${channel.id}/permissions`); }
    catch (e) { body.innerHTML = ''; const d = document.createElement('div'); d.className = 'empty-state compact'; d.textContent = e.message; body.appendChild(d); return; }
    const members = server.members || [];
    body.innerHTML = `
      <label class="toggle-row"><input id="permPrivate" type="checkbox" ${perms.private ? 'checked' : ''}> Özel kanal (sadece izinli rol/kişiler görür)</label>
      <div class="section-title">İzinli roller</div>
      <div id="permRoles" class="perm-roles">${['admin', 'mod', 'member'].map((r) => `<label class="check-row"><input type="checkbox" data-role="${r}" ${(perms.allowedRoles || []).includes(r) ? 'checked' : ''}> ${escapeHTML(ROLE_LABEL[r])}</label>`).join('')}</div>
      <small class="perm-note">Sahip ve adminler özel kanallara her zaman erişir.</small>
      <div class="section-title">İzinli kişiler</div>
      <div id="permUsers" class="perm-users"></div>
      <div class="wrap-actions"><button id="permSave" class="primary" type="button">Kaydet</button></div>`;
    const usersWrap = body.querySelector('#permUsers');
    const allowedSet = new Set(perms.allowedUserIds || []);
    for (const m of members) {
      if (m.role === 'owner') continue;
      const label = document.createElement('label'); label.className = 'check-row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.user = m.id; if (allowedSet.has(m.id)) cb.checked = true;
      label.appendChild(cb); label.appendChild(document.createTextNode(` ${m.displayName || m.username} (${ROLE_LABEL[m.role || 'member']})`));
      usersWrap.appendChild(label);
    }
    if (!members.length) usersWrap.innerHTML = '<div class="empty-state compact">Üye yok.</div>';
    body.querySelector('#permSave').addEventListener('click', async () => {
      const isPrivate = body.querySelector('#permPrivate').checked;
      const allowedRoles = [...body.querySelectorAll('#permRoles input[data-role]')].filter((c) => c.checked).map((c) => c.dataset.role);
      const allowedUserIds = [...usersWrap.querySelectorAll('input[data-user]')].filter((c) => c.checked).map((c) => c.dataset.user);
      try {
        const data = await api(`/api/servers/${server.id}/channels/${channel.id}/privacy`, { method: 'PATCH', body: { private: isPrivate, allowedRoles, allowedUserIds } });
        replaceServer(data.server); toast(isPrivate ? 'Kanal özel yapıldı. 🔒' : 'Kanal herkese açık yapıldı.'); closeDrawer();
        if (state.currentServerId === server.id) renderServerPanel(server.id);
      } catch (e) { toast(e.message); }
    });
  });
}

/* ===================== V7.4 Safe Social Content Pack (client) ===================== */
let currentDrawerKind = null;

function setAvatar(el, user) {
  if (!el) return;
  const url = safeMediaUrl(user?.avatarUrl);
  if (url) { el.innerHTML = ''; const img = document.createElement('img'); img.src = url; img.alt = ''; img.loading = 'lazy'; el.appendChild(img); }
  else el.textContent = initials(user?.displayName || user?.username || '?');
}

function closeContextMenu() { document.getElementById('gcContextMenu')?.remove(); }
function openContextMenu(x, y, sections) {
  closeContextMenu();
  const menu = document.createElement('div'); menu.id = 'gcContextMenu'; menu.className = 'context-menu';
  for (const section of sections) {
    if (section.reactions) {
      const row = document.createElement('div'); row.className = 'context-reactions';
      for (const emoji of REACTION_EMOJIS) { const b = document.createElement('button'); b.type = 'button'; b.className = 'context-emoji'; b.textContent = emoji; b.addEventListener('click', () => { closeContextMenu(); section.onReact?.(emoji); }); row.appendChild(b); }
      menu.appendChild(row); continue;
    }
    if (section.separator) { const s = document.createElement('div'); s.className = 'context-sep'; menu.appendChild(s); continue; }
    const b = document.createElement('button'); b.type = 'button'; b.className = `context-item${section.danger ? ' danger' : ''}`; b.textContent = section.label;
    b.addEventListener('click', () => { closeContextMenu(); section.onClick?.(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  setTimeout(() => {
    const onClose = (event) => { if (!menu.contains(event.target)) { closeContextMenu(); document.removeEventListener('mousedown', onClose); document.removeEventListener('touchstart', onClose); } };
    document.addEventListener('mousedown', onClose);
    document.addEventListener('touchstart', onClose);
  }, 0);
}

function getArticleMessage(article) { try { return JSON.parse(article?.dataset?.messageJson || 'null'); } catch { return null; } }
function canEditMessageClient(message) { return message.user?.id === state.user?.id && message.type === 'text' && !message.encrypted; }
// ---- V7.6 client role helpers (mirror server policy; server re-checks everything) ----
const ROLE_LABEL = { owner: 'Sahip', admin: 'Admin', mod: 'Mod', member: 'Üye' };
const ROLE_RANK_CLIENT = { owner: 3, admin: 2, mod: 1, member: 0 };
function serverRoleClient(server) {
  if (!server) return 'member';
  if (server.myRole) return server.myRole;
  return (server.isOwner || server.ownerId === state.user?.id) ? 'owner' : 'member';
}
function canManageServerClient(server) { return Boolean(server && (server.canManage || server.isOwner || server.ownerId === state.user?.id)); }
function canModerateServerClient(server) { return Boolean(server && (server.canModerate || canManageServerClient(server))); }
function currentServerObj() { return state.servers.find((s) => s.id === state.currentServerId) || null; }
function canDeleteMessageClient(message) {
  if (message.user?.id === state.user?.id) return true;
  return Boolean(state.view === 'server' && canModerateServerClient(currentServerObj()));
}
function canManagePinsClient() {
  if (state.currentDmFriend) return true;
  return canModerateServerClient(currentServerObj());
}
function messageMenuFor(message, x, y) {
  if (!message) return;
  const sections = [{ reactions: true, onReact: (emoji) => toggleReaction(message, emoji) },
    { label: '↩︎ Yanıtla', onClick: () => startReply(message) },
    { label: '🔖 Kaydet', onClick: () => addBookmark(message) }];
  if (canManagePinsClient()) sections.push({ label: '📌 Sabitle', onClick: () => pinMessage(message) });
  if (!message.encrypted && message.type === 'text') sections.push({ label: '📋 Kopyala', onClick: () => copyMessageText(message.text || '') });
  sections.push({ label: '👤 Profil', onClick: () => openProfile(message.user?.id) });
  if (canEditMessageClient(message)) sections.push({ label: '✏️ Düzenle', onClick: () => startEdit(message) });
  if (canDeleteMessageClient(message)) sections.push({ separator: true }, { label: '🗑 Sil', danger: true, onClick: () => deleteMessage(message) });
  openContextMenu(x, y, sections);
}

async function toggleReaction(message, emoji) { try { await api(`/api/channels/${message.channelId}/messages/${message.id}/reactions`, { method: 'POST', body: { emoji } }); } catch (e) { toast(e.message); } }
async function pinMessage(message) { try { await api(`/api/channels/${message.channelId}/pins/${message.id}`, { method: 'POST', body: {} }); toast('Mesaj sabitlendi. 📌'); } catch (e) { toast(e.message); } }
async function addBookmark(message) { try { await api('/api/bookmarks', { method: 'POST', body: { channelId: message.channelId, messageId: message.id } }); toast('Kaydedildi. 🔖'); } catch (e) { toast(e.message); } }
async function copyMessageText(text) { try { await navigator.clipboard.writeText(text); toast('Kopyalandı.'); } catch { toast('Kopyalanamadı.'); } }
async function deleteMessage(message) { if (!confirm('Bu mesaj silinsin mi?')) return; try { await api(`/api/channels/${message.channelId}/messages/${message.id}`, { method: 'DELETE', body: {} }); } catch (e) { toast(e.message); } }
function startEdit(message) {
  const next = prompt('Mesajı düzenle:', message.text || '');
  if (next === null) return;
  const text = next.trim();
  if (!text) return toast('Boş mesaj olamaz.');
  api(`/api/channels/${message.channelId}/messages/${message.id}`, { method: 'PATCH', body: { text } }).catch((e) => toast(e.message));
}

function startReply(message) {
  state.replyTo = { id: message.id, name: message.user?.displayName || message.user?.username || 'mesaj', text: message.encrypted ? '🔒 şifreli mesaj' : (message.text || (message.type === 'voice' ? '🎙️ sesli mesaj' : message.type === 'file' ? `📎 ${message.fileName || 'dosya'}` : '')) };
  renderReplyBar();
  els.messageInput?.focus();
}
function cancelReply() { state.replyTo = null; renderReplyBar(); }
function consumeReplyTo() { return state.replyTo?.id || null; }
function clearReplyAfterSend() { if (state.replyTo) { state.replyTo = null; renderReplyBar(); } }
function renderReplyBar() {
  if (!els.replyBar) return;
  if (!state.replyTo) { els.replyBar.classList.add('hidden'); return; }
  els.replyBar.classList.remove('hidden');
  if (els.replyBarText) els.replyBarText.innerHTML = `<strong>↩︎ ${escapeHTML(state.replyTo.name)}</strong> <span>${escapeHTML(String(state.replyTo.text || '').slice(0, 80))}</span>`;
}

function replyPreviewEl(message) {
  const rp = message.replyPreview;
  if (!rp) return null;
  const el = document.createElement('button'); el.type = 'button'; el.className = 'reply-preview';
  const name = rp.user?.displayName || rp.user?.username || (rp.deleted ? 'silinmiş' : 'mesaj');
  const text = rp.deleted ? 'mesaj silindi' : (rp.encrypted ? '🔒 şifreli mesaj' : (rp.text || ''));
  el.innerHTML = `<span class="reply-preview-name">↩︎ ${escapeHTML(name)}</span><span class="reply-preview-text">${escapeHTML(String(text).slice(0, 90))}</span>`;
  el.addEventListener('click', () => jumpToMessage(rp.id));
  return el;
}
function reactionsRowEl(message) {
  const reactions = Array.isArray(message.reactions) ? message.reactions : [];
  if (!reactions.length) return null;
  const row = document.createElement('div'); row.className = 'reactions-row';
  for (const r of reactions) {
    const mine = Array.isArray(r.userIds) && r.userIds.includes(state.user?.id);
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = `reaction-chip${mine ? ' mine' : ''}`;
    chip.textContent = `${r.emoji} ${r.count}`;
    chip.addEventListener('click', () => toggleReaction(message, r.emoji));
    row.appendChild(chip);
  }
  return row;
}
function decorateBubble(bubble, message) {
  if (!bubble) return;
  const rp = replyPreviewEl(message);
  if (rp) bubble.insertBefore(rp, bubble.firstChild);
  if (message.editedAt) { const body = bubble.querySelector('.message-body'); if (body && !body.querySelector('.edited-tag')) { const ed = document.createElement('span'); ed.className = 'edited-tag'; ed.textContent = ' (düzenlendi)'; body.appendChild(ed); } }
  const rr = reactionsRowEl(message); if (rr) bubble.appendChild(rr);
}
function decorateArticle(article, message) {
  article.dataset.messageJson = JSON.stringify(message);
  if (!article.querySelector('.msg-actions-btn')) {
    const actions = document.createElement('button'); actions.type = 'button'; actions.className = 'msg-actions-btn'; actions.textContent = '⋯'; actions.title = 'İşlemler';
    actions.addEventListener('click', (event) => { event.stopPropagation(); const r = actions.getBoundingClientRect(); messageMenuFor(getArticleMessage(article) || message, r.right, r.bottom); });
    article.appendChild(actions);
    article.addEventListener('contextmenu', (event) => { event.preventDefault(); messageMenuFor(getArticleMessage(article) || message, event.clientX, event.clientY); });
  }
}
function updateMessageInDom(message) {
  if (!message || message.channelId !== state.currentChannelId) return;
  const existing = els.messages.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  if (!existing) return; // update for a message not in the loaded window — ignore (do not append out of order)
  const rebuilt = buildArticle(message);
  if (rebuilt) existing.replaceWith(rebuilt);
}
function removeMessageFromDom(messageId) {
  els.messages.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)?.remove();
}
function jumpToMessage(messageId) {
  closeDrawer();
  const target = els.messages.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (target) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1100); }
  else toast('Mesaj bu görünümde değil.');
}

/* ---- Profile card ---- */
async function openProfile(userId) {
  if (!userId) return;
  try { const data = await api(`/api/users/${userId}/profile`); renderProfileModal(data.profile || {}); } catch (e) { toast(e.message); }
}
function renderProfileModal(p) {
  document.getElementById('gcProfile')?.remove();
  const overlay = document.createElement('div'); overlay.id = 'gcProfile'; overlay.className = 'modal-overlay';
  overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });
  const created = p.createdAt ? new Date(p.createdAt).toLocaleDateString('tr-TR') : '';
  const avatarSafe = safeMediaUrl(p.avatarUrl);
  const bannerSafe = safeMediaUrl(p.bannerUrl);
  const avatar = avatarSafe ? `<img class="profile-avatar" src="${avatarSafe}" alt="">` : `<div class="profile-avatar initials">${escapeHTML(initials(p.displayName || p.username))}</div>`;
  const card = document.createElement('div'); card.className = 'profile-card';
  card.innerHTML = `
    <div class="profile-banner"${bannerSafe ? ` style="background-image:url('${bannerSafe}')"` : ''}></div>
    <div class="profile-body">
      ${avatar}
      <h3>${escapeHTML(p.displayName || p.username || '')}</h3>
      <small>@${escapeHTML(p.username || '')}${p.online ? ' • çevrimiçi' : ''}</small>
      ${p.status ? `<p class="profile-status">${escapeHTML(p.status)}</p>` : ''}
      ${p.bio ? `<p class="profile-bio">${escapeHTML(p.bio)}</p>` : ''}
      <div class="profile-facts"><span>📅 Katıldı: ${escapeHTML(created)}</span><span>🤝 ${Number(p.mutualServers || 0)} ortak sunucu</span></div>
      <button class="ghost full profile-close" type="button">Kapat</button>
    </div>`;
  card.querySelector('.profile-close')?.addEventListener('click', () => overlay.remove());
  overlay.appendChild(card); document.body.appendChild(overlay);
}

/* ---- Drawers (pins, media, bookmarks, notifications) ---- */
function closeDrawer() { document.getElementById('gcDrawer')?.remove(); currentDrawerKind = null; }
function openDrawer(kind, title, build) {
  closeDrawer();
  currentDrawerKind = kind;
  const overlay = document.createElement('div'); overlay.id = 'gcDrawer'; overlay.className = 'drawer-overlay'; overlay.dataset.kind = kind;
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closeDrawer(); });
  const panel = document.createElement('aside'); panel.className = 'drawer-panel';
  const header = document.createElement('header'); header.className = 'drawer-head';
  const h = document.createElement('strong'); h.textContent = title; header.appendChild(h);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.textContent = '✕'; close.addEventListener('click', closeDrawer); header.appendChild(close);
  const body = document.createElement('div'); body.className = 'drawer-body';
  panel.append(header, body); overlay.appendChild(panel); document.body.appendChild(overlay);
  build(body);
}
async function decryptCardText(message) {
  if (!message.encrypted || !message.e2ee || !e2eePassphrase(message.channelId)) return null;
  try { if (message.e2ee.mode === 'attachment') return '🔒📎 şifreli ek (anahtar var)'; const payload = await decryptPayload(message.channelId, message.e2ee); return `🔒 ${payload.text || ''}`; } catch { return null; }
}
function savedCard(message, extra = {}) {
  const card = document.createElement('div'); card.className = 'saved-card';
  const head = document.createElement('div'); head.className = 'saved-card-head';
  head.innerHTML = `<span class="saved-author">${escapeHTML(message.user?.displayName || message.user?.username || '?')}</span><time>${escapeHTML(formatTime(message.createdAt))}</time>`;
  card.appendChild(head);
  if (extra.channelName) { const ch = document.createElement('small'); ch.className = 'saved-channel'; ch.textContent = extra.channelName; card.appendChild(ch); }
  const body = document.createElement('div'); body.className = 'saved-body';
  if (message.encrypted) body.textContent = '🔒 Şifreli mesaj — açmak için kanalın E2EE anahtarı gerekli.';
  else if (message.type === 'file') body.textContent = `📎 ${message.fileName || 'dosya'}`;
  else if (message.type === 'voice') body.textContent = '🎙️ sesli mesaj';
  else body.textContent = message.text || '';
  card.appendChild(body);
  if (message.encrypted) decryptCardText(message).then((t) => { if (t) body.textContent = t; });
  const actions = document.createElement('div'); actions.className = 'saved-actions';
  if (extra.onJump) { const jump = document.createElement('button'); jump.type = 'button'; jump.className = 'mini-button'; jump.textContent = 'Mesaja git'; jump.addEventListener('click', extra.onJump); actions.appendChild(jump); }
  if (extra.onRemove) { const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'mini-button danger'; rm.textContent = extra.removeLabel || 'Kaldır'; rm.addEventListener('click', extra.onRemove); actions.appendChild(rm); }
  if (actions.childElementCount) card.appendChild(actions);
  return card;
}
async function openPinsDrawer() {
  if (!state.currentChannelId) return toast('Önce bir kanal seç.');
  openDrawer('pins', '📌 Sabitlenen mesajlar', async (body) => {
    body.innerHTML = '<div class="empty-state compact">Yükleniyor…</div>';
    try {
      const data = await api(`/api/channels/${state.currentChannelId}/pins`);
      const canManage = data.canManage;
      body.innerHTML = (data.pins || []).length ? '' : '<div class="empty-state compact">Sabitlenen mesaj yok.</div>';
      for (const message of data.pins || []) {
        body.appendChild(savedCard(message, { onJump: () => jumpToMessage(message.id), onRemove: canManage ? async () => { try { await api(`/api/channels/${message.channelId}/pins/${message.id}`, { method: 'DELETE', body: {} }); openPinsDrawer(); } catch (e) { toast(e.message); } } : null, removeLabel: 'Kaldır' }));
      }
    } catch (e) { body.innerHTML = `<div class="empty-state compact">${escapeHTML(e.message)}</div>`; }
  });
}
function mediaCard(message) {
  const card = document.createElement('div'); card.className = 'media-card';
  if (message.encrypted) { card.innerHTML = '<div class="media-locked">🔒</div><small>Şifreli ek</small>'; return card; }
  const mime = String(message.mimeType || '').toLowerCase();
  const url = absoluteUrl(message.fileUrl || message.audioUrl);
  if (mime.startsWith('image/')) { const img = document.createElement('img'); img.src = url; img.loading = 'lazy'; img.alt = message.fileName || ''; img.addEventListener('click', () => window.open(url, '_blank', 'noopener')); card.appendChild(img); }
  else if (mime.startsWith('video/')) { const v = document.createElement('video'); v.src = url; v.controls = true; v.preload = 'metadata'; card.appendChild(v); }
  else if (mime.startsWith('audio/') || message.type === 'voice') { const a = document.createElement('audio'); a.src = url; a.controls = true; a.preload = 'none'; card.appendChild(a); }
  else { const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.className = 'media-file'; link.textContent = `📎 ${message.fileName || 'dosya'}`; card.appendChild(link); }
  return card;
}
async function openMediaDrawer() {
  if (!state.currentChannelId) return toast('Önce bir kanal seç.');
  openDrawer('media', '🖼 Medya galerisi', async (body) => {
    body.innerHTML = '<div class="empty-state compact">Yükleniyor…</div>';
    try {
      const data = await api(`/api/channels/${state.currentChannelId}/media`);
      const items = data.media || [];
      body.innerHTML = '';
      if (!items.length) { body.innerHTML = '<div class="empty-state compact">Bu kanalda medya yok.</div>'; return; }
      const grid = document.createElement('div'); grid.className = 'media-grid';
      for (const message of items) grid.appendChild(mediaCard(message));
      body.appendChild(grid);
    } catch (e) { body.innerHTML = `<div class="empty-state compact">${escapeHTML(e.message)}</div>`; }
  });
}
async function openBookmarksDrawer() {
  openDrawer('bookmarks', '🔖 Kaydedilen mesajlar', async (body) => {
    body.innerHTML = '<div class="empty-state compact">Yükleniyor…</div>';
    try {
      const data = await api('/api/bookmarks');
      const items = data.bookmarks || [];
      body.innerHTML = items.length ? '' : '<div class="empty-state compact">Kaydedilen mesaj yok.</div>';
      for (const message of items) {
        body.appendChild(savedCard(message, { channelName: message.channelName, onJump: message.channelId === state.currentChannelId ? () => jumpToMessage(message.id) : null, onRemove: async () => { try { await api(`/api/bookmarks/${message.id}`, { method: 'DELETE', body: {} }); openBookmarksDrawer(); } catch (e) { toast(e.message); } }, removeLabel: 'Sil' }));
      }
    } catch (e) { body.innerHTML = `<div class="empty-state compact">${escapeHTML(e.message)}</div>`; }
  });
}
function openChannelById(channelId) {
  for (const server of state.servers) {
    const channel = (server.channels || []).find((c) => c.id === channelId);
    if (channel) { openChannel(channel, { title: `${channel.kind === 'voice' ? '🔊' : '#'} ${channel.name}`, subtitle: `${server.name}`, inviteCode: server.inviteCode, serverId: server.id }); return; }
  }
  toast('Bu sohbeti açmak için ilgili sunucuya/DM\'e geç.');
}
function openNotificationsDrawer() {
  openDrawer('notifications', '🔔 Bildirimler', (body) => {
    body.innerHTML = '';
    const fr = state.notify.friendRequests || 0;
    if (fr) { const c = document.createElement('button'); c.type = 'button'; c.className = 'notif-item'; c.innerHTML = `<strong>👋 ${fr} arkadaşlık isteği</strong><span>Arkadaşlar sekmesinde yanıtla.</span>`; c.addEventListener('click', () => { closeDrawer(); renderFriendsPanel(); }); body.appendChild(c); }
    const items = state.notify.items || [];
    if (!items.length && !fr) { body.innerHTML = '<div class="empty-state compact">Yeni bildirim yok.</div>'; return; }
    for (const item of items) {
      const c = document.createElement('button'); c.type = 'button'; c.className = 'notif-item';
      const who = item.from?.displayName || item.from?.username || 'Biri';
      c.innerHTML = `<strong>${item.kind === 'mention' ? '📣' : '✉️'} ${escapeHTML(who)}</strong><span>${escapeHTML(String(item.snippet || '').slice(0, 90))}</span>`;
      c.addEventListener('click', () => { closeDrawer(); openChannelById(item.channelId); });
      body.appendChild(c);
    }
  });
}

/* ---- Notification state ---- */
function totalNotifCount() { return (state.notify.total || 0) + (state.notify.friendRequests || 0); }
function renderNotifBadge() {
  if (!els.notifBadge) return;
  const n = totalNotifCount();
  els.notifBadge.textContent = n > 99 ? '99+' : String(n);
  els.notifBadge.classList.toggle('hidden', n <= 0);
}
async function loadNotifications() {
  try {
    const data = await api('/api/notifications');
    state.notify.unread = data.unread || {};
    state.notify.total = data.totalUnread || 0;
    state.notify.friendRequests = data.friendRequests || 0;
    renderNotifBadge();
  } catch {}
}
function pushNotify(item) {
  if (!item) return;
  state.notify.items.unshift({ ...item });
  if (state.notify.items.length > 50) state.notify.items = state.notify.items.slice(0, 50);
  if (item.channelId && item.channelId !== state.currentChannelId) {
    state.notify.unread[item.channelId] = (state.notify.unread[item.channelId] || 0) + 1;
    state.notify.total = (state.notify.total || 0) + 1;
    if (state.view === 'server') renderServerPanel(state.currentServerId);
    else if (state.view === 'home') renderFriendsPanel();
  }
  renderNotifBadge();
  const who = item.from?.displayName || item.from?.username || 'Biri';
  toast(item.kind === 'mention' ? `📣 ${who} senden bahsetti` : `✉️ ${who}: ${String(item.snippet || '').slice(0, 60)}`);
}
async function markChannelRead(channelId) {
  if (!channelId) return;
  if (state.notify.unread[channelId]) { state.notify.total = Math.max(0, (state.notify.total || 0) - state.notify.unread[channelId]); delete state.notify.unread[channelId]; renderNotifBadge(); }
  state.notify.items = (state.notify.items || []).filter((i) => i.channelId !== channelId);
  try { await api(`/api/channels/${channelId}/read`, { method: 'POST', body: {} }); } catch {}
}
function dmChannelIdFor(friendId) { return state.user ? `dm_${[state.user.id, friendId].sort().join('_')}` : ''; }
function unreadBadgeHTML(channelId) {
  const n = state.notify.unread?.[channelId] || 0;
  return n ? `<span class="unread-badge">${n > 99 ? '99+' : n}</span>` : '';
}

async function uploadProfileMedia(kind, file) {
  if (!file) return;
  if (!file.type?.startsWith('image/')) return toast('Lütfen bir görsel seç.');
  if (file.size > 8 * 1024 * 1024) return toast('Görsel 8 MB sınırını aşıyor.');
  try {
    const fileData = await fileToDataURL(file);
    const data = await api(`/api/me/${kind}`, { method: 'POST', body: { fileData, fileName: file.name || `${kind}.png`, mimeType: file.type } });
    state.user = { ...state.user, ...data.user };
    renderMe();
    toast(kind === 'avatar' ? 'Avatar güncellendi.' : 'Afiş güncellendi.');
  } catch (e) { toast(e.message); }
}

function wireEvents() {
  els.loginTab.addEventListener('click', () => setAuthMode('login'));
  els.registerTab.addEventListener('click', () => setAuthMode('register'));
  els.authForm.addEventListener('submit', async (event) => {
    event.preventDefault(); els.authSubmit.disabled = true;
    try { const endpoint = state.authMode === 'login' ? '/api/login' : '/api/register'; await api(endpoint, { method: 'POST', body: { username: els.usernameInput.value, displayName: els.displayNameInput.value, password: els.passwordInput.value } }); els.passwordInput.value = ''; enterApp(await api('/api/me')); }
    catch (e) { toast(e.message); } finally { els.authSubmit.disabled = false; }
  });
  els.restoreBackupFileButton?.addEventListener('click', () => els.bootstrapFileInput?.click());
  els.bootstrapFileInput?.addEventListener('change', async () => {
    const file = els.bootstrapFileInput.files?.[0];
    if (!file) return;
    try {
      await restoreBackupObject(JSON.parse(await file.text()));
      els.bootstrapFileInput.value = '';
    } catch (e) { toast(e.message); }
  });
  els.restoreLocalBackupButton?.addEventListener('click', async () => {
    try {
      const backup = getLocalBackup();
      if (!backup) return toast('Tarayıcıda yedek bulunamadı.');
      if (!confirm('Tarayıcıdaki son yedek geri yüklensin mi?')) return;
      await restoreBackupObject(backup);
    } catch (e) { toast(e.message); }
  });
  els.homeButton.addEventListener('click', renderFriendsPanel);
  els.settingsButton.addEventListener('click', showSettings);
  els.createServerButton.addEventListener('click', async () => { const name = prompt('Sunucu adı?', 'Bizim Ekip'); if (!name) return; try { const data = await api('/api/servers', { method: 'POST', body: { name } }); replaceServer(data.server); renderServerPanel(data.server.id); const first = data.server.channels?.find((c) => c.kind !== 'voice') || data.server.channels?.[0]; if (first) openChannel(first, { title: `${first.kind === 'voice' ? '🔊' : '#'} ${first.name}`, subtitle: `${data.server.name} • Davet kodu: ${data.server.inviteCode}`, inviteCode: data.server.inviteCode, serverId: data.server.id }); } catch (e) { toast(e.message); } });
  els.joinServerButton.addEventListener('click', async () => { const inviteCode = prompt('Davet kodu?'); if (!inviteCode) return; try { const data = await api('/api/servers/join', { method: 'POST', body: { inviteCode } }); replaceServer(data.server); renderServerPanel(data.server.id); toast('Sunucuya katıldın.'); } catch (e) { toast(e.message); } });
  els.logoutButton.addEventListener('click', async () => { discardRecording(); cleanupVoice({ manual: true }); state.e2ee.passphrases.clear(); state.e2ee.enabled.clear(); try { await api('/api/logout', { method: 'POST', body: {} }); } catch {} state.socket?.disconnect(); purgeLegacySensitiveLocalBackups(); state.user = null; showAuth(); });
  els.copyInviteButton.addEventListener('click', () => copyInvite());
  els.e2eeButton?.addEventListener('click', promptE2eeKey);
  els.notificationsButton?.addEventListener('click', openNotificationsDrawer);
  els.savedButton?.addEventListener('click', openBookmarksDrawer);
  els.pinsButton?.addEventListener('click', openPinsDrawer);
  els.mediaButton?.addEventListener('click', openMediaDrawer);
  els.replyCancelButton?.addEventListener('click', cancelReply);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeContextMenu(); closeDrawer(); document.getElementById('gcProfile')?.remove(); if (state.replyTo) cancelReply(); } });
  els.messageForm.addEventListener('submit', (event) => { event.preventDefault(); sendTextMessage(); });
  els.messageInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); sendTextMessage(); } });
  els.messageInput.addEventListener('input', () => { autoGrowInput(); syncComposerEnabled(); if (!state.currentChannelId || !state.socket?.connected) return; state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: true }); clearTimeout(state.typingTimeout); state.typingTimeout = setTimeout(() => state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: false }), 900); });
  els.recordButton.addEventListener('click', () => state.recorder ? stopRecording() : startRecording());
  els.fileButton.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', async () => { try { await sendFiles(els.fileInput.files); } finally { els.fileInput.value = ''; } });
  els.messages.addEventListener('dragover', (event) => { event.preventDefault(); els.messages.classList.add('drag-over'); });
  els.messages.addEventListener('dragleave', () => els.messages.classList.remove('drag-over'));
  els.messages.addEventListener('drop', (event) => { event.preventDefault(); els.messages.classList.remove('drag-over'); sendFiles(event.dataTransfer?.files); });
  document.addEventListener('paste', (event) => { const files = [...(event.clipboardData?.files || [])]; if (files.length && state.currentChannelId) sendFiles(files); });
}
async function bootstrap() {
  wireEvents(); setAuthMode('login'); resetChat(); refreshPublicStatus();
  state.voicePrefs = loadVoicePrefs();
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => { if (currentDrawerKind === 'voice') openVoiceSettings(); });
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { enterApp(await api('/api/me')); } catch { showAuth(); }
}
bootstrap();
