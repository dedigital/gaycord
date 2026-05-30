using System.Reflection;
using System.Threading.Tasks;
using Velopack;
using Velopack.Sources;

namespace Gaycord.Native;

// V7.8 — Windows auto-updater wrapper around Velopack.
//
// Security model:
//   - Updates come ONLY from the official public GitHub Releases of dedigital/gaycord (UpdateUrl).
//   - No access token is used or stored (public repo); no secrets are embedded in the app.
//   - prerelease:false → only published stable releases/tags are ever offered. PR/CI artifacts are
//     never release assets, so they can never be installed.
//   - Velopack verifies update-package integrity (the SHA in its release feed) before applying; we
//     never download or execute arbitrary URLs or scripts.
//   - UpdateUrl is a compile-time constant, never user/server input.
public sealed class UpdateService
{
    public const string UpdateUrl = "https://github.com/dedigital/gaycord";

    private readonly UpdateManager _mgr;

    public UpdateService()
    {
        // accessToken: null (public repo, no credentials); prerelease: false (stable releases only).
        _mgr = new UpdateManager(new GithubSource(UpdateUrl, null, false));
    }

    // True only when running as a Velopack-installed app (so an in-place update is possible). False for
    // a plain dev / `dotnet run` build, in which case the UI explains updates come via GitHub Releases.
    public bool IsInstalled => _mgr.IsInstalled;

    public string CurrentVersion
    {
        get
        {
            var v = _mgr.CurrentVersion;
            if (v != null) return v.ToString();
            var asm = Assembly.GetEntryAssembly()?.GetName().Version;
            return asm != null ? $"{asm.Major}.{asm.Minor}.{asm.Build}" : "?";
        }
    }

    // Returns the available update, or null if already up to date / not a Velopack install.
    public async Task<UpdateInfo?> CheckForUpdatesAsync()
    {
        if (!_mgr.IsInstalled) return null;
        return await _mgr.CheckForUpdatesAsync().ConfigureAwait(false);
    }

    public async Task DownloadAsync(UpdateInfo info, System.Action<int>? progress = null)
    {
        await _mgr.DownloadUpdatesAsync(info, progress).ConfigureAwait(false);
    }

    // Applies the downloaded update and restarts the app. Velopack swaps the versioned app folder
    // atomically; on failure the current version keeps running.
    public void ApplyAndRestart(UpdateInfo info)
    {
        _mgr.ApplyUpdatesAndRestart(info);
    }
}
