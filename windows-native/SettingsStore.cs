using System.IO;
using System.Text.Json;

namespace ArkadasOdasi.Native;

public static class SettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public static string SettingsDirectory => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ArkadasOdasi");
    public static string SettingsPath => Path.Combine(SettingsDirectory, "settings.json");

    public static LocalSettings Load()
    {
        var settings = new LocalSettings();
        try
        {
            if (File.Exists(SettingsPath))
            {
                settings = JsonSerializer.Deserialize<LocalSettings>(File.ReadAllText(SettingsPath), JsonOptions) ?? settings;
            }
        }
        catch { }

        try
        {
            var serverFile = Path.Combine(AppContext.BaseDirectory, "server.txt");
            if (File.Exists(serverFile))
            {
                var server = File.ReadAllText(serverFile).Trim();
                if (!string.IsNullOrWhiteSpace(server)) settings.ServerUrl = server;
            }
        }
        catch { }

        return settings;
    }

    public static void Save(LocalSettings settings)
    {
        Directory.CreateDirectory(SettingsDirectory);
        File.WriteAllText(SettingsPath, JsonSerializer.Serialize(settings, JsonOptions));
    }
}
