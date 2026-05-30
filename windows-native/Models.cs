using System.Globalization;

namespace Gaycord.Native;

public sealed class UserDto
{
    public string Id { get; set; } = "";
    public string Username { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string CreatedAt { get; set; } = "";
    public bool Online { get; set; }
    public override string ToString() => $"{DisplayName} (@{Username})";
}

public sealed class ChannelDto
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public string Kind { get; set; } = "text";
    public string ServerId { get; set; } = "";
    public string Name { get; set; } = "";
    public override string ToString() => Kind == "voice" ? $"🔊 {Name}" : $"# {Name}";
}

public sealed class ServerDto
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string OwnerId { get; set; } = "";
    public string InviteCode { get; set; } = "";
    public List<string> MemberIds { get; set; } = new();
    public List<ChannelDto> Channels { get; set; } = new();
    public override string ToString() => Name;
}

public sealed class FriendRequestDto
{
    public string Id { get; set; } = "";
    public UserDto? From { get; set; }
    public UserDto? To { get; set; }
    public string CreatedAt { get; set; } = "";
}

public sealed class FriendsDto
{
    public List<UserDto> Friends { get; set; } = new();
    public List<FriendRequestDto> IncomingRequests { get; set; } = new();
    public List<FriendRequestDto> OutgoingRequests { get; set; } = new();
}

public sealed class MeDto
{
    public UserDto? User { get; set; }
    public FriendsDto Friends { get; set; } = new();
    public List<ServerDto> Servers { get; set; } = new();
    public List<string> OnlineIds { get; set; } = new();
}

public sealed class AuthResponse
{
    public UserDto? User { get; set; }
    public string Token { get; set; } = "";
}

public sealed class ChannelResponse
{
    public ChannelDto? Channel { get; set; }
}

public sealed class ServerResponse
{
    public ServerDto? Server { get; set; }
    public ChannelDto? Channel { get; set; }
}

public sealed class MessagesResponse
{
    public List<ChatMessageDto> Messages { get; set; } = new();
}

public sealed class MessageResponse
{
    public ChatMessageDto? Message { get; set; }
}

public sealed class ApiError
{
    public string Error { get; set; } = "";
}

public sealed class ChatMessageDto
{
    public string Id { get; set; } = "";
    public string ChannelId { get; set; } = "";
    public string Type { get; set; } = "text";
    public UserDto? User { get; set; }
    public string Text { get; set; } = "";
    public string AudioUrl { get; set; } = "";
    public string FileUrl { get; set; } = "";
    public string FileName { get; set; } = "";
    public string MimeType { get; set; } = "";
    public long? SizeBytes { get; set; }
    public int? DurationMs { get; set; }
    public string CreatedAt { get; set; } = "";
}

public sealed class MessageView
{
    public ChatMessageDto Message { get; }
    public string Header { get; }
    public string Body { get; }
    public string Hint { get; }

    public MessageView(ChatMessageDto message)
    {
        Message = message;
        var user = message.User?.DisplayName ?? message.User?.Username ?? "Bilinmeyen";
        Header = $"{user} • {FormatTime(message.CreatedAt)}";

        if (message.Type == "voice")
        {
            Body = $"🎙 Sesli mesaj ({FormatDuration(message.DurationMs)})";
            Hint = "Dinlemek için çift tıkla.";
        }
        else if (message.Type == "file")
        {
            Body = $"📎 {message.FileName} {FormatBytes(message.SizeBytes)}";
            Hint = "Açmak için çift tıkla.";
        }
        else
        {
            Body = message.Text;
            Hint = "";
        }
    }

    private static string FormatTime(string iso)
    {
        if (DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var dto))
            return dto.ToLocalTime().ToString("HH:mm");
        return "";
    }

    private static string FormatDuration(int? ms)
    {
        if (!ms.HasValue || ms.Value <= 0) return "kısa";
        var ts = TimeSpan.FromMilliseconds(ms.Value);
        return ts.TotalMinutes >= 1 ? $"{(int)ts.TotalMinutes}:{ts.Seconds:00}" : $"{ts.Seconds} sn";
    }

    private static string FormatBytes(long? bytes)
    {
        if (!bytes.HasValue) return "";
        if (bytes.Value < 1024) return $"({bytes.Value} B)";
        if (bytes.Value < 1024 * 1024) return $"({bytes.Value / 1024.0:0.#} KB)";
        return $"({bytes.Value / 1024.0 / 1024.0:0.#} MB)";
    }
}

public sealed class FriendListItem
{
    public string Kind { get; set; } = "friend";
    public UserDto? User { get; set; }
    public string RequestId { get; set; } = "";

    public override string ToString()
    {
        var userText = User is null ? "Bilinmeyen" : $"{User.DisplayName} (@{User.Username})";
        return Kind switch
        {
            "incoming" => $"✅ Kabul et: {userText}",
            "outgoing" => $"⏳ Bekleniyor: {userText}",
            _ => User?.Online == true ? $"🟢 {userText}" : $"⚫ {userText}"
        };
    }
}

public sealed class LocalSettings
{
    public string ServerUrl { get; set; } = "https://gaycord.onrender.com";
    public string Token { get; set; } = "";
    public string Username { get; set; } = "";
    // V7.7 system audio ducking prefs (non-sensitive). OFF by default; DuckLevel = % other apps are lowered to.
    public bool DuckOthers { get; set; } = false;
    public int DuckLevel { get; set; } = 50;
}
