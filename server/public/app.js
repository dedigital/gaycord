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
  meAvatar: $('meAvatar'),
  meName: $('meName'),
  meUsername: $('meUsername'),
  logoutButton: $('logoutButton'),
  chatTitle: $('chatTitle'),
  chatSubtitle: $('chatSubtitle'),
  copyInviteButton: $('copyInviteButton'),
  messages: $('messages'),
  typingLine: $('typingLine'),
  messageForm: $('messageForm'),
  fileButton: $('fileButton'),
  fileInput: $('fileInput'),
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
  currentChannelKind: 'text',
  currentInviteCode: '',
  recorder: null,
  recordStream: null,
  recordChunks: [],
  recordStartedAt: 0,
  typingTimeout: null,
  remoteTypingTimeout: null,
  sendingFile: false
};

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.add('hidden'), 3400);
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
  try { return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
  catch { return ''; }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function autoGrowTextarea() {
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = Math.min(els.messageInput.scrollHeight, 130) + 'px';
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
  setTimeout(() => els.usernameInput.focus(), 0);
}

function showApp() {
  els.auth.classList.add('hidden');
  els.app.classList.remove('hidden');
}

async function refreshMe({ keepPanel = true } = {}) {
  const data = await api('/api/me');
  state.user = data.user;
  state.friends = data.friends || state.friends;
  state.servers = data.servers || [];
  state.onlineIds = new Set(data.onlineIds || []);
  renderMe();
  renderRail();

  if (!keepPanel || state.view === 'home') renderFriendsPanel();
  else if (state.view === 'server') renderServerPanel(state.currentServerId);
}

function renderMe() {
  els.meAvatar.textContent = initials(state.user?.displayName || state.user?.username);
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
    button.title = `${server.name} • ${server.memberIds?.length || 0} üye`;
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

function resetChat(title = 'Hoş geldin', subtitle = 'Sol taraftan arkadaş, sunucu veya kanal seç.') {
  state.currentChannelId = null;
  state.currentChannelKind = 'text';
  state.currentInviteCode = '';
  els.chatTitle.textContent = title;
  els.chatSubtitle.textContent = subtitle;
  els.copyInviteButton.classList.add('hidden');
  els.messageInput.value = '';
  autoGrowTextarea();
  els.messageInput.disabled = true;
  els.sendButton.disabled = true;
  els.recordButton.disabled = true;
  els.fileButton.disabled = true;
  els.typingLine.textContent = '';
  els.messages.innerHTML = '<div class="empty-state"><strong>Bir sohbet seç</strong>DM aç, sunucu kanalı seç veya yeni sunucu oluştur.</div>';
}

function renderFriendsPanel() {
  state.view = 'home';
  state.currentServerId = null;
  renderRail();
  els.sidebarTitle.textContent = 'Arkadaşlar';
  resetChat('Arkadaşlar', 'Arkadaş ekle, istek kabul et veya DM aç.');

  const incoming = state.friends.incomingRequests || [];
  const outgoing = state.friends.outgoingRequests || [];
  const friends = state.friends.friends || [];

  els.dynamicPanel.innerHTML = `
    <section class="stack">
      <div class="section-title">Arkadaş ekle</div>
      <input id="friendSearchInput" placeholder="Kullanıcı adı ara" autocomplete="off">
      <button id="friendSearchButton" class="primary" type="button">Ara ve ekle</button>
      <div id="friendSearchResults" class="stack"></div>
    </section>

    <section class="stack">
      <div class="section-title-row"><div class="section-title">Gelen istekler</div><small>${incoming.length}</small></div>
      <div id="incomingRequests"></div>
    </section>

    <section class="stack">
      <div class="section-title-row"><div class="section-title">Arkadaşlar</div><small>${friends.length}</small></div>
      <div id="friendList"></div>
    </section>

    <section class="stack">
      <div class="section-title-row"><div class="section-title">Bekleyen</div><small>${outgoing.length}</small></div>
      <div id="outgoingRequests"></div>
    </section>
  `;

  const incomingWrap = els.dynamicPanel.querySelector('#incomingRequests');
  const outgoingWrap = els.dynamicPanel.querySelector('#outgoingRequests');
  const friendList = els.dynamicPanel.querySelector('#friendList');

  incomingWrap.innerHTML = incoming.length ? '' : '<p>Gelen istek yok.</p>';
  for (const request of incoming) {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <span class="avatar">${escapeHTML(initials(request.from?.displayName))}</span>
      <span class="row-grow truncate"><strong>${escapeHTML(request.from?.displayName)}</strong><br><small>@${escapeHTML(request.from?.username)}</small></span>
      <span class="row-actions">
        <button class="mini-button success" data-accept="${escapeHTML(request.id)}">Kabul</button>
        <button class="mini-button danger" data-reject="${escapeHTML(request.id)}">Sil</button>
      </span>`;
    incomingWrap.appendChild(row);
  }

  friendList.innerHTML = friends.length ? '' : '<p>Henüz arkadaşın yok. Kullanıcı adıyla birini ekle.</p>';
  for (const friend of friends) {
    const row = document.createElement('button');
    row.className = 'user-row';
    row.type = 'button';
    row.innerHTML = `
      <span class="avatar ${state.onlineIds.has(friend.id) ? 'online' : ''}">${escapeHTML(initials(friend.displayName))}</span>
      <span class="row-grow truncate"><strong>${escapeHTML(friend.displayName)}</strong><br><small>@${escapeHTML(friend.username)} • ${state.onlineIds.has(friend.id) ? 'çevrimiçi' : 'çevrimdışı'}</small></span>`;
    row.addEventListener('click', () => openDm(friend));
    friendList.appendChild(row);
  }

  outgoingWrap.innerHTML = outgoing.length ? '' : '<p>Bekleyen istek yok.</p>';
  for (const request of outgoing) {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <span class="avatar">${escapeHTML(initials(request.to?.displayName))}</span>
      <span class="row-grow truncate"><strong>${escapeHTML(request.to?.displayName)}</strong><br><small>@${escapeHTML(request.to?.username)} • bekliyor</small></span>`;
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
          <button class="mini-button" ${user.friendship ? 'disabled' : ''}>${label}</button>`;
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
    } catch (error) { toast(error.message); }
  }

  searchButton.addEventListener('click', searchFriends);
  searchInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') searchFriends(); });
}

function renderServerPanel(serverId) {
  const server = state.servers.find((item) => item.id === serverId);
  if (!server) return renderFriendsPanel();

  state.view = 'server';
  state.currentServerId = server.id;
  const isOwner = server.ownerId === state.user?.id;
  els.sidebarTitle.textContent = server.name;
  els.copyInviteButton.classList.remove('hidden');
  state.currentInviteCode = server.inviteCode;

  const textChannels = server.channels.filter((c) => c.kind !== 'voice');
  const voiceChannels = server.channels.filter((c) => c.kind === 'voice');

  els.dynamicPanel.innerHTML = `
    <section class="stack">
      <div class="section-title">Sunucu</div>
      <div class="info-card">
        <span class="avatar server">${escapeHTML(initials(server.name))}</span>
        <span class="row-grow truncate"><strong>${escapeHTML(server.name)}</strong><br><small>${server.memberIds?.length || 0} üye • ${isOwner ? 'sahibi sensin' : 'üye'}</small></span>
      </div>
      <div class="stack">
        <button id="copyInvitePanelButton" class="ghost" type="button">Davet kodunu kopyala</button>
        ${isOwner ? '<button id="renameServerButton" class="ghost" type="button">Sunucu adını değiştir</button>' : ''}
        ${isOwner ? '<button id="addTextChannelButton" class="ghost" type="button">＋ Yazı kanalı</button>' : ''}
        ${isOwner ? '<button id="addVoiceChannelButton" class="ghost" type="button">＋ Ses kanalı</button>' : ''}
        ${isOwner ? '<button id="deleteServerButton" class="mini-button danger" type="button">Sunucuyu sil</button>' : '<button id="leaveServerButton" class="mini-button warn" type="button">Sunucudan çık</button>'}
      </div>
    </section>
    <section class="stack">
      <div class="section-title-row"><div class="section-title">Yazı kanalları</div><small>${textChannels.length}</small></div>
      <div id="textChannelList"></div>
    </section>
    <section class="stack">
      <div class="section-title-row"><div class="section-title">Ses kanalları</div><small>${voiceChannels.length}</small></div>
      <div id="voiceChannelList"></div>
    </section>`;

  renderChannelGroup(els.dynamicPanel.querySelector('#textChannelList'), textChannels, server, isOwner);
  renderChannelGroup(els.dynamicPanel.querySelector('#voiceChannelList'), voiceChannels, server, isOwner);

  const copyButton = els.dynamicPanel.querySelector('#copyInvitePanelButton');
  copyButton?.addEventListener('click', () => copyInvite(server.inviteCode));

  els.dynamicPanel.querySelector('#renameServerButton')?.addEventListener('click', async () => {
    const name = prompt('Yeni sunucu adı?', server.name);
    if (!name || name.trim() === server.name) return;
    try {
      const data = await api(`/api/servers/${server.id}`, { method: 'PATCH', body: { name } });
      const index = state.servers.findIndex((item) => item.id === server.id);
      if (index >= 0) state.servers[index] = data.server;
      renderRail();
      renderServerPanel(data.server.id);
      toast('Sunucu adı güncellendi.');
    } catch (error) { toast(error.message); }
  });

  els.dynamicPanel.querySelector('#addTextChannelButton')?.addEventListener('click', () => createChannel(server, 'text'));
  els.dynamicPanel.querySelector('#addVoiceChannelButton')?.addEventListener('click', () => createChannel(server, 'voice'));
  els.dynamicPanel.querySelector('#deleteServerButton')?.addEventListener('click', () => deleteServer(server));
  els.dynamicPanel.querySelector('#leaveServerButton')?.addEventListener('click', () => leaveServer(server));
}

function renderChannelGroup(container, channels, server, isOwner) {
  container.innerHTML = channels.length ? '' : '<p>Henüz kanal yok.</p>';
  for (const channel of channels) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `channel-row ${state.currentChannelId === channel.id ? 'active' : ''}`;
    const icon = channel.kind === 'voice' ? '🔊' : '#';
    row.innerHTML = `
      <span class="avatar">${icon}</span>
      <span class="row-grow truncate"><strong>${escapeHTML(channel.name)}</strong><br><small>${channel.kind === 'voice' ? 'ses kanalı' : 'yazı kanalı'}</small></span>
      ${isOwner ? '<span class="row-actions"><span class="mini-button danger" data-delete-channel="1">Sil</span></span>' : ''}`;
    row.addEventListener('click', (event) => {
      if (event.target?.dataset?.deleteChannel) return;
      openChannel(channel, {
        title: `${icon} ${channel.name}`,
        subtitle: `${server.name} • Davet kodu: ${server.inviteCode}`,
        inviteCode: server.inviteCode,
        serverId: server.id
      });
      renderServerPanel(server.id);
    });
    row.querySelector('[data-delete-channel]')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm(`#${channel.name} kanalını silmek istediğine emin misin?`)) return;
      try {
        const data = await api(`/api/servers/${server.id}/channels/${channel.id}`, { method: 'DELETE', body: {} });
        const index = state.servers.findIndex((item) => item.id === server.id);
        if (index >= 0) state.servers[index] = data.server;
        if (state.currentChannelId === channel.id) resetChat(server.name, 'Kanal silindi. Başka kanal seç.');
        renderServerPanel(server.id);
        toast('Kanal silindi.');
      } catch (error) { toast(error.message); }
    });
    container.appendChild(row);
  }
}

async function createChannel(server, kind) {
  const name = prompt(kind === 'voice' ? 'Yeni ses kanalı adı?' : 'Yeni yazı kanalı adı?', kind === 'voice' ? 'ses-odasi' : 'muhabbet');
  if (!name) return;
  try {
    const data = await api(`/api/servers/${server.id}/channels`, { method: 'POST', body: { name, kind } });
    const index = state.servers.findIndex((item) => item.id === server.id);
    if (index >= 0) state.servers[index] = data.server;
    renderServerPanel(server.id);
    openChannel(data.channel, {
      title: `${data.channel.kind === 'voice' ? '🔊' : '#'} ${data.channel.name}`,
      subtitle: `${data.server.name} • Davet kodu: ${data.server.inviteCode}`,
      inviteCode: data.server.inviteCode,
      serverId: data.server.id
    });
  } catch (error) { toast(error.message); }
}

async function deleteServer(server) {
  const typed = prompt(`Sunucuyu tamamen silmek için adını yaz: ${server.name}`);
  if (typed !== server.name) return toast('Sunucu silme iptal edildi.');
  try {
    await api(`/api/servers/${server.id}`, { method: 'DELETE', body: {} });
    state.servers = state.servers.filter((item) => item.id !== server.id);
    toast('Sunucu silindi.');
    renderFriendsPanel();
  } catch (error) { toast(error.message); }
}

async function leaveServer(server) {
  if (!confirm(`${server.name} sunucusundan çıkmak istiyor musun?`)) return;
  try {
    await api(`/api/servers/${server.id}/leave`, { method: 'POST', body: {} });
    state.servers = state.servers.filter((item) => item.id !== server.id);
    toast('Sunucudan çıkıldı.');
    renderFriendsPanel();
  } catch (error) { toast(error.message); }
}

async function copyInvite(inviteCode = state.currentInviteCode) {
  if (!inviteCode) return;
  try {
    await navigator.clipboard.writeText(inviteCode);
    toast(`Davet kodu kopyalandı: ${inviteCode}`);
  } catch {
    toast(`Davet kodu: ${inviteCode}`);
  }
}

async function openDm(friend) {
  try {
    const data = await api(`/api/dms/${friend.id}`);
    state.view = 'dm';
    state.currentServerId = null;
    renderRail();
    openChannel(data.channel, {
      title: `@${friend.displayName}`,
      subtitle: `Özel mesaj • @${friend.username}`,
      inviteCode: ''
    });
  } catch (error) { toast(error.message); }
}

async function openChannel(channel, info) {
  state.currentChannelId = channel.id;
  state.currentChannelKind = channel.kind || 'text';
  state.currentInviteCode = info.inviteCode || '';
  els.chatTitle.textContent = info.title;
  els.chatSubtitle.textContent = info.subtitle || '';
  els.copyInviteButton.classList.toggle('hidden', !state.currentInviteCode);
  els.messageInput.disabled = false;
  els.sendButton.disabled = false;
  els.recordButton.disabled = false;
  els.fileButton.disabled = false;
  els.messageInput.placeholder = channel.kind === 'voice' ? 'Ses kanalına not yaz veya sesli mesaj bırak...' : 'Mesaj yaz... Enter gönderir, Shift+Enter yeni satır.';
  els.messages.innerHTML = '<div class="empty-state"><strong>Yükleniyor</strong>Mesajlar getiriliyor...</div>';
  els.typingLine.textContent = '';

  if (state.socket?.connected) {
    state.socket.emit('channel:join', { channelId: channel.id }, (response) => {
      if (response?.error) return toast(response.error);
      renderMessages(response.messages || []);
    });
  } else {
    try {
      const data = await api(`/api/channels/${channel.id}/messages`);
      renderMessages(data.messages || []);
    } catch (error) { toast(error.message); }
  }
}

function renderMessages(messages) {
  els.messages.innerHTML = '';
  if (!messages.length) {
    els.messages.innerHTML = '<div class="empty-state"><strong>Henüz mesaj yok</strong>İlk mesajı sen gönder.</div>';
    return;
  }
  for (const message of messages) appendMessage(message, { scroll: false });
  scrollMessages();
}

function appendMessage(message, { scroll = true } = {}) {
  if (!message || message.channelId !== state.currentChannelId) return;
  if (els.messages.querySelector('.empty-state')) els.messages.innerHTML = '';

  const article = document.createElement('article');
  article.className = `message ${message.user?.id === state.user?.id ? 'own' : ''}`;

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
    label.className = 'message-body';
    label.textContent = '🎙️ Sesli mesaj';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = message.audioUrl;
    bubble.append(label, audio);
  } else if (message.type === 'file') {
    if (message.text) {
      const text = document.createElement('div');
      text.className = 'message-body';
      text.textContent = message.text;
      bubble.appendChild(text);
    }
    const link = document.createElement('a');
    link.className = 'message-file';
    link.href = message.fileUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = `📎 ${message.fileName || 'dosya'} ${formatBytes(message.sizeBytes)}`;
    bubble.appendChild(link);
  } else {
    const text = document.createElement('div');
    text.className = 'message-body';
    text.textContent = message.text || '';
    bubble.appendChild(text);
  }

  article.append(avatar, bubble);
  els.messages.appendChild(article);
  if (scroll) scrollMessages();
}

function scrollMessages() { els.messages.scrollTop = els.messages.scrollHeight; }

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io();

  state.socket.on('connect', () => {
    els.connectionState.textContent = 'çevrimiçi';
    els.connectionState.classList.remove('offline');
    if (state.currentChannelId) state.socket.emit('channel:join', { channelId: state.currentChannelId }, (response) => {
      if (!response?.error) renderMessages(response.messages || []);
    });
  });

  state.socket.on('disconnect', () => {
    els.connectionState.textContent = 'çevrimdışı';
    els.connectionState.classList.add('offline');
  });

  state.socket.on('connect_error', (error) => {
    els.connectionState.textContent = 'hata';
    els.connectionState.classList.add('offline');
    toast(error.message || 'Bağlantı hatası.');
  });

  state.socket.on('presence:update', ({ onlineIds }) => {
    state.onlineIds = new Set(onlineIds || []);
    if (state.view === 'home') renderFriendsPanel();
  });

  state.socket.on('message:new', (message) => appendMessage(message));

  state.socket.on('typing', ({ channelId, user, isTyping }) => {
    if (channelId !== state.currentChannelId || !isTyping || user?.id === state.user?.id) return;
    els.typingLine.textContent = `${user.displayName || user.username} yazıyor...`;
    clearTimeout(state.remoteTypingTimeout);
    state.remoteTypingTimeout = setTimeout(() => { els.typingLine.textContent = ''; }, 1800);
  });

  state.socket.on('server:deleted', ({ serverId, channelIds }) => {
    state.servers = state.servers.filter((server) => server.id !== serverId);
    if (state.currentServerId === serverId || channelIds?.includes(state.currentChannelId)) {
      toast('Seçili sunucu silindi.');
      renderFriendsPanel();
    } else renderRail();
  });

  state.socket.on('server:updated', ({ server }) => {
    const index = state.servers.findIndex((item) => item.id === server.id);
    if (index >= 0) state.servers[index] = server;
    renderRail();
    if (state.currentServerId === server.id) renderServerPanel(server.id);
  });

  state.socket.on('channel:deleted', ({ channelId, serverId }) => {
    const server = state.servers.find((item) => item.id === serverId);
    if (server) server.channels = server.channels.filter((channel) => channel.id !== channelId);
    if (state.currentChannelId === channelId) resetChat('Kanal silindi', 'Başka bir kanal seç.');
    if (state.currentServerId === serverId) renderServerPanel(serverId);
  });
}

async function sendTextMessage() {
  const text = els.messageInput.value.trim();
  if (!text || !state.currentChannelId) return;
  els.sendButton.disabled = true;
  try {
    if (state.socket?.connected) {
      state.socket.emit('message:text', { channelId: state.currentChannelId, text }, (response) => {
        els.sendButton.disabled = false;
        if (response?.error) return toast(response.error);
        els.messageInput.value = '';
        autoGrowTextarea();
        state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: false });
      });
    } else {
      const data = await api(`/api/channels/${state.currentChannelId}/messages`, { method: 'POST', body: { type: 'text', text } });
      appendMessage(data.message);
      els.messageInput.value = '';
      autoGrowTextarea();
      els.sendButton.disabled = false;
    }
  } catch (error) {
    els.sendButton.disabled = false;
    toast(error.message);
  }
}

function chooseAudioMime() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
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
  if (!state.currentChannelId) return toast('Önce kanal veya DM seç.');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Tarayıcı ses kaydını desteklemiyor.');

  try {
    state.recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = chooseAudioMime();
    state.recordChunks = [];
    state.recorder = new MediaRecorder(state.recordStream, mimeType ? { mimeType } : undefined);
    state.recordStartedAt = Date.now();

    state.recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) state.recordChunks.push(event.data); });

    state.recorder.addEventListener('stop', async () => {
      try {
        const blob = new Blob(state.recordChunks, { type: state.recorder.mimeType || mimeType || 'audio/webm' });
        const dataUrl = await blobToDataURL(blob);
        const durationMs = Date.now() - state.recordStartedAt;
        const response = await api(`/api/channels/${state.currentChannelId}/messages`, {
          method: 'POST',
          body: { type: 'voice', audioData: dataUrl, mimeType: blob.type, fileName: 'voice.webm', durationMs }
        });
        if (!state.socket?.connected) appendMessage(response.message);
        toast('Sesli mesaj gönderildi.');
      } catch (error) { toast(error.message || 'Sesli mesaj hazırlanamadı.'); }
      finally {
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
  } catch { toast('Mikrofon izni alınamadı.'); }
}

function stopRecording() { if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop(); }

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function sendSelectedFile(file) {
  if (!file || !state.currentChannelId || state.sendingFile) return;
  if (file.size > 15 * 1024 * 1024) return toast('Dosya 15 MB sınırını aşıyor.');
  state.sendingFile = true;
  els.fileButton.disabled = true;
  try {
    const dataUrl = await fileToDataURL(file);
    const caption = prompt('Dosya açıklaması? Boş bırakabilirsin.', '') || '';
    const response = await api(`/api/channels/${state.currentChannelId}/messages`, {
      method: 'POST',
      body: { type: 'file', fileData: dataUrl, mimeType: file.type || 'application/octet-stream', fileName: file.name, text: caption }
    });
    if (!state.socket?.connected) appendMessage(response.message);
    toast('Dosya gönderildi.');
  } catch (error) { toast(error.message); }
  finally {
    state.sendingFile = false;
    els.fileButton.disabled = !state.currentChannelId;
    els.fileInput.value = '';
  }
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
        body: { username: els.usernameInput.value, displayName: els.displayNameInput.value, password: els.passwordInput.value }
      });
      els.passwordInput.value = '';
      const data = await api('/api/me');
      enterApp(data);
    } catch (error) { toast(error.message); }
    finally { els.authSubmit.disabled = false; }
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
          inviteCode: data.server.inviteCode,
          serverId: data.server.id
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

  els.messageForm.addEventListener('submit', (event) => { event.preventDefault(); sendTextMessage(); });

  els.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendTextMessage();
    }
  });

  els.messageInput.addEventListener('input', () => {
    autoGrowTextarea();
    if (!state.currentChannelId || !state.socket?.connected) return;
    state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: true });
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: false }), 900);
  });

  els.recordButton.addEventListener('click', () => { if (state.recorder) stopRecording(); else startRecording(); });
  els.fileButton.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => sendSelectedFile(els.fileInput.files?.[0]));
  els.copyInviteButton.addEventListener('click', () => copyInvite());
}

function enterApp(data) {
  state.user = data.user;
  state.friends = data.friends || state.friends;
  state.servers = data.servers || [];
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
  resetChat();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  try {
    const data = await api('/api/me');
    enterApp(data);
  } catch { showAuth(); }
}

bootstrap();
