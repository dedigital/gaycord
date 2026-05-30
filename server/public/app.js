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
  publicDataStatus: $('publicDataStatus'), bootstrapRestoreWrap: $('bootstrapRestoreWrap'), restoreLocalBackupButton: $('restoreLocalBackupButton'), restoreBackupFileButton: $('restoreBackupFileButton'), bootstrapFileInput: $('bootstrapFileInput')
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
  e2ee: { passphrases: new Map(), enabled: new Set(), objectUrls: new Map() }
};

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
const VOICE_KEEPALIVE_MS = 27000;
const VOICE_RECONNECT_GRACE_MS = 90000;
const VOICE_ICE_RESTART_DELAY_MS = 5000;

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
  warnTemporaryStorageOnce();
  startAutoBackup();
}


function renderMe() {
  els.meAvatar.textContent = initials(state.user?.displayName || state.user?.username);
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
      els.membersList.innerHTML = `<div class="member-row"><span class="avatar ${state.onlineIds.has(f.id) ? 'online' : ''}">${escapeHTML(initials(f.displayName || f.username))}</span><span class="row-grow"><strong>${escapeHTML(f.displayName || f.username)}</strong><br><small>@${escapeHTML(f.username)} • ${state.onlineIds.has(f.id) ? 'çevrimiçi' : 'çevrimdışı'}</small></span></div>`;
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
    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML = `<span class="avatar ${member.online ? 'online' : ''}">${escapeHTML(initials(member.displayName || member.username))}</span><span class="row-grow"><strong>${escapeHTML(member.displayName || member.username)}</strong><br><small>@${escapeHTML(member.username)} ${(member.isOwner || member.owner) ? '• sahip' : ''} • ${member.online ? 'çevrimiçi' : 'çevrimdışı'}</small></span>`;
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
    article.classList.remove('secure-locked'); article.classList.add('secure-unlocked');
  } catch {
    article.classList.add('secure-locked'); article.classList.remove('secure-unlocked');
  }
}
function appendSecureMessage(message, { scroll = true } = {}) {
  if (!message || message.channelId !== state.currentChannelId) return;
  if (els.messages.querySelector('.empty-state')) els.messages.innerHTML = '';
  if (els.messages.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
  const article = document.createElement('article');
  article.className = `message secure-message ${message.user?.id === state.user?.id ? 'own' : ''}`;
  article.dataset.messageId = message.id;
  article.dataset.secureMessage = '1';
  article.dataset.messageJson = JSON.stringify(message);
  const avatar = document.createElement('div'); avatar.className = `avatar ${state.onlineIds.has(message.user?.id) || message.user?.online ? 'online' : ''}`; avatar.textContent = initials(message.user?.displayName || message.user?.username || '?');
  const bubble = document.createElement('div'); bubble.className = 'message-bubble';
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const name = document.createElement('strong'); name.textContent = message.user?.displayName || message.user?.username || 'Bilinmeyen';
  const time = document.createElement('time'); time.textContent = formatTime(message.createdAt); meta.append(name, time); bubble.appendChild(meta);
  const locked = document.createElement('div'); locked.className = 'secure-card'; locked.innerHTML = '<strong>🔒 Bu mesaj şifreli. Anahtar gir.</strong><small>Açmak için bu kanalın E2EE anahtarını gir. Server içeriği göremez.</small>';
  const unlock = document.createElement('button'); unlock.type = 'button'; unlock.className = 'mini-button'; unlock.textContent = 'Anahtar gir / çöz'; unlock.addEventListener('click', promptE2eeKey);
  locked.appendChild(unlock); bubble.appendChild(locked);
  article.append(avatar, bubble); els.messages.appendChild(article);
  if (e2eePassphrase(message.channelId)) renderDecryptedMessage(message, article);
  if (scroll) scrollMessages();
}

function appendMessage(message, { scroll = true } = {}) {
  if (message?.encrypted && message?.e2ee) return appendSecureMessage(message, { scroll });
  if (!message || message.channelId !== state.currentChannelId) return;
  if (els.messages.querySelector('.empty-state')) els.messages.innerHTML = '';
  if (els.messages.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
  const article = document.createElement('article');
  article.className = `message ${message.user?.id === state.user?.id ? 'own' : ''}`;
  article.dataset.messageId = message.id;
  const avatar = document.createElement('div');
  avatar.className = `avatar ${state.onlineIds.has(message.user?.id) || message.user?.online ? 'online' : ''}`;
  avatar.textContent = initials(message.user?.displayName || message.user?.username || '?');
  const bubble = document.createElement('div'); bubble.className = 'message-bubble';
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const name = document.createElement('strong'); name.textContent = message.user?.displayName || message.user?.username || 'Bilinmeyen';
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
  article.append(avatar, bubble); els.messages.appendChild(article); if (scroll) scrollMessages();
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
    button.innerHTML = `<span class="avatar ${state.onlineIds.has(friend.id) ? 'online' : ''}">${escapeHTML(initials(friend.displayName || friend.username))}</span><span class="row-grow"><strong>${escapeHTML(friend.displayName || friend.username)}</strong><br><small>@${escapeHTML(friend.username)} • ${state.onlineIds.has(friend.id) ? 'çevrimiçi' : 'çevrimdışı'}</small></span>`;
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
  els.dynamicPanel.innerHTML = `
    ${persistenceCardHTML()}
    <section class="stack panel-card"><div class="section-title">Sunucu</div><div class="info-card"><span class="avatar server">${escapeHTML(initials(server.name))}</span><span class="row-grow"><strong>${escapeHTML(server.name)}</strong><br><small>${server.memberCount || server.memberIds?.length || 0} üye • Davet: <code>${escapeHTML(server.inviteCode)}</code></small></span></div><div class="server-actions"><button id="copyInvitePanelButton" class="ghost" type="button">Davet kodunu kopyala</button>${isOwner ? '<button id="renameServerButton" class="ghost" type="button">Ad değiştir</button><button id="renewInviteButton" class="ghost" type="button">Davet kodunu yenile</button><button id="deleteServerButton" class="ghost danger" type="button">Sunucuyu sil</button>' : '<button id="leaveServerButton" class="ghost danger" type="button">Sunucudan çık</button>'}</div></section>
    <section class="stack"><div class="section-title-row"><div class="section-title">Metin kanalları</div>${isOwner ? '<button id="addTextChannelButton" class="mini-button">＋</button>' : ''}</div><div id="textChannelList"></div></section>
    <section class="stack"><div class="section-title-row"><div class="section-title">Ses kanalları</div>${isOwner ? '<button id="addVoiceChannelButton" class="mini-button">＋</button>' : ''}</div><div id="voiceChannelList"></div></section>`;
  renderChannelGroup(els.dynamicPanel.querySelector('#textChannelList'), (server.channels || []).filter((c) => c.kind !== 'voice'), server, isOwner);
  renderChannelGroup(els.dynamicPanel.querySelector('#voiceChannelList'), (server.channels || []).filter((c) => c.kind === 'voice'), server, isOwner);
  els.dynamicPanel.querySelector('#copyInvitePanelButton')?.addEventListener('click', () => copyInvite(server.inviteCode));
  els.dynamicPanel.querySelector('#renameServerButton')?.addEventListener('click', async () => { const name = prompt('Yeni sunucu adı?', server.name); if (!name) return; try { const data = await api(`/api/servers/${server.id}`, { method: 'PATCH', body: { name } }); replaceServer(data.server); renderServerPanel(server.id); } catch (e) { toast(e.message); } });
  els.dynamicPanel.querySelector('#renewInviteButton')?.addEventListener('click', async () => { if (!confirm('Davet kodu yenilensin mi? Eski kod çalışmaz.')) return; try { const data = await api(`/api/servers/${server.id}`, { method: 'PATCH', body: { regenerateInvite: true } }); replaceServer(data.server); renderServerPanel(server.id); toast(`Yeni kod: ${data.server.inviteCode}`); } catch (e) { toast(e.message); } });
  els.dynamicPanel.querySelector('#deleteServerButton')?.addEventListener('click', () => deleteServer(server));
  els.dynamicPanel.querySelector('#leaveServerButton')?.addEventListener('click', () => leaveServer(server));
  els.dynamicPanel.querySelector('#addTextChannelButton')?.addEventListener('click', () => createChannel(server, 'text'));
  els.dynamicPanel.querySelector('#addVoiceChannelButton')?.addEventListener('click', () => createChannel(server, 'voice'));
}
function renderChannelGroup(container, channels, server, isOwner) {
  container.innerHTML = channels.length ? '' : '<div class="empty-state compact">Kanal yok.</div>';
  for (const channel of channels) {
    const row = document.createElement('div'); row.className = `channel-row ${state.currentChannelId === channel.id ? 'active' : ''}`;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'channel-main';
    button.innerHTML = `<span class="avatar">${channel.kind === 'voice' ? '🔊' : '#'}</span><span class="row-grow"><strong>${escapeHTML(channel.name)}</strong><br><small>${channel.kind === 'voice' ? 'sesli oda' : 'metin kanalı'}</small></span>`;
    button.addEventListener('click', () => openChannel(channel, { title: `${channel.kind === 'voice' ? '🔊' : '#'} ${channel.name}`, subtitle: `${server.name} • ${channel.kind === 'voice' ? 'canlı ses' : 'metin'} • Davet kodu: ${server.inviteCode}`, inviteCode: server.inviteCode, serverId: server.id }));
    row.appendChild(button);
    if (isOwner && server.channelIds?.length > 1) { const del = document.createElement('button'); del.type = 'button'; del.className = 'mini-button danger'; del.textContent = 'Sil'; del.addEventListener('click', () => deleteChannel(server, channel)); row.appendChild(del); }
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
  renderE2eeButton();
  syncComposerEnabled();
  els.messageInput.focus(); renderVoicePanel();
  if (state.socket?.connected) {
    state.socket.emit('channel:join', { channelId: channel.id }, (response) => { if (response?.error) return toast(response.error); renderMessages(response.messages || []); });
  } else {
    try { const data = await api(`/api/channels/${channel.id}/messages`); renderMessages(data.messages || []); } catch (e) { toast(e.message); }
  }
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
  state.socket.on('typing', ({ channelId, user, isTyping }) => { if (channelId !== state.currentChannelId || !isTyping || user?.id === state.user?.id) return; els.typingLine.textContent = `${user.displayName || user.username} yazıyor...`; clearTimeout(state.remoteTypingTimeout); state.remoteTypingTimeout = setTimeout(() => { els.typingLine.textContent = ''; }, 1500); });
  state.socket.on('server:updated', ({ server } = {}) => { if (!server) return; replaceServer(server); renderRail(); if (state.currentServerId === server.id) renderServerPanel(server.id); });
  state.socket.on('server:deleted', ({ serverId } = {}) => { state.servers = state.servers.filter((server) => server.id !== serverId); if (state.currentServerId === serverId) { cleanupVoice({ manual: true }); renderFriendsPanel(); resetChat('Sunucu silindi', 'Başka bir sunucu seç.'); } else renderRail(); });
  state.socket.on('channel:deleted', ({ channelId, serverId } = {}) => { if (state.voice.channelId === channelId) cleanupVoice({ manual: true }); if (state.currentChannelId === channelId) resetChat('Kanal silindi', 'Başka bir kanal seç.'); const server = state.servers.find((s) => s.id === serverId); if (server) server.channels = server.channels.filter((c) => c.id !== channelId); if (state.currentServerId === serverId) renderServerPanel(serverId); });
  state.socket.on('data:imported', () => { toast('Yedek yüklendi; sayfa yenileniyor.'); setTimeout(() => location.reload(), 900); });
  state.socket.on('voice:user_joined', ({ channelId, peer } = {}) => { if (channelId !== state.voice.channelId || !peer?.socketId || peer.socketId === state.voice.selfId) return; createPeer(peer.socketId, peer.user); renderVoicePanel(); });
  state.socket.on('voice:user_left', ({ socketId } = {}) => { if (socketId) closePeer(socketId); });
  state.socket.on('voice:members', ({ channelId, members } = {}) => { if (channelId !== state.voice.channelId) return; renderVoicePanel(members || null); });
  state.socket.on('voice:signal', handleVoiceSignal);
}

async function sendSecurePayload(payload) {
  if (!state.currentChannelId) return;
  const e2ee = await encryptPayload(state.currentChannelId, payload);
  const data = await api(`/api/channels/${state.currentChannelId}/messages`, { method: 'POST', body: { type: 'text', encrypted: true, e2ee } });
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
  if (state.socket?.connected) {
    const response = await emitWithTimeout('message:text', { channelId, text });
    if (response?.message) appendMessage(response.message); // render own message even if not in the room
    return;
  }
  const data = await api(`/api/channels/${channelId}/messages`, { method: 'POST', body: { type: 'text', text } });
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
      const response = await api(`/api/channels/${channelId}/messages`, { method: 'POST', body: { type: 'voice', audioData: encrypted.fileData, mimeType: 'application/octet-stream', fileName: 'encrypted-voice.gce', durationMs, encrypted: true, e2ee: encrypted.e2ee } });
      appendMessage(response.message);
      toast('Şifreli sesli mesaj gönderildi.');
    } else {
      const response = await api(`/api/channels/${channelId}/messages`, { method: 'POST', body: { type: 'voice', audioData: dataUrl, mimeType: 'audio/wav', fileName: 'voice.wav', durationMs } });
      appendMessage(response.message);
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
      const data = await api(`/api/channels/${state.currentChannelId}/messages`, { method: 'POST', body: { type: 'file', fileData: encrypted.fileData, fileName: 'encrypted-file.gce', mimeType: 'application/octet-stream', encrypted: true, e2ee: encrypted.e2ee } });
      if (caption) { els.messageInput.value = ''; autoGrowInput(); syncComposerEnabled(); }
      appendMessage(data.message);
      toast('Şifreli dosya gönderildi.');
    } else {
      const data = await api(`/api/channels/${state.currentChannelId}/messages`, { method: 'POST', body: { type: 'file', fileData, fileName: file.name || 'dosya', mimeType: file.type || 'application/octet-stream', text: caption } });
      if (caption) { els.messageInput.value = ''; autoGrowInput(); syncComposerEnabled(); }
      appendMessage(data.message);
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
    peers: new Map(),
    participants: new Map(),
    muted: false,
    selfId: state.socket?.id || null,
    keepaliveTimer: null,
    reconnectGraceTimer: null,
    reconnecting: false,
    manualLeave: false,
    peerRestartTimers: new Map(),
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
        for (const member of response.members || []) state.voice.participants.set(member.id, { user: member });
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
function renderVoicePanel(serverMembers = null) {
  const inCall = Boolean(state.voice.channelId);
  const viewingCallable = canCallCurrentChannel();
  if (!inCall && !viewingCallable) { els.voicePanel.classList.add('hidden'); els.voicePanel.classList.remove('reconnecting'); els.voicePanel.innerHTML = ''; return; }
  els.voicePanel.classList.remove('hidden');
  els.voicePanel.classList.toggle('reconnecting', Boolean(inCall && state.voice.reconnecting));
  const members = serverMembers || [...state.voice.participants.values()].map((p) => p.user || p).filter(Boolean);
  const count = inCall ? Math.max(1, members.filter((m) => m.id !== state.user?.id).length + 1) : 0;
  const activeHere = inCall && state.voice.channelId === state.currentChannelId;
  const title = state.voice.reconnecting ? 'Bağlantı koptu, ses odasına yeniden bağlanılıyor...' : (activeHere ? callLabel() : (inCall ? 'Başka bir ses kanalındasın' : callLabel()));
  const status = state.voice.reconnecting ? 'mikrofon açık tutuluyor' : `${count} kişi bağlı • ${state.voice.muted ? 'mikrofon kapalı' : 'mikrofon açık'}`;
  els.voicePanel.innerHTML = `
    <div class="min-0"><strong>${escapeHTML(title)}</strong><small>${inCall ? status : 'Canlı konuşmak için katıl.'}</small></div>
    <div class="voice-members">${inCall ? `<span class="voice-chip ${state.voice.muted ? 'muted' : ''}">Sen ${state.voice.muted ? '🔇' : '🎙'}</span>${members.filter((m) => m.id !== state.user?.id).map((m) => `<span class="voice-chip">${escapeHTML(m.displayName || m.username || 'Kullanıcı')}</span>`).join('')}` : '<span class="voice-chip">Hazır</span>'}</div>
    <div class="voice-actions">${inCall ? '<button id="muteVoiceButton" class="ghost" type="button">' + (state.voice.muted ? 'Mikrofonu aç' : 'Mikrofonu kapat') + '</button><button id="leaveVoiceButton" class="ghost danger" type="button">Ayrıl</button>' : '<button id="joinVoiceButton" class="primary" type="button">Sese katıl</button>'}</div>`;
  $('joinVoiceButton')?.addEventListener('click', joinVoice);
  $('leaveVoiceButton')?.addEventListener('click', () => leaveVoice(true));
  $('muteVoiceButton')?.addEventListener('click', toggleMute);
}
function createPeer(socketId, user) {
  if (!state.voice.stream) return null;
  if (state.voice.peers.has(socketId)) return state.voice.peers.get(socketId);
  const pc = new RTCPeerConnection(rtcConfig);
  state.voice.peers.set(socketId, pc); state.voice.participants.set(socketId, { socketId, user });
  state.voice.stream.getTracks().forEach((track) => pc.addTrack(track, state.voice.stream));
  pc.onicecandidate = (event) => { if (event.candidate) state.socket?.emit('voice:signal', { to: socketId, signal: { candidate: event.candidate } }); };
  pc.ontrack = (event) => {
    let audio = document.getElementById(`remote-${socketId}`);
    if (!audio) { audio = document.createElement('audio'); audio.id = `remote-${socketId}`; audio.autoplay = true; audio.playsInline = true; els.remoteAudio.appendChild(audio); }
    audio.srcObject = event.streams[0]; audio.play?.().catch(() => {});
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
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    state.voice = freshVoiceState({ channelId: state.currentChannelId, stream, selfId: state.socket.id, manualLeave: false });
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
  for (const socketId of [...(state.voice.peerRestartTimers?.keys() || [])]) clearPeerRestartTimer(socketId);
  closeAllVoicePeers();
  state.voice.stream?.getTracks().forEach((track) => track.stop());
  state.voice = freshVoiceState({ manualLeave: manual });
  els.remoteAudio.innerHTML = '';
  renderVoicePanel();
}
function toggleMute() { if (!state.voice.stream) return; state.voice.muted = !state.voice.muted; state.voice.stream.getAudioTracks().forEach((track) => { track.enabled = !state.voice.muted; }); renderVoicePanel(); }

async function showSettings() {
  const settings = { theme: 'dark', compactMode: false, reduceMotion: false, ...(state.settings || {}) };
  els.settingsContent.innerHTML = `
    <section class="settings-section"><h3>Profil</h3><label>Görünen ad<input id="settingsDisplayName" value="${escapeHTML(state.user?.displayName || '')}" maxlength="32"></label><label>Durum yazısı<input id="settingsStatus" value="${escapeHTML(state.user?.status || '')}" maxlength="80" placeholder="Müsait, oyundayım..."></label><button id="saveProfileButton" class="primary" type="button">Kaydet</button></section>
    <section class="settings-section"><h3>Görünüm</h3><label>Tema<select id="settingsTheme"><option value="dark">Dark</option><option value="midnight">Midnight</option><option value="rainbow">Rainbow</option></select></label><label class="toggle-row"><input id="compactModeToggle" type="checkbox"> Kompakt görünüm</label><label class="toggle-row"><input id="reduceMotionToggle" type="checkbox"> Animasyonları azalt</label><button id="saveUiButton" class="ghost" type="button">Görünümü kaydet</button></section>
    <section class="settings-section"><h3>Ses</h3><p>Mikrofon iznini buradan test edebilirsin. Sesli mesaj ve arama HTTPS üzerinde çalışır.</p><button id="testMicButton" class="ghost" type="button">Mikrofonu test et</button><div id="micTestResult" class="info-card"><span class="row-grow"><strong>Hazır</strong><br><small>Butona basınca tarayıcı mikrofon izni ister.</small></span></div></section>
    <section class="settings-section"><h3>Güvenlik</h3><div id="securityInfo" class="info-card"><span class="row-grow"><strong>Kontrol ediliyor...</strong><br><small>CSRF, rate-limit, upload yetkisi ve E2EE durumu.</small></span></div><ul class="security-list"><li>E2EE kanal başlığındaki kilit butonuyla açılır. Anahtar servera gönderilmez.</li><li>Yeni şifreli mesajları sadece aynı anahtarı bilen kişiler okuyabilir.</li><li>E2EE kapalıyken yeni mesajlar sunucuda okunabilir biçimde saklanır; kanal üstünde ayrıca uyarı görünür.</li><li>Canlı ses odası içeriği bu sürümde WebRTC/HTTPS ile gider; E2EE kilidi canlı ses için değil, mesaj/dosya/sesli mesaj içindir.</li><li>V7 otomatik tarayıcı yedeğini kapatır ve eski hassas localStorage yedeğini temizler.</li></ul><button id="logoutAllButton" class="ghost danger" type="button">Kendi oturumlarımı kapat</button>${state.isAppOwner ? '<button id="invalidateAllSessionsButton" class="ghost danger" type="button">Tüm kullanıcı oturumlarını sıfırla</button>' : ''}</section>
    <section class="settings-section"><h3>Veri kalıcılığı</h3><div id="storageInfo" class="info-card"><span class="row-grow"><strong>Kontrol ediliyor...</strong><br><small>Hesaplar, sunucular, mesajlar ve dosyalar server tarafında saklanır.</small></span></div><p>Render Free dosya sistemi deploy/restart sonrası silinebilir. Hesaplar ve sunucular kesin kalsın istiyorsan PostgreSQL bağlantısı (DATABASE_URL) kullan. Yedek indir butonu acil geri dönüş içindir.</p></section>
    <section class="settings-section"><h3>Yedek</h3>${state.isAppOwner ? '<button id="downloadBackupButton" class="ghost" type="button">Yedek indir</button><input id="backupFileInput" type="file" accept="application/json,.json"><button id="importBackupButton" class="ghost danger" type="button">Yedek yükle</button>' : '<p>Yedek alma/yükleme sadece ilk kayıt olan yönetici hesabında görünür.</p>'}</section>`;
  const theme = $('settingsTheme'), compact = $('compactModeToggle'), reduce = $('reduceMotionToggle');
  theme.value = settings.theme || 'dark'; compact.checked = Boolean(settings.compactMode); reduce.checked = Boolean(settings.reduceMotion);
  $('saveProfileButton')?.addEventListener('click', async () => {
    try { const response = await api('/api/me', { method: 'PATCH', body: { displayName: $('settingsDisplayName').value, status: $('settingsStatus').value, settings: state.settings } }); state.user = { ...state.user, ...response.user }; renderMe(); toast('Profil kaydedildi.'); } catch (e) { toast(e.message); }
  });
  $('saveUiButton')?.addEventListener('click', async () => {
    try { const newSettings = { theme: theme.value, compactMode: compact.checked, reduceMotion: reduce.checked }; const response = await api('/api/me', { method: 'PATCH', body: { displayName: state.user.displayName, status: state.user.status || '', settings: newSettings } }); state.user = { ...state.user, ...response.user }; state.settings = { ...newSettings, ...(response.user?.settings || {}) }; applySettings(); toast('Görünüm kaydedildi.'); } catch (e) { toast(e.message); }
  });
  $('testMicButton')?.addEventListener('click', async () => {
    const target = $('micTestResult');
    try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); target.innerHTML = '<span class="avatar online">✓</span><span class="row-grow"><strong>Mikrofon çalışıyor</strong><br><small>İzin verildi. Artık sesli mesaj ve arama kullanabilirsin.</small></span>'; stream.getTracks().forEach((track) => track.stop()); }
    catch { target.innerHTML = '<span class="avatar">!</span><span class="row-grow"><strong>Mikrofon izni alınamadı</strong><br><small>Tarayıcı adres çubuğundan mikrofon iznini kontrol et.</small></span>'; }
  });
  try {
    const info = await api('/api/storage-info'); const ok = Boolean(info.persistentData);
    $('storageInfo').innerHTML = `<span class="avatar ${ok ? 'online' : ''}">${ok ? '✓' : '!'}</span><span class="row-grow"><strong>${ok ? 'Kalıcı veri aktif' : 'Kalıcı veri garanti değil'}</strong><br><small>${escapeHTML(info.storageMode || 'file')} • ${escapeHTML(info.dataDir || '')} • ${info.uploadCount || 0} dosya • ${escapeHTML(info.warning || '')}</small></span>`;
  } catch { $('storageInfo').innerHTML = '<span class="row-grow"><strong>Veri bilgisi alınamadı</strong><br><small>/api/storage-info yanıt vermedi.</small></span>'; }
  try {
    const sec = await api('/api/security/status');
    $('securityInfo').innerHTML = `<span class="avatar online">✓</span><span class="row-grow"><strong>V7 Security aktif</strong><br><small>${escapeHTML(sec.sessionStorage)} • ${escapeHTML(sec.passwordKdf)} • CSRF/rate-limit/upload yetkisi açık</small></span>`;
  } catch { $('securityInfo').innerHTML = '<span class="row-grow"><strong>Güvenlik durumu alınamadı</strong><br><small>/api/security/status yanıt vermedi.</small></span>'; }
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { enterApp(await api('/api/me')); } catch { showAuth(); }
}
bootstrap();
