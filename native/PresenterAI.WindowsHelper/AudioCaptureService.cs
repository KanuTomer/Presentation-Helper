using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace PresenterAI.WindowsHelper;

internal sealed record AudioDevice(string Id, string Name, bool IsDefault);
internal sealed record AudioCaptureResult(string Path, long DurationMs, long Bytes, int SampleRate, int Channels, string EndpointId);

internal sealed class AudioCaptureService
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private WasapiLoopbackCapture? capture;
    private WaveFileWriter? writer;
    private TaskCompletionSource<bool>? stopped;
    private string? outputPath;
    private string? rawPath;
    public string? ActiveEndpointId { get; private set; }
    public DateTimeOffset? StartedAt { get; private set; }

    public IReadOnlyList<AudioDevice> ListDevices()
    {
        using var enumerator = new MMDeviceEnumerator();
        string? defaultId = null;
        try { defaultId = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia).ID; } catch { }
        return enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
            .Select(device => new AudioDevice(device.ID, device.FriendlyName, device.ID == defaultId)).ToArray();
    }

    public async Task StartAsync(string path, string? endpointId)
    {
        await gate.WaitAsync();
        try
        {
            if (capture is not null) throw new InvalidOperationException("Capture is already active.");
            Directory.CreateDirectory(Path.GetDirectoryName(path) ?? throw new ArgumentException("Capture path has no parent directory."));
            using var enumerator = new MMDeviceEnumerator();
            var device = string.IsNullOrWhiteSpace(endpointId)
                ? enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia)
                : enumerator.GetDevice(endpointId);
            outputPath = path;
            rawPath = $"{path}.raw.wav";
            ActiveEndpointId = device.ID;
            capture = new WasapiLoopbackCapture(device);
            writer = new WaveFileWriter(rawPath, capture.WaveFormat);
            stopped = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            capture.DataAvailable += OnDataAvailable;
            capture.RecordingStopped += OnRecordingStopped;
            capture.StartRecording();
            StartedAt = DateTimeOffset.UtcNow;
        }
        catch
        {
            DisposeCapture();
            throw;
        }
        finally { gate.Release(); }
    }

    public async Task<AudioCaptureResult> StopAsync()
    {
        await gate.WaitAsync();
        try
        {
            if (capture is null || outputPath is null || rawPath is null || stopped is null) throw new InvalidOperationException("Capture is not active.");
            var finalPath = outputPath;
            var sourcePath = rawPath;
            var endpoint = ActiveEndpointId!;
            capture.StopRecording();
            await stopped.Task.WaitAsync(TimeSpan.FromSeconds(5));
            DisposeCapture();
            ConvertToPcm16kMono(sourcePath, finalPath);
            File.Delete(sourcePath);
            using var reader = new WaveFileReader(finalPath);
            var duration = (long)reader.TotalTime.TotalMilliseconds;
            var bytes = new FileInfo(finalPath).Length;
            if (duration < 250 || bytes <= 44)
            {
                File.Delete(finalPath);
                throw new InvalidOperationException("The recording was too short. Hold the shortcut until the reviewer finishes speaking.");
            }
            ResetState();
            return new AudioCaptureResult(finalPath, duration, bytes, reader.WaveFormat.SampleRate, reader.WaveFormat.Channels, endpoint);
        }
        catch
        {
            await DeleteFilesAsync();
            DisposeCapture();
            ResetState();
            throw;
        }
        finally { gate.Release(); }
    }

    public async Task CancelAsync()
    {
        await gate.WaitAsync();
        try
        {
            if (capture is not null)
            {
                capture.StopRecording();
                if (stopped is not null) await stopped.Task.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
            }
            DisposeCapture();
            await DeleteFilesAsync();
            ResetState();
        }
        finally { gate.Release(); }
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs args) => writer?.Write(args.Buffer, 0, args.BytesRecorded);
    private void OnRecordingStopped(object? sender, StoppedEventArgs args)
    {
        writer?.Flush();
        writer?.Dispose();
        writer = null;
        if (args.Exception is not null) stopped?.TrySetException(args.Exception); else stopped?.TrySetResult(true);
    }
    private static void ConvertToPcm16kMono(string source, string destination)
    {
        using var reader = new AudioFileReader(source);
        ISampleProvider samples = reader;
        if (samples.WaveFormat.Channels > 1) samples = new DownmixToMonoSampleProvider(samples);
        if (samples.WaveFormat.SampleRate != 16_000) samples = new WdlResamplingSampleProvider(samples, 16_000);
        WaveFileWriter.CreateWaveFile16(destination, samples);
    }
    private async Task DeleteFilesAsync()
    {
        foreach (var path in new[] { outputPath, rawPath }.Where(path => !string.IsNullOrWhiteSpace(path)))
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { await Task.Delay(50); try { if (File.Exists(path)) File.Delete(path); } catch { } }
        }
    }
    private void DisposeCapture()
    {
        if (capture is not null)
        {
            capture.DataAvailable -= OnDataAvailable;
            capture.RecordingStopped -= OnRecordingStopped;
            capture.Dispose();
        }
        capture = null;
        writer?.Dispose();
        writer = null;
    }
    private void ResetState() { outputPath = null; rawPath = null; ActiveEndpointId = null; StartedAt = null; stopped = null; }
}

internal sealed class DownmixToMonoSampleProvider : ISampleProvider
{
    private readonly ISampleProvider source;
    private readonly int channels;
    private float[] sourceBuffer = [];
    public WaveFormat WaveFormat { get; }
    public DownmixToMonoSampleProvider(ISampleProvider source)
    {
        this.source = source;
        channels = source.WaveFormat.Channels;
        if (channels < 2) throw new ArgumentException("Source is already mono.");
        WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(source.WaveFormat.SampleRate, 1);
    }
    public int Read(float[] buffer, int offset, int count)
    {
        var required = count * channels;
        if (sourceBuffer.Length < required) sourceBuffer = new float[required];
        var read = source.Read(sourceBuffer, 0, required);
        var frames = read / channels;
        for (var frame = 0; frame < frames; frame++)
        {
            float sum = 0;
            for (var channel = 0; channel < channels; channel++) sum += sourceBuffer[frame * channels + channel];
            buffer[offset + frame] = sum / channels;
        }
        return frames;
    }
}
