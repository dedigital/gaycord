using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using NAudio.CoreAudioApi;

namespace Gaycord.Native;

// V7.7 — Windows system audio ducking (Core Audio per-app session volume, via NAudio).
//
// While the user is in a Gaycord voice call, lower OTHER apps' audio (like Discord/WhatsApp
// "call focus"), then restore each app's ORIGINAL volume when the call ends / app exits / after
// a crash. Hard rules honored:
//   - OFF by default (MainWindow only activates when AppSettings.DuckOthers is true).
//   - No admin privileges: ISimpleAudioVolume on a session needs none.
//   - Never touches the system MASTER volume (AudioEndpointVolume is never written) — only
//     individual application sessions (SimpleAudioVolume).
//   - Never permanently changes volumes: originals are snapshotted and restored exactly.
//   - Gaycord's own session (this process) and system-sound sessions (pid 0) are excluded.
//   - Optional per-app exclusion list; matches by process name (case-insensitive).
//   - Pure session-volume API; no command execution.
public sealed class AudioDuckingService : IDisposable
{
    private sealed record Snapshot(string Key, uint Pid, string Name, float Volume);

    private readonly object _sync = new();
    private readonly Dictionary<string, Snapshot> _originals = new();
    private bool _active;
    private float _level = 0.5f;

    public bool IsActive { get { lock (_sync) { return _active; } } }

    // Per-app session volume is always supported on Windows; this mirrors the web "supported" flag.
    public static bool IsSupported => OperatingSystem.IsWindows();

    private static string MarkerPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Gaycord", "duck-state.json");

    private static string ProcessName(uint pid)
    {
        if (pid == 0) return "";
        try { return Process.GetProcessById((int)pid).ProcessName ?? ""; }
        catch { return ""; }
    }

    // A session is excluded if it is the system-sounds session (pid 0), our own process, or a
    // process whose name matches the caller-supplied exclusion list.
    private static bool IsExcluded(uint pid, string name, IReadOnlyCollection<string>? exclude)
    {
        if (pid == 0) return true;
        if (pid == (uint)Environment.ProcessId) return true;
        if (name.IndexOf("gaycord", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        if (exclude != null)
        {
            foreach (var ex in exclude)
                if (!string.IsNullOrWhiteSpace(ex) && name.IndexOf(ex, StringComparison.OrdinalIgnoreCase) >= 0) return true;
        }
        return false;
    }

    private static IEnumerable<(AudioSessionControl Session, uint Pid, string Key)> EnumerateSessions()
    {
        var results = new List<(AudioSessionControl, uint, string)>();
        if (!OperatingSystem.IsWindows()) return results;
        try
        {
            // Dispose the enumerator and each endpoint MMDevice (both IDisposable COM wrappers) so a
            // join/leave or duck-level change doesn't leak COM RCWs. The AudioSessionControl entries are
            // intentionally NOT disposed here — the caller reads/sets their volume after enumeration and
            // each holds its own COM ref independent of the endpoint MMDevice.
            using var enumerator = new MMDeviceEnumerator();
            foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            {
                using (device)
                {
                    try
                    {
                        var sessions = device.AudioSessionManager.Sessions;
                        for (int i = 0; i < sessions.Count; i++)
                        {
                            var session = sessions[i];
                            uint pid;
                            try { pid = session.GetProcessID; } catch { continue; }
                            string key;
                            try { key = session.GetSessionInstanceIdentifier ?? $"{pid}"; } catch { key = $"{pid}"; }
                            results.Add((session, pid, key));
                        }
                    }
                    catch { /* skip endpoints we cannot read */ }
                }
            }
        }
        catch { /* Core Audio unavailable — caller treats as no-op */ }
        return results;
    }

    // Lower every other app's session to `level` (0..1), snapshotting originals first.
    public void Activate(float level, IReadOnlyCollection<string>? exclude = null)
    {
        if (!OperatingSystem.IsWindows()) return;
        level = Math.Clamp(level, 0f, 1f);
        lock (_sync)
        {
            _level = level;
            foreach (var (session, pid, key) in EnumerateSessions())
            {
                var name = ProcessName(pid);
                if (IsExcluded(pid, name, exclude)) continue;
                try
                {
                    var simple = session.SimpleAudioVolume;
                    // Snapshot the TRUE original once (so restore is exact), before we change anything.
                    if (!_originals.ContainsKey(key))
                        _originals[key] = new Snapshot(key, pid, name, simple.Volume);
                    // Only ever LOWER: never raise an app already quieter than the duck level. The target
                    // is min(original, level) — an app at 10% stays 10% even when ducking to 50%.
                    var original = _originals[key].Volume;
                    var target = Math.Min(original, level);
                    if (simple.Volume > target) simple.Volume = target;
                }
                catch { /* skip sessions we cannot read/set */ }
            }
            _active = true;
            WriteMarker();
        }
    }

    // Restore every snapshotted session to its original volume and clear state.
    public void Deactivate()
    {
        lock (_sync)
        {
            if (OperatingSystem.IsWindows() && _originals.Count > 0)
            {
                var live = EnumerateSessions().ToList();
                foreach (var snap in _originals.Values)
                {
                    var match = live.FirstOrDefault(s => s.Key == snap.Key);
                    if (match.Session == null) match = live.FirstOrDefault(s => s.Pid == snap.Pid);
                    if (match.Session == null) continue;
                    try { match.Session.SimpleAudioVolume.Volume = snap.Volume; } catch { }
                }
            }
            _originals.Clear();
            _active = false;
            ClearMarker();
        }
    }

    // After an unclean exit, restore volumes recorded in the marker (best effort) and clear it.
    public void RecoverFromCrash()
    {
        try
        {
            if (!File.Exists(MarkerPath)) return;
            var json = File.ReadAllText(MarkerPath);
            var data = JsonSerializer.Deserialize<MarkerData>(json);
            if (data is null || !data.Active || data.Snapshot is null || data.Snapshot.Count == 0) { ClearMarker(); return; }
            lock (_sync)
            {
                _originals.Clear();
                foreach (var s in data.Snapshot) _originals[s.Key] = new Snapshot(s.Key, s.Pid, s.Name, s.Volume);
            }
            Deactivate();
        }
        catch { ClearMarker(); }
    }

    private void WriteMarker()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(MarkerPath)!);
            var data = new MarkerData
            {
                Active = _active,
                Level = _level,
                Snapshot = _originals.Values.Select(o => new MarkerEntry { Key = o.Key, Pid = o.Pid, Name = o.Name, Volume = o.Volume }).ToList()
            };
            File.WriteAllText(MarkerPath, JsonSerializer.Serialize(data));
        }
        catch { /* best effort */ }
    }

    private static void ClearMarker()
    {
        try { if (File.Exists(MarkerPath)) File.Delete(MarkerPath); }
        catch { }
    }

    public void Dispose() => Deactivate();

    private sealed class MarkerData
    {
        public bool Active { get; set; }
        public float Level { get; set; }
        public List<MarkerEntry>? Snapshot { get; set; }
    }
    private sealed class MarkerEntry
    {
        public string Key { get; set; } = "";
        public uint Pid { get; set; }
        public string Name { get; set; } = "";
        public float Volume { get; set; }
    }
}
