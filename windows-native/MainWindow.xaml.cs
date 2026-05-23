using System.Collections.ObjectModel;
using System.Diagnostics;
using Microsoft.Win32;
using System.Windows;
using System.Windows.Input;

namespace Gaycord.Native;

public partial class MainWindow : Window
{
    private readonly ApiClient _api = new();
    private readonly RealtimeClient _rt = new();
    private readonly AudioService _audio = new();
    private readonly LocalSettings _settings;
    private readonly ObservableCollection<MessageView> _messages = new();

    private MeDto? _me;
    private ServerDto? _currentServer;
    private ChannelDto? _currentChannel;
    private bool _isLiveVoice;

    public MainWindow()
    {
        InitializeComponent();
        _settings = SettingsStore.Load();
        ServerUrlBox.Text = _settings.ServerUrl;
        UsernameBox.Text = _settings.Username;
        MessageList.ItemsSource = _messages;

        _rt.MessageReceived += message => Dispatcher.Invoke(() => AddMessageIfCurrent(message));
        _rt.JoinedChannel += (channelId, messages) => Dispatcher.Invoke(() => RenderJoinedMessages(channelId, messages));
        _rt.PresenceUpdated += _ => Dispatcher.Invoke(async () => await RefreshMeSilentlyAsync());
        _rt.VoiceFrameReceived += (_, _, pcm) => _audio.PlayRemote(pcm);
        _rt.StatusChanged += status => Dispatcher.Invoke(() => PresenceText.Text = status);
        _rt.ErrorReceived += error => Dispatcher.Invoke(() => SetStatus(error));

        Loaded += async (_, _) =>
        {
            if (!string.IsNullOrWhiteSpace(_settings.Token))
            {
                try
                {
                    _api.Configure(_settings.ServerUrl, _settings.Token);
                    await EnterAppAsync();
                }
                catch
                {
                    LoginStatus.Text = "Kaydedilmiş giriş süresi bitmiş olabilir. Tekrar giriş yap.";
                }
            }
        };
    }

    private async void LoginButton_Click(object sender, RoutedEventArgs e) => await AuthenticateAsync(register: false);
    private async void RegisterButton_Click(object sender, RoutedEventArgs e) => await AuthenticateAsync(register: true);

    private async Task AuthenticateAsync(bool register)
    {
        try
        {
            LoginStatus.Text = "";
            var serverUrl = ServerUrlBox.Text.Trim().TrimEnd('/');
            var username = UsernameBox.Text.Trim();
            var password = PasswordBox.Password;
            _api.Configure(serverUrl);
            AuthResponse auth = register
                ? await _api.RegisterAsync(username, DisplayNameBox.Text.Trim(), password)
                : await _api.LoginAsync(username, password);
            _api.SetToken(auth.Token);
            _settings.ServerUrl = serverUrl;
            _settings.Token = auth.Token;
            _settings.Username = username;
            SettingsStore.Save(_settings);
            await EnterAppAsync();
        }
        catch (Exception ex)
        {
            LoginStatus.Text = ex.Message;
        }
    }

    private async Task EnterAppAsync()
    {
        LoginView.Visibility = Visibility.Collapsed;
        ShellView.Visibility = Visibility.Visible;
        await LoadMeAsync();
        await _rt.ConnectAsync(_api.BaseUrl, _api.Token);
        HomeButton_Click(this, new RoutedEventArgs());
    }

    private async Task LoadMeAsync()
    {
        _me = await _api.GetMeAsync();
        ServerList.ItemsSource = _me.Servers;
        RenderFriendList();
        MeText.Text = _me.User is null ? "" : $"{_me.User.DisplayName}  @{_me.User.Username}";
        PresenceText.Text = $"{_me.OnlineIds.Count} çevrimiçi";
    }

    private async Task RefreshMeSilentlyAsync()
    {
        try
        {
            await LoadMeAsync();
            if (_currentServer is not null)
            {
                var fresh = _me?.Servers.FirstOrDefault(s => s.Id == _currentServer.Id);
                if (fresh is not null)
                {
                    _currentServer = fresh;
                    ChannelList.ItemsSource = fresh.Channels;
                }
            }
        }
        catch { }
    }

    private void RenderFriendList()
    {
        var items = new List<FriendListItem>();
        if (_me?.Friends is null)
        {
            FriendList.ItemsSource = items;
            return;
        }

        items.AddRange(_me.Friends.IncomingRequests.Select(r => new FriendListItem { Kind = "incoming", User = r.From, RequestId = r.Id }));
        items.AddRange(_me.Friends.Friends.Select(f => new FriendListItem { Kind = "friend", User = f }));
        items.AddRange(_me.Friends.OutgoingRequests.Select(r => new FriendListItem { Kind = "outgoing", User = r.To, RequestId = r.Id }));
        FriendList.ItemsSource = items;
    }

    private void HomeButton_Click(object sender, RoutedEventArgs e)
    {
        _currentServer = null;
        _currentChannel = null;
        ServerList.SelectedItem = null;
        ChannelList.ItemsSource = null;
        SideTitle.Text = "Arkadaşlar";
        SectionOneTitle.Text = "DM için arkadaşına çift tıkla";
        ChatTitle.Text = "Arkadaşlar";
        ChatSubtitle.Text = "Arkadaş ekle, istek kabul et veya DM aç.";
        CopyInviteButton.Content = "Davet kodu";
        DeleteServerButton.Visibility = Visibility.Collapsed;
        LeaveServerButton.Visibility = Visibility.Collapsed;
        _messages.Clear();
    }

    private void ServerList_SelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
    {
        if (ServerList.SelectedItem is not ServerDto server) return;
        _currentServer = server;
        SideTitle.Text = server.Name;
        SectionOneTitle.Text = "Kanallar";
        ChannelList.ItemsSource = server.Channels;
        CopyInviteButton.Content = $"Davet: {server.InviteCode}";
        ChatTitle.Text = server.Name;
        ChatSubtitle.Text = "Bir kanal seç.";
        var isOwner = server.OwnerId == _me?.User?.Id;
        DeleteServerButton.Visibility = isOwner ? Visibility.Visible : Visibility.Collapsed;
        LeaveServerButton.Visibility = isOwner ? Visibility.Collapsed : Visibility.Visible;
    }

    private async void ChannelList_SelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
    {
        if (ChannelList.SelectedItem is not ChannelDto channel) return;
        await OpenChannelAsync(channel);
    }

    private async Task OpenChannelAsync(ChannelDto channel)
    {
        _currentChannel = channel;
        ChatTitle.Text = channel.Kind == "voice" ? $"🔊 {channel.Name}" : $"# {channel.Name}";
        ChatSubtitle.Text = channel.Kind == "voice" ? "Ses odasına katılabilir veya buraya mesaj yazabilirsin." : "Mesaj yaz, sesli mesaj bırak.";
        _messages.Clear();
        _messages.Add(new MessageView(new ChatMessageDto { Text = "Mesajlar yükleniyor...", Type = "text", CreatedAt = DateTimeOffset.Now.ToString("O"), User = new UserDto { DisplayName = "Sistem" } }));

        if (_rt.IsConnected)
        {
            await _rt.JoinChannelAsync(channel.Id);
        }
        else
        {
            var response = await _api.GetMessagesAsync(channel.Id);
            RenderJoinedMessages(channel.Id, response.Messages);
        }
    }

    private void RenderJoinedMessages(string channelId, List<ChatMessageDto> messages)
    {
        if (_currentChannel?.Id != channelId) return;
        _messages.Clear();
        foreach (var message in messages) _messages.Add(new MessageView(message));
        if (_messages.Count == 0)
            _messages.Add(new MessageView(new ChatMessageDto { Type = "text", Text = "Bu kanalda henüz mesaj yok. İlk mesajı sen gönder.", CreatedAt = DateTimeOffset.Now.ToString("O"), User = new UserDto { DisplayName = "Sistem" } }));
        ScrollToLast();
    }

    private void AddMessageIfCurrent(ChatMessageDto message)
    {
        if (_currentChannel?.Id != message.ChannelId) return;
        if (_messages.Count == 1 && _messages[0].Message.User?.DisplayName == "Sistem") _messages.Clear();
        _messages.Add(new MessageView(message));
        ScrollToLast();
    }

    private async void FriendList_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (FriendList.SelectedItem is not FriendListItem item) return;
        try
        {
            if (item.Kind == "incoming")
            {
                await _api.RespondFriendAsync(item.RequestId, true);
                await LoadMeAsync();
                SetStatus("Arkadaşlık isteği kabul edildi.");
                return;
            }
            if (item.Kind == "outgoing")
            {
                SetStatus("Bu istek karşı tarafın onayını bekliyor.");
                return;
            }
            if (item.User is null) return;
            var dm = await _api.GetDmAsync(item.User.Id);
            if (dm.Channel is null) return;
            _currentServer = null;
            _currentChannel = dm.Channel;
            ChatTitle.Text = item.User.DisplayName;
            ChatSubtitle.Text = $"@{item.User.Username} ile DM";
            await OpenChannelAsync(dm.Channel);
        }
        catch (Exception ex) { SetStatus(ex.Message); }
    }

    private async void SendButton_Click(object sender, RoutedEventArgs e) => await SendCurrentTextAsync();

    private async void MessageBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Keyboard.Modifiers != ModifierKeys.Shift)
        {
            e.Handled = true;
            await SendCurrentTextAsync();
        }
    }

    private async Task SendCurrentTextAsync()
    {
        try
        {
            var text = MessageBox.Text.Trim();
            if (_currentChannel is null || string.IsNullOrWhiteSpace(text)) return;
            MessageBox.Clear();
            var result = await _api.SendTextAsync(_currentChannel.Id, text);
            if (!_rt.IsConnected && result.Message is not null) AddMessageIfCurrent(result.Message);
        }
        catch (Exception ex) { SetStatus(ex.Message); }
    }


    private async void FileButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_currentChannel is null) { SetStatus("Önce kanal veya DM seç."); return; }
            var dialog = new OpenFileDialog
            {
                Title = "Gaycord dosya gönder",
                Filter = "Desteklenen dosyalar|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.mp4;*.webm;*.wav;*.mp3;*.pdf;*.txt;*.zip|Tüm dosyalar|*.*"
            };
            if (dialog.ShowDialog() != true) return;
            var result = await _api.SendFileAsync(_currentChannel.Id, dialog.FileName, MessageBox.Text.Trim());
            MessageBox.Clear();
            if (!_rt.IsConnected && result.Message is not null) AddMessageIfCurrent(result.Message);
            SetStatus("Dosya gönderildi.");
        }
        catch (Exception ex) { SetStatus(ex.Message); }
    }

    private async void VoiceMessageButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_currentChannel is null) { SetStatus("Önce kanal veya DM seç."); return; }
            if (!_audio.IsMessageRecording)
            {
                _audio.StartMessageRecording();
                VoiceMessageButton.Content = "⏹ Bitir";
                SetStatus("Ses kaydı başladı. Bitirmek için tekrar bas.");
                return;
            }

            var (wav, durationMs) = await _audio.StopMessageRecordingAsync();
            VoiceMessageButton.Content = "🎙 Ses";
            var dataUrl = "data:audio/wav;base64," + Convert.ToBase64String(wav);
            var result = await _api.SendVoiceAsync(_currentChannel.Id, dataUrl, durationMs);
            if (!_rt.IsConnected && result.Message is not null) AddMessageIfCurrent(result.Message);
            SetStatus("Sesli mesaj gönderildi.");
        }
        catch (Exception ex)
        {
            VoiceMessageButton.Content = "🎙 Ses";
            SetStatus(ex.Message);
        }
    }

    private async void LiveVoiceButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_currentChannel is null) { SetStatus("Önce bir ses kanalı veya kanal seç."); return; }
            if (!_rt.IsConnected) { SetStatus("Canlı ses için gerçek zamanlı bağlantı gerekli."); return; }

            if (!_isLiveVoice)
            {
                await _rt.JoinVoiceAsync(_currentChannel.Id);
                _audio.StartLive(pcm => _rt.SendVoiceFrameAsync(_currentChannel.Id, pcm));
                _isLiveVoice = true;
                LiveVoiceButton.Content = "⏹ Sesten çık";
                SetStatus("Canlı ses başladı.");
            }
            else
            {
                _audio.StopLive();
                await _rt.LeaveVoiceAsync();
                _isLiveVoice = false;
                LiveVoiceButton.Content = "🎧 Ses odası";
                SetStatus("Canlı sesten çıkıldı.");
            }
        }
        catch (Exception ex) { SetStatus(ex.Message); }
    }

    private async void AddFriendButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var username = ActionBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(username)) { SetStatus("Action kutusuna arkadaşının kullanıcı adını yaz."); return; }
            await _api.RequestFriendAsync(username);
            ActionBox.Clear();
            await LoadMeAsync();
            SetStatus("Arkadaşlık isteği gönderildi.");
        }
        catch (Exception ex) { SetStatus(ex.Message); }
    }

    private async void CreateServerButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var name = string.IsNullOrWhiteSpace(ActionBox.Text) ? "Yeni Sunucu" : ActionBox.Text.Trim();
            await _api.CreateServerAsync(name);
            ActionBox.Clear();
            await LoadMeAsync();
            SetStatus("Sunucu oluşturuldu.");
        }
        catch (Exception ex) { SetStatus(ex.Message); }
    }

    private async void JoinServerButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var code = ActionBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(code)) { SetStatus("Action kutusuna davet kodunu yaz."); return; }
            await _api.JoinServerAsync(code);
            ActionBox.Clear();
            await LoadMeAsync();
            SetStatus("Sunucuya katıldın.");
        }
        catch (Exception ex) { SetStatus(ex.Message); }
    }

    private async void CreateChannelButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_currentServer is null) { SetStatus("Önce sunucu seç."); return; }
            var raw = ActionBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(raw)) { SetStatus("Action kutusuna kanal adı yaz."); return; }
            var kind = raw.StartsWith("ses ", StringComparison.OrdinalIgnoreCase) || raw.StartsWith("voice ", StringComparison.OrdinalIgnoreCase) ? "voice" : "text";
            var name = raw.Replace("ses ", "", StringComparison.OrdinalIgnoreCase).Replace("voice ", "", StringComparison.OrdinalIgnoreCase);
            await _api.CreateChannelAsync(_currentServer.Id, name, kind);
            ActionBox.Clear();
            await LoadMeAsync();
            var fresh = _me?.Servers.FirstOrDefault(s => s.Id == _currentServer.Id);
            if (fresh is not null)
            {
                _currentServer = fresh;
                ChannelList.ItemsSource = fresh.Channels;
            }
            SetStatus("Kanal açıldı.");
        }
        catch (Exception ex) { SetStatus(ex.Message); }
    }

    private async void DeleteServerButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_currentServer is null) { SetStatus("Önce sunucu seç."); return; }
            var answer = System.Windows.MessageBox.Show($"{_currentServer.Name} sunucusu tamamen silinsin mi?", "Gaycord", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (answer != MessageBoxResult.Yes) return;
            await _api.DeleteServerAsync(_currentServer.Id);
            _currentServer = null;
            _currentChannel = null;
            await LoadMeAsync();
            HomeButton_Click(this, new RoutedEventArgs());
            SetStatus("Sunucu silindi.");
        }
        catch (Exception ex) { SetStatus(ex.Message); }
    }

    private async void LeaveServerButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_currentServer is null) { SetStatus("Önce sunucu seç."); return; }
            var answer = System.Windows.MessageBox.Show($"{_currentServer.Name} sunucusundan çıkılsın mı?", "Gaycord", MessageBoxButton.YesNo, MessageBoxImage.Question);
            if (answer != MessageBoxResult.Yes) return;
            await _api.LeaveServerAsync(_currentServer.Id);
            _currentServer = null;
            _currentChannel = null;
            await LoadMeAsync();
            HomeButton_Click(this, new RoutedEventArgs());
            SetStatus("Sunucudan çıkıldı.");
        }
        catch (Exception ex) { SetStatus(ex.Message); }
    }

    private async void RefreshButton_Click(object sender, RoutedEventArgs e)
    {
        try { await LoadMeAsync(); SetStatus("Yenilendi."); }
        catch (Exception ex) { SetStatus(ex.Message); }
    }

    private void CopyInviteButton_Click(object sender, RoutedEventArgs e)
    {
        if (_currentServer is null) { SetStatus("Davet kodu için sunucu seç."); return; }
        Clipboard.SetText(_currentServer.InviteCode);
        SetStatus($"Davet kodu kopyalandı: {_currentServer.InviteCode}");
    }

    private void MessageList_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (MessageList.SelectedItem is not MessageView view) return;
        var url = view.Message.Type == "voice" ? view.Message.AudioUrl : view.Message.FileUrl;
        if (string.IsNullOrWhiteSpace(url)) return;
        try
        {
            Process.Start(new ProcessStartInfo(AbsoluteUrl(url)) { UseShellExecute = true });
        }
        catch (Exception ex) { SetStatus(ex.Message); }
    }

    private string AbsoluteUrl(string url)
    {
        if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return url;
        if (url.StartsWith("/")) return _api.BaseUrl.TrimEnd('/') + url;
        return _api.BaseUrl.TrimEnd('/') + "/" + url;
    }

    private void ScrollToLast()
    {
        if (_messages.Count > 0) MessageList.ScrollIntoView(_messages[^1]);
    }

    private void SetStatus(string message)
    {
        ChatSubtitle.Text = message;
        PresenceText.Text = message.Length > 32 ? message[..32] + "..." : message;
    }

    protected override async void OnClosed(EventArgs e)
    {
        _audio.Dispose();
        await _rt.DisposeAsync();
        base.OnClosed(e);
    }
}
