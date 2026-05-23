using System.IO;
using NAudio.Wave;

namespace ArkadasOdasi.Native;

public sealed class AudioService : IDisposable
{
    public static readonly WaveFormat ChatFormat = new(16000, 16, 1);

    private WaveInEvent? _messageRecorder;
    private MemoryStream? _messagePcm;
    private DateTimeOffset _messageStartedAt;

    private WaveInEvent? _liveRecorder;
    private WaveOutEvent? _liveOutput;
    private BufferedWaveProvider? _playbackBuffer;

    public bool IsMessageRecording => _messageRecorder is not null;
    public bool IsLive => _liveRecorder is not null;

    public void StartMessageRecording()
    {
        if (_messageRecorder is not null) throw new InvalidOperationException("Zaten kayıt alınıyor.");
        _messagePcm = new MemoryStream();
        _messageStartedAt = DateTimeOffset.Now;
        _messageRecorder = new WaveInEvent { WaveFormat = ChatFormat, BufferMilliseconds = 80 };
        _messageRecorder.DataAvailable += (_, e) => _messagePcm?.Write(e.Buffer, 0, e.BytesRecorded);
        _messageRecorder.StartRecording();
    }

    public async Task<(byte[] Wav, int DurationMs)> StopMessageRecordingAsync()
    {
        var recorder = _messageRecorder ?? throw new InvalidOperationException("Kayıt başlamamış.");
        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        recorder.RecordingStopped += (_, _) => tcs.TrySetResult();
        recorder.StopRecording();
        await tcs.Task.ConfigureAwait(false);
        recorder.Dispose();
        _messageRecorder = null;
        var pcm = _messagePcm?.ToArray() ?? Array.Empty<byte>();
        _messagePcm?.Dispose();
        _messagePcm = null;
        var duration = (int)Math.Max(0, (DateTimeOffset.Now - _messageStartedAt).TotalMilliseconds);
        return (CreateWav(pcm, ChatFormat.SampleRate, ChatFormat.BitsPerSample, ChatFormat.Channels), duration);
    }

    public async Task CancelMessageRecordingAsync()
    {
        if (_messageRecorder is null) return;
        try { await StopMessageRecordingAsync().ConfigureAwait(false); } catch { }
    }

    public void StartLive(Func<byte[], Task> onPcmFrame)
    {
        if (_liveRecorder is not null) return;
        _playbackBuffer = new BufferedWaveProvider(ChatFormat)
        {
            BufferDuration = TimeSpan.FromSeconds(4),
            DiscardOnBufferOverflow = true
        };
        _liveOutput = new WaveOutEvent();
        _liveOutput.Init(_playbackBuffer);
        _liveOutput.Play();

        _liveRecorder = new WaveInEvent { WaveFormat = ChatFormat, BufferMilliseconds = 60 };
        _liveRecorder.DataAvailable += async (_, e) =>
        {
            var copy = new byte[e.BytesRecorded];
            Buffer.BlockCopy(e.Buffer, 0, copy, 0, e.BytesRecorded);
            try { await onPcmFrame(copy).ConfigureAwait(false); } catch { }
        };
        _liveRecorder.StartRecording();
    }

    public void PlayRemote(byte[] pcm)
    {
        try { _playbackBuffer?.AddSamples(pcm, 0, pcm.Length); } catch { }
    }

    public void StopLive()
    {
        try { _liveRecorder?.StopRecording(); } catch { }
        try { _liveRecorder?.Dispose(); } catch { }
        try { _liveOutput?.Stop(); } catch { }
        try { _liveOutput?.Dispose(); } catch { }
        _liveRecorder = null;
        _liveOutput = null;
        _playbackBuffer = null;
    }

    private static byte[] CreateWav(byte[] pcm, int sampleRate, int bitsPerSample, int channels)
    {
        using var ms = new MemoryStream();
        using var bw = new BinaryWriter(ms);
        var byteRate = sampleRate * channels * bitsPerSample / 8;
        var blockAlign = channels * bitsPerSample / 8;
        bw.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
        bw.Write(36 + pcm.Length);
        bw.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
        bw.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
        bw.Write(16);
        bw.Write((short)1);
        bw.Write((short)channels);
        bw.Write(sampleRate);
        bw.Write(byteRate);
        bw.Write((short)blockAlign);
        bw.Write((short)bitsPerSample);
        bw.Write(System.Text.Encoding.ASCII.GetBytes("data"));
        bw.Write(pcm.Length);
        bw.Write(pcm);
        return ms.ToArray();
    }

    public void Dispose()
    {
        StopLive();
        try { _messageRecorder?.Dispose(); } catch { }
        try { _messagePcm?.Dispose(); } catch { }
    }
}
