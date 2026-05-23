using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Gaycord.Native;

public sealed class RealtimeClient : IAsyncDisposable
{
    private readonly JsonSerializerOptions _jsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private ClientWebSocket? _ws;
    private CancellationTokenSource? _cts;

    public event Action<ChatMessageDto>? MessageReceived;
    public event Action<string, List<ChatMessageDto>>? JoinedChannel;
    public event Action<string[]>? PresenceUpdated;
    public event Action<string, UserDto?, byte[]>? VoiceFrameReceived;
    public event Action<string>? StatusChanged;
    public event Action<string>? ErrorReceived;

    public bool IsConnected => _ws?.State == WebSocketState.Open;

    public async Task ConnectAsync(string baseUrl, string token)
    {
        await DisposeSocketAsync().ConfigureAwait(false);
        var wsUrl = ToWebSocketUrl(baseUrl, token);
        _ws = new ClientWebSocket();
        _cts = new CancellationTokenSource();
        StatusChanged?.Invoke("bağlanıyor");
        await _ws.ConnectAsync(new Uri(wsUrl), _cts.Token).ConfigureAwait(false);
        StatusChanged?.Invoke("bağlı");
        _ = Task.Run(() => ReceiveLoopAsync(_cts.Token));
    }

    public Task JoinChannelAsync(string channelId) => SendAsync(new { type = "join_channel", channelId });
    public Task LeaveChannelAsync(string channelId) => SendAsync(new { type = "leave_channel", channelId });
    public Task JoinVoiceAsync(string channelId) => SendAsync(new { type = "voice_join", channelId });
    public Task LeaveVoiceAsync() => SendAsync(new { type = "voice_leave" });

    public Task SendVoiceFrameAsync(string channelId, byte[] pcm)
    {
        var pcmBase64 = Convert.ToBase64String(pcm);
        return SendAsync(new { type = "voice_frame", channelId, pcmBase64 });
    }

    private async Task SendAsync(object payload)
    {
        if (_ws?.State != WebSocketState.Open) return;
        var json = JsonSerializer.Serialize(payload, _jsonOptions);
        var bytes = Encoding.UTF8.GetBytes(json);
        await _sendLock.WaitAsync().ConfigureAwait(false);
        try
        {
            await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts?.Token ?? CancellationToken.None).ConfigureAwait(false);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private async Task ReceiveLoopAsync(CancellationToken token)
    {
        var buffer = new byte[128 * 1024];
        try
        {
            while (!token.IsCancellationRequested && _ws?.State == WebSocketState.Open)
            {
                using var ms = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), token).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        StatusChanged?.Invoke("koptu");
                        return;
                    }
                    ms.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                var text = Encoding.UTF8.GetString(ms.ToArray());
                HandleMessage(text);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            ErrorReceived?.Invoke(ex.Message);
            StatusChanged?.Invoke("hata");
        }
    }

    private void HandleMessage(string text)
    {
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var typeElement)) return;
            var type = typeElement.GetString() ?? "";

            switch (type)
            {
                case "message:new":
                    if (root.TryGetProperty("message", out var msgElement))
                    {
                        var msg = msgElement.Deserialize<ChatMessageDto>(_jsonOptions);
                        if (msg is not null) MessageReceived?.Invoke(msg);
                    }
                    break;
                case "joined_channel":
                    {
                        var channelId = root.TryGetProperty("channelId", out var ch) ? ch.GetString() ?? "" : "";
                        var messages = root.TryGetProperty("messages", out var m)
                            ? m.Deserialize<List<ChatMessageDto>>(_jsonOptions) ?? new List<ChatMessageDto>()
                            : new List<ChatMessageDto>();
                        JoinedChannel?.Invoke(channelId, messages);
                        break;
                    }
                case "presence:update":
                    {
                        var ids = root.TryGetProperty("onlineIds", out var idsEl)
                            ? idsEl.Deserialize<string[]>(_jsonOptions) ?? Array.Empty<string>()
                            : Array.Empty<string>();
                        PresenceUpdated?.Invoke(ids);
                        break;
                    }
                case "voice:frame":
                    {
                        var channelId = root.TryGetProperty("channelId", out var ch) ? ch.GetString() ?? "" : "";
                        var pcmBase64 = root.TryGetProperty("pcmBase64", out var pcm) ? pcm.GetString() ?? "" : "";
                        var from = root.TryGetProperty("from", out var fromEl) ? fromEl.Deserialize<UserDto>(_jsonOptions) : null;
                        if (!string.IsNullOrWhiteSpace(pcmBase64)) VoiceFrameReceived?.Invoke(channelId, from, Convert.FromBase64String(pcmBase64));
                        break;
                    }
                case "voice:joined":
                    StatusChanged?.Invoke("ses odasında");
                    break;
                case "error":
                    var error = root.TryGetProperty("error", out var err) ? err.GetString() ?? "Bilinmeyen hata" : "Bilinmeyen hata";
                    ErrorReceived?.Invoke(error);
                    break;
            }
        }
        catch (Exception ex)
        {
            ErrorReceived?.Invoke(ex.Message);
        }
    }

    private static string ToWebSocketUrl(string baseUrl, string token)
    {
        var url = baseUrl.Trim().TrimEnd('/');
        if (url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) url = "wss://" + url[8..];
        else if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) url = "ws://" + url[7..];
        else url = "wss://" + url;
        return $"{url}/native?token={Uri.EscapeDataString(token)}";
    }

    private async Task DisposeSocketAsync()
    {
        try { _cts?.Cancel(); } catch { }
        if (_ws is not null)
        {
            try
            {
                if (_ws.State == WebSocketState.Open) await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None).ConfigureAwait(false);
            }
            catch { }
            _ws.Dispose();
        }
        _ws = null;
        _cts?.Dispose();
        _cts = null;
    }

    public async ValueTask DisposeAsync() => await DisposeSocketAsync().ConfigureAwait(false);
}
