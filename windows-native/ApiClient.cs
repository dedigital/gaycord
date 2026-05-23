using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace ArkadasOdasi.Native;

public sealed class ApiClient
{
    private readonly HttpClient _http = new();
    private readonly JsonSerializerOptions _jsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public string BaseUrl { get; private set; } = "";
    public string Token { get; private set; } = "";

    public void Configure(string baseUrl, string token = "")
    {
        if (string.IsNullOrWhiteSpace(baseUrl)) throw new InvalidOperationException("Sunucu URL boş olamaz.");
        BaseUrl = baseUrl.Trim().TrimEnd('/');
        Token = token.Trim();
    }

    public void SetToken(string token) => Token = token.Trim();

    public Task<AuthResponse> LoginAsync(string username, string password) =>
        SendAsync<AuthResponse>(HttpMethod.Post, "/api/login", new { username, password });

    public Task<AuthResponse> RegisterAsync(string username, string displayName, string password) =>
        SendAsync<AuthResponse>(HttpMethod.Post, "/api/register", new { username, displayName, password });

    public Task<MeDto> GetMeAsync() => SendAsync<MeDto>(HttpMethod.Get, "/api/me");

    public Task<ServerResponse> CreateServerAsync(string name) =>
        SendAsync<ServerResponse>(HttpMethod.Post, "/api/servers", new { name });

    public Task<ServerResponse> JoinServerAsync(string inviteCode) =>
        SendAsync<ServerResponse>(HttpMethod.Post, "/api/servers/join", new { inviteCode });

    public Task<ServerResponse> CreateChannelAsync(string serverId, string name, string kind = "text") =>
        SendAsync<ServerResponse>(HttpMethod.Post, $"/api/servers/{Uri.EscapeDataString(serverId)}/channels", new { name, kind });

    public Task<ChannelResponse> GetDmAsync(string friendId) =>
        SendAsync<ChannelResponse>(HttpMethod.Get, $"/api/dms/{Uri.EscapeDataString(friendId)}");

    public Task<MessagesResponse> GetMessagesAsync(string channelId) =>
        SendAsync<MessagesResponse>(HttpMethod.Get, $"/api/channels/{Uri.EscapeDataString(channelId)}/messages");

    public Task<MessageResponse> SendTextAsync(string channelId, string text) =>
        SendAsync<MessageResponse>(HttpMethod.Post, $"/api/channels/{Uri.EscapeDataString(channelId)}/messages", new { type = "text", text });

    public Task<MessageResponse> SendVoiceAsync(string channelId, string audioData, int durationMs) =>
        SendAsync<MessageResponse>(HttpMethod.Post, $"/api/channels/{Uri.EscapeDataString(channelId)}/messages", new { type = "voice", audioData, mimeType = "audio/wav", fileName = "voice.wav", durationMs });

    public Task RequestFriendAsync(string username) =>
        SendAsync<object>(HttpMethod.Post, "/api/friends/request", new { username });

    public Task RespondFriendAsync(string requestId, bool accept) =>
        SendAsync<object>(HttpMethod.Post, "/api/friends/respond", new { requestId, accept });

    private async Task<T> SendAsync<T>(HttpMethod method, string path, object? body = null)
    {
        if (string.IsNullOrWhiteSpace(BaseUrl)) throw new InvalidOperationException("Önce sunucu URL ayarlanmalı.");
        using var request = new HttpRequestMessage(method, BaseUrl + path);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (!string.IsNullOrWhiteSpace(Token)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        if (body is not null)
        {
            var json = JsonSerializer.Serialize(body, _jsonOptions);
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }

        using var response = await _http.SendAsync(request).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            try
            {
                var apiError = JsonSerializer.Deserialize<ApiError>(text, _jsonOptions);
                if (!string.IsNullOrWhiteSpace(apiError?.Error)) throw new InvalidOperationException(apiError.Error);
            }
            catch (JsonException) { }
            throw new InvalidOperationException($"Sunucu hatası: {(int)response.StatusCode}");
        }

        if (typeof(T) == typeof(object)) return (T)(object)new object();
        var result = JsonSerializer.Deserialize<T>(text, _jsonOptions);
        if (result is null) throw new InvalidOperationException("Sunucudan boş cevap geldi.");
        return result;
    }
}
