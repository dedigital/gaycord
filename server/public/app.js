const $ = (id) => document.getElementById(id);

const els = {
  auth: $('auth'),
  app: $('app'),
  loginTab: $('loginTab'),
  registerTab: $('registerTab'),
  authForm: $('authForm'),
  displayNameWrap: $('displayNameWrap'),
  displayNameInput: $('displayNameInput'),
  usernameInput: $('usernameInput'),
  passwordInput: $('passwordInput'),
  authSubmit: $('authSubmit'),
  homeButton: $('homeButton'),
  serverDots: $('serverDots'),
  createServerButton: $('createServerButton'),
  joinServerButton: $('joinServerButton'),
  sidebarTitle: $('sidebarTitle'),
  connectionState: $('connectionState'),
  dynamicPanel: $('dynamicPanel'),
  meName: $('meName'),
  meUsername: $('meUsername'),
  logoutButton: $('logoutButton'),
  chatTitle: $('chatTitle'),
  chatSubtitle: $('chatSubtitle'),
  copyInviteButton: $('copyInviteButton'),
  messages: $('messages'),
  typingLine: $('typingLine'),
  messageForm: $('messageForm'),
  recordButton: $('recordButton'),
  messageInput: $('messageInput'),
  sendButton: $('sendButton'),
  toast: $('toast')
};

const state = {
  mode: 'login',
  user: null,
  friends: { friends: [], incomingRequests: [], outgoingRequests: [] },
  servers: [],
  onlineIds: new Set(),
  socket: null,
  view: 'home',
  currentServerId: null,
  currentChannelId: null,
  currentInviteCode: '',
  recorder: null,
  recordStream: null,
  recordChunks: [],
  recordStartedAt: 0,
  typingTimeout: null,
  remoteTypingTimeout: null
};

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.add('hidden'), 3200);
}

function escapeHTML(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || '?';
}

function formatTime(iso) {
  try {
    return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return '';
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin'
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'İstek başarısız oldu.');
  return data;
}

function setAuthMode(mode) {
  state.mode = mode;
  els.loginTab.classList.toggle('active', mode === 'login');
  els.registerTab.classList.toggle('active', mode === 'register');
  els.displayNameWrap.classList.toggle('hidden', mode !== 'register');
  els.authSubmit.textContent = mode === 'login' ? 'Giriş yap' : 'Hesap oluştur';
  els.passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
}

function showAuth() {
  els.auth.classList.remove('hidden');
  els.app.classList.add('hidden');
  els.usernameInput.focus();
}

function showApp() {
  els.auth.classList.add('hidden');
  els.app.classList.remove('hidden');
}

async function refreshMe({ keepPanel = true } = {}) {
  const data = await api('/api/me');
  state.user = data.user;
  state.friends = data.friends;
  state.servers = data.servers;
  state.onlineIds = new Set(data.onlineIds || []);
  renderMe();
  renderRail();

  if (!keepPanel || state.view === 'home') renderFriendsPanel();
  else if (state.view === 'server') renderServerPanel(state.currentServerId);
}

function renderMe() {
  els.meName.textContent = state.user?.displayName || '-';
  els.meUsername.textContent = state.user ? `@${state.user.username}` : '-';
}

function renderRail() {
  els.homeButton.classList.toggle('active', state.view === 'home');
  els.serverDots.innerHTML = '';

  for (const server of state.servers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `rail-button server-dot ${state.currentServerId === server.id && state.view === 'server' ? 'active' : ''}`;
    button.title = server.name;
    button.textContent = initials(server.name);
    button.addEventListener('click', () => {
      state.view = 'server';
      state.currentServerId = server.id;
      renderRail();
      renderServerPanel(server.id);
    });
    els.serverDots.appendChild(button);
  }
}

function renderFriendsPanel() {
  state.view = 'home';
  state.currentServerId = null;
  renderRail();
  els.sidebarTitle.textContent = 'Arkadaşlar';
  els.copyInviteButton.classList.add('hidden');

  const incoming = state.friends.incomingRequests || [];
  const outgoing = state.friends.outgoingRequests || [];
  const friends = state.friends.friends || [];

  els.dynamicPanel.innerHTML = `
    <section class="stack">
      <div class="section-title">Arkadaş ekle</div>
      <input id="friendSearchInput" placeholder="Kullanıcı adı ara" autocomplete="off">
      <button id="friendSearchButton" class="primary" type="button">Ara</button>
      <div id="friendSearchResults" class="stack"></div>
    </section>

    <section class="stack">
      <div class="section-title">Gelen istekler</div>
      <div id="incomingRequests"></div>
    </section>

    <section class="stack">
      <div class="section-title">Arkadaşlar</div>
      <div id="friendList"></div>
    </section>

    <section class="stack">
      <div class="section-title">Gönderilen istekler</div>
      <div id="outgoingRequests"></div>
    </section>
  `;

  const incomingWrap = els.dynamicPanel.querySelector('#incomingRequests');
  const outgoingWrap = els.dynamicPanel.querySelector('#outgoingRequests');
  const friendList = els.dynamicPanel.querySelector('#friendList');

  if (!incoming.length) incomingWrap.innerHTML = '<p>Gelen istek yok.</p>';
  for (const request of incoming) {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <span class="avatar">${escapeHTML(initials(request.from.displayName))}</span>
      <span class="row-grow truncate"><strong>${escapeHTML(request.from.displayName)}</strong><br><small>@${escapeHTML(request.from.username)}</small></span>
      <span class="row-actions">
        <button class="mini-button success" data-accept="${escapeHTML(request.id)}">Kabul</button>
        <button class="mini-button danger" data-reject="${escapeHTML(request.id)}">Sil</button>
      </span>
    `;
    incomingWrap.appendChild(row);
  }

  if (!friends.length) friendList.innerHTML = '<p>Henüz arkadaşın yok. Kullanıcı adıyla birini ekle.</p>';
  for (const friend of friends) {
    const row = document.createElement('button');
    row.className = 'user-row';
    row.type = 'button';
    row.innerHTML = `
      <span class="avatar ${state.onlineIds.has(friend.id) ? 'online' : ''}">${escapeHTML(initials(friend.displayName))}</span>
      <span class="row-grow truncate"><strong>${escapeHTML(friend.displayName)}</strong><br><small>@${escapeHTML(friend.username)} • ${state.onlineIds.has(friend.id) ? 'çevrimiçi' : 'çevrimdışı'}</small></span>
    `;
    row.addEventListener('click', () => openDm(friend));
    friendList.appendChild(row);
  }

  if (!outgoing.length) outgoingWrap.innerHTML = '<p>Bekleyen istek yok.</p>';
  for (const request of outgoing) {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <span class="avatar">${escapeHTML(initials(request.to.displayName))}</span>
      <span class="row-grow truncate"><strong>${escapeHTML(request.to.displayName)}</strong><br><small>@${escapeHTML(request.to.username)} • bekliyor</small></span>
    `;
    outgoingWrap.appendChild(row);
  }

  els.dynamicPanel.querySelectorAll('[data-accept]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api('/api/friends/respond', { method: 'POST', body: { requestId: button.dataset.accept, accept: true } });
        toast('Arkadaşlık isteği kabul edildi.');
        await refreshMe({ keepPanel: false });
      } catch (error) { toast(error.message); }
    });
  });

  els.dynamicPanel.querySelectorAll('[data-reject]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api('/api/friends/respond', { method: 'POST', body: { requestId: button.dataset.reject, accept: false } });
        toast('İstek silindi.');
        await refreshMe({ keepPanel: false });
      } catch (error) { toast(error.message); }
    });
  });

  const searchInput = els.dynamicPanel.querySelector('#friendSearchInput');
  const searchButton = els.dynamicPanel.querySelector('#friendSearchButton');
  const results = els.dynamicPanel.querySelector('#friendSearchResults');

  async function searchFriends() {
    const q = searchInput.value.trim();
    if (q.length < 2) return toast('En az 2 karakter yaz.');
    try {
      const data = await api(`/api/search-users?q=${encodeURIComponent(q)}`);
      results.innerHTML = '';
      if (!data.users.length) results.innerHTML = '<p>Kullanıcı bulunamadı.</p>';
      for (const user of data.users) {
        const row = document.createElement('div');
        row.className = 'user-row';
        const label = user.friendship === 'accepted' ? 'Arkadaş' : user.friendship === 'pending' ? 'Bekliyor' : 'Ekle';
        row.innerHTML = `
          <span class="avatar">${escapeHTML(initials(user.displayName))}</span>
          <span class="row-grow truncate"><strong>${escapeHTML(user.displayName)}</strong><br><small>@${escapeHTML(user.username)}</small></span>
          <button class="mini-button" ${user.friendship ? 'disabled' : ''}>${label}</button>
        `;
        const addButton = row.querySelector('button');
        addButton.addEventListener('click', async () => {
          try {
            await api('/api/friends/request', { method: 'POST', body: { username: user.username } });
            toast('Arkadaşlık isteği gönderildi.');
            await refreshMe({ keepPanel: false });
          } catch (error) { toast(error.message); }
        });
        results.appendChild(row);
      }
    } catch (error) {
      toast(error.message);
    }
  }

  searchButton.addEventListener('click', searchFriends);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') searchFriends();
  });
}

function renderServerPanel(serverId) {
  const server = state.servers.find((item) => item.id === serverId);
  if (!server) return renderFriendsPanel();

  state.view = 'server';
  state.currentServerId = server.id;
  els.sidebarTitle.textContent = server.name;
  els.dynamicPanel.innerHTML = `
    <section class="stack">
      <div class="section-title">Sunucu</div>
      <div class="user-row">
        <span class="avatar">${escapeHTML(initials(server.name))}</span>
        <span class="row-grow truncate"><strong>${escapeHTML(server.name)}</strong><br><small>Davet kodu: ${escapeHTML(server.inviteCode)}</small></span>
      </div>
      <button id="addChannelButton" class="ghost" type="button">Kanal ekle</button>
    </section>
    <section class="stack">
      <div class="section-title">Kanallar</div>
      <div id="channelList"></div>
    </section>
  `;

  const list = els.dynamicPanel.querySelector('#channelList');
  for (const channel of server.channels) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `channel-row ${state.currentChannelId === channel.id ? 'active' : ''}`;
    row.innerHTML = `<span>#</span><span class="row-grow truncate">${escapeHTML(channel.name)}</span>`;
    row.addEventListener('click', () => {
      openChannel(channel, {
        title: `# ${channel.name}`,
        subtitle: `${server.name} • Davet kodu: ${server.inviteCode}`,
        inviteCode: server.inviteCode
      });
      renderServerPanel(server.id);
    });
    list.appendChild(row);
  }

  els.dynamicPanel.querySelector('#addChannelButton').addEventListener('click', async () => {
    const name = prompt('Yeni kanal adı? Örn: oyun, ders, muhabbet');
    if (!name) return;
    try {
      const data = await api(`/api/servers/${server.id}/channels`, { method: 'POST', body: { name } });
      const index = state.servers.findIndex((item) => item.id === server.id);
      state.servers[index] = data.server;
      renderServerPanel(server.id);
      openChannel(data.channel, {
        title: `# ${data.channel.name}`,
        subtitle: `${data.server.name} • Davet kodu: ${data.server.inviteCode}`,
        inviteCode: data.server.inviteCode
      });
    } catch (error) { toast(error.message); }
  });
}

async function openDm(friend) {
  try {
    const data = await api(`/api/dms/${friend.id}`);
    openChannel(data.channel, {
      title: `@${friend.displayName}`,
      subtitle: `Özel mesaj • @${friend.username}`,
      inviteCode: ''
    });
  } catch (error) {
    toast(error.message);
  }
}

function openChannel(channel, info) {
  if (!state.socket?.connected) {
    toast('Sunucu bağlantısı kurulunca tekrar dene.');
    return;
  }

  state.currentChannelId = channel.id;
  state.currentInviteCode = info.inviteCode || '';
  els.chatTitle.textContent = info.title;
  els.chatSubtitle.textContent = info.subtitle || '';
  els.copyInviteButton.classList.toggle('hidden', !state.currentInviteCode);
  els.messageInput.disabled = false;
  els.sendButton.disabled = false;
  els.recordButton.disabled = false;
  els.messages.innerHTML = '<div class="empty-state">Mesajlar yükleniyor...</div>';
  els.typingLine.textContent = '';

  state.socket.emit('channel:join', { channelId: channel.id }, (response) => {
    if (response?.error) return toast(response.error);
    renderMessages(response.messages || []);
  });
}

function renderMessages(messages) {
  els.messages.innerHTML = '';
  if (!messages.length) {
    els.messages.innerHTML = '<div class="empty-state">Bu kanalda henüz mesaj yok. İlk mesajı sen gönder.</div>';
    return;
  }
  for (const message of messages) appendMessage(message, { scroll: false });
  scrollMessages();
}

function appendMessage(message, { scroll = true } = {}) {
  if (els.messages.querySelector('.empty-state')) els.messages.innerHTML = '';

  const article = document.createElement('article');
  article.className = 'message';

  const avatar = document.createElement('div');
  avatar.className = `avatar ${state.onlineIds.has(message.user?.id) ? 'online' : ''}`;
  avatar.textContent = initials(message.user?.displayName || message.user?.username || '?');

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const name = document.createElement('strong');
  name.textContent = message.user?.displayName || message.user?.username || 'Bilinmeyen';
  const time = document.createElement('time');
  time.textContent = formatTime(message.createdAt);
  meta.append(name, time);
  bubble.appendChild(meta);

  if (message.type === 'voice') {
    const label = document.createElement('div');
    label.textContent = 'Sesli mesaj';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = message.audioUrl;
    bubble.append(label, audio);
  } else {
    const text = document.createElement('div');
    text.textContent = message.text || '';
    bubble.appendChild(text);
  }

  article.append(avatar, bubble);
  els.messages.appendChild(article);
  if (scroll) scrollMessages();
}

function scrollMessages() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io();

  state.socket.on('connect', () => {
    els.connectionState.textContent = 'çevrimiçi';
    els.connectionState.classList.add('online');
  });

  state.socket.on('disconnect', () => {
    els.connectionState.textContent = 'çevrimdışı';
    els.connectionState.classList.remove('online');
  });

  state.socket.on('connect_error', (error) => {
    els.connectionState.textContent = 'hata';
    els.connectionState.classList.remove('online');
    toast(error.message || 'Bağlantı hatası.');
  });

  state.socket.on('presence:update', ({ onlineIds }) => {
    state.onlineIds = new Set(onlineIds || []);
    if (state.view === 'home') renderFriendsPanel();
  });

  state.socket.on('message:new', (message) => {
    if (message.channelId === state.currentChannelId) appendMessage(message);
  });

  state.socket.on('typing', ({ channelId, user, isTyping }) => {
    if (channelId !== state.currentChannelId || !isTyping || user?.id === state.user?.id) return;
    els.typingLine.textContent = `${user.displayName || user.username} yazıyor...`;
    clearTimeout(state.remoteTypingTimeout);
    state.remoteTypingTimeout = setTimeout(() => { els.typingLine.textContent = ''; }, 1800);
  });
}

async function sendTextMessage() {
  const text = els.messageInput.value.trim();
  if (!text || !state.currentChannelId) return;
  els.sendButton.disabled = true;
  state.socket.emit('message:text', { channelId: state.currentChannelId, text }, (response) => {
    els.sendButton.disabled = false;
    if (response?.error) return toast(response.error);
    els.messageInput.value = '';
    state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: false });
  });
}

function chooseAudioMime() {
  const options = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4'
  ];
  return options.find((mime) => window.MediaRecorder?.isTypeSupported?.(mime)) || '';
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function startRecording() {
  if (!state.currentChannelId) return toast('Önce bir kanal veya DM seç.');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return toast('Bu tarayıcı ses kaydını desteklemiyor. Chrome/Edge/Firefox deneyebilirsin.');
  }

  try {
    state.recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = chooseAudioMime();
    state.recordChunks = [];
    state.recorder = new MediaRecorder(state.recordStream, mimeType ? { mimeType } : undefined);
    state.recordStartedAt = Date.now();

    state.recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) state.recordChunks.push(event.data);
    });

    state.recorder.addEventListener('stop', async () => {
      try {
        const blob = new Blob(state.recordChunks, { type: state.recorder.mimeType || mimeType || 'audio/webm' });
        const dataUrl = await blobToDataURL(blob);
        const durationMs = Date.now() - state.recordStartedAt;
        state.socket.emit('message:voice', {
          channelId: state.currentChannelId,
          audioData: dataUrl,
          mimeType: blob.type,
          durationMs
        }, (response) => {
          if (response?.error) toast(response.error);
          else toast('Sesli mesaj gönderildi.');
        });
      } catch (error) {
        toast('Sesli mesaj hazırlanamadı.');
      } finally {
        state.recordStream?.getTracks().forEach((track) => track.stop());
        state.recordStream = null;
        state.recorder = null;
        state.recordChunks = [];
        els.recordButton.classList.remove('recording');
        els.recordButton.textContent = '🎙️';
      }
    });

    state.recorder.start();
    els.recordButton.classList.add('recording');
    els.recordButton.textContent = '⏹️';
    toast('Kayıt başladı. Durdurmak için tekrar bas.');
  } catch (error) {
    toast('Mikrofon izni alınamadı.');
  }
}

function stopRecording() {
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
}

function wireEvents() {
  els.loginTab.addEventListener('click', () => setAuthMode('login'));
  els.registerTab.addEventListener('click', () => setAuthMode('register'));

  els.authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    els.authSubmit.disabled = true;
    try {
      const endpoint = state.mode === 'login' ? '/api/login' : '/api/register';
      await api(endpoint, {
        method: 'POST',
        body: {
          username: els.usernameInput.value,
          displayName: els.displayNameInput.value,
          password: els.passwordInput.value
        }
      });
      els.passwordInput.value = '';
      const data = await api('/api/me');
      enterApp(data);
    } catch (error) {
      toast(error.message);
    } finally {
      els.authSubmit.disabled = false;
    }
  });

  els.homeButton.addEventListener('click', renderFriendsPanel);

  els.createServerButton.addEventListener('click', async () => {
    const name = prompt('Sunucu adı? Örn: Bizim Ekip');
    if (!name) return;
    try {
      const data = await api('/api/servers', { method: 'POST', body: { name } });
      state.servers.push(data.server);
      state.view = 'server';
      state.currentServerId = data.server.id;
      renderRail();
      renderServerPanel(data.server.id);
      if (data.server.channels[0]) {
        openChannel(data.server.channels[0], {
          title: `# ${data.server.channels[0].name}`,
          subtitle: `${data.server.name} • Davet kodu: ${data.server.inviteCode}`,
          inviteCode: data.server.inviteCode
        });
      }
    } catch (error) { toast(error.message); }
  });

  els.joinServerButton.addEventListener('click', async () => {
    const inviteCode = prompt('Davet kodu?');
    if (!inviteCode) return;
    try {
      const data = await api('/api/servers/join', { method: 'POST', body: { inviteCode } });
      const index = state.servers.findIndex((server) => server.id === data.server.id);
      if (index >= 0) state.servers[index] = data.server;
      else state.servers.push(data.server);
      state.view = 'server';
      state.currentServerId = data.server.id;
      renderRail();
      renderServerPanel(data.server.id);
      toast('Sunucuya katıldın.');
    } catch (error) { toast(error.message); }
  });

  els.logoutButton.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch {}
    state.socket?.disconnect();
    state.user = null;
    state.currentChannelId = null;
    showAuth();
  });

  els.messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    sendTextMessage();
  });

  els.messageInput.addEventListener('input', () => {
    if (!state.currentChannelId || !state.socket?.connected) return;
    state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: true });
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => {
      state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: false });
    }, 900);
  });

  els.recordButton.addEventListener('click', () => {
    if (state.recorder) stopRecording();
    else startRecording();
  });

  els.copyInviteButton.addEventListener('click', async () => {
    if (!state.currentInviteCode) return;
    try {
      await navigator.clipboard.writeText(state.currentInviteCode);
      toast('Davet kodu kopyalandı.');
    } catch {
      toast(`Davet kodu: ${state.currentInviteCode}`);
    }
  });
}

function enterApp(data) {
  state.user = data.user;
  state.friends = data.friends;
  state.servers = data.servers;
  state.onlineIds = new Set(data.onlineIds || []);
  showApp();
  renderMe();
  renderRail();
  renderFriendsPanel();
  connectSocket();
}

async function bootstrap() {
  wireEvents();
  setAuthMode('login');
  els.messageInput.disabled = true;
  els.sendButton.disabled = true;
  els.recordButton.disabled = true;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  try {
    const data = await api('/api/me');
    enterApp(data);
  } catch {
    showAuth();
  }
}

bootstrap();
