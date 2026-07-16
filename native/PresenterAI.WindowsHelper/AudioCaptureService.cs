using NAudio.CoreAudioApi;
using NAudio.Utils;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace PresenterAI.WindowsHelper;

internal sealed record AudioDevice(string Id, string Name, bool IsDefault);

internal sealed record AudioCaptureResult(
    string Path,
    long DurationMs,
    long Bytes,
    int SampleRate,
    int Channels,
    string EndpointId,
    string EndpointName,
    string TerminalReason);

internal sealed record AudioCaptureLimit(string OperationId, string Reason);

internal sealed class AudioCaptureException(string code, string message, Exception? innerException = null)
    : Exception(message, innerException)
{
    public string Code { get; } = code;
}

internal interface ILoopbackCaptureFactory
{
    IReadOnlyList<AudioDevice> ListDevices();
    ILoopbackCapture Create(string? endpointId);
}

internal interface ILoopbackCapture : IDisposable
{
    string EndpointId { get; }
    string EndpointName { get; }
    WaveFormat WaveFormat { get; }
    event Action<byte[], int>? DataAvailable;
    event Action<Exception?>? RecordingStopped;
    void Start();
    void Stop();
}

internal sealed class WasapiLoopbackCaptureFactory : ILoopbackCaptureFactory
{
    public IReadOnlyList<AudioDevice> ListDevices()
    {
        using var enumerator = new MMDeviceEnumerator();
        string? defaultId = null;
        try
        {
            using var defaultDevice = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            defaultId = defaultDevice.ID;
        }
        catch
        {
            // A machine without a render endpoint legitimately has no default device.
        }

        var endpoints = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active);
        var devices = new List<AudioDevice>(endpoints.Count);
        foreach (var endpoint in endpoints)
        {
            using (endpoint)
            {
                devices.Add(new AudioDevice(endpoint.ID, endpoint.FriendlyName, endpoint.ID == defaultId));
            }
        }
        return devices;
    }

    public ILoopbackCapture Create(string? endpointId)
    {
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            var device = string.IsNullOrWhiteSpace(endpointId)
                ? enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia)
                : enumerator.GetDevice(endpointId);
            return new WasapiLoopbackCaptureAdapter(device);
        }
        catch (Exception error)
        {
            throw new AudioCaptureException(
                "device_unavailable",
                string.IsNullOrWhiteSpace(endpointId)
                    ? "The current Windows output device is unavailable."
                    : "The selected Windows output device is unavailable.",
                error);
        }
    }
}

internal sealed class WasapiLoopbackCaptureAdapter : ILoopbackCapture
{
    private readonly MMDevice device;
    private readonly WasapiLoopbackCapture capture;
    private int disposed;

    public WasapiLoopbackCaptureAdapter(MMDevice device)
    {
        this.device = device;
        EndpointId = device.ID;
        EndpointName = device.FriendlyName;
        capture = new WasapiLoopbackCapture(device);
        capture.DataAvailable += OnDataAvailable;
        capture.RecordingStopped += OnRecordingStopped;
    }

    public string EndpointId { get; }
    public string EndpointName { get; }
    public WaveFormat WaveFormat => capture.WaveFormat;
    public event Action<byte[], int>? DataAvailable;
    public event Action<Exception?>? RecordingStopped;

    public void Start() => capture.StartRecording();
    public void Stop() => capture.StopRecording();

    private void OnDataAvailable(object? sender, WaveInEventArgs args) =>
        DataAvailable?.Invoke(args.Buffer, args.BytesRecorded);

    private void OnRecordingStopped(object? sender, StoppedEventArgs args) =>
        RecordingStopped?.Invoke(args.Exception);

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        capture.DataAvailable -= OnDataAvailable;
        capture.RecordingStopped -= OnRecordingStopped;
        capture.Dispose();
        device.Dispose();
    }
}

internal sealed class AudioCaptureService
{
    internal static readonly TimeSpan DefaultMaximumDuration = TimeSpan.FromSeconds(90);
    // Keep the full in-memory WAV, including headers and MemoryStream growth, below 128 MiB.
    internal const long DefaultMaximumRawBytes = (128L * 1024 * 1024) - 4_096;
    internal const long MinimumDurationMs = 250;

    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly object ioLock = new();
    private readonly ILoopbackCaptureFactory captureFactory;
    private readonly TimeSpan maximumDuration;
    private readonly long maximumRawBytes;
    private readonly long minimumDurationMs;
    private readonly Func<DateTimeOffset> utcNow;

    private ILoopbackCapture? capture;
    private MemoryStream? capturedWave;
    private WaveFileWriter? writer;
    private TaskCompletionSource<bool>? stopped;
    private Timer? limitTimer;
    private string? outputPath;
    private string? terminalReason;
    private long rawBytes;
    private int stopRequested;
    private int limitSignaled;

    public AudioCaptureService(
        ILoopbackCaptureFactory? captureFactory = null,
        TimeSpan? maximumDuration = null,
        long maximumRawBytes = DefaultMaximumRawBytes,
        long minimumDurationMs = MinimumDurationMs,
        Func<DateTimeOffset>? utcNow = null)
    {
        if (maximumDuration is { } duration && duration <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(maximumDuration));
        if (maximumRawBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maximumRawBytes));
        if (minimumDurationMs < 0) throw new ArgumentOutOfRangeException(nameof(minimumDurationMs));
        this.captureFactory = captureFactory ?? new WasapiLoopbackCaptureFactory();
        this.maximumDuration = maximumDuration ?? DefaultMaximumDuration;
        this.maximumRawBytes = maximumRawBytes;
        this.minimumDurationMs = minimumDurationMs;
        this.utcNow = utcNow ?? (() => DateTimeOffset.UtcNow);
    }

    public string? ActiveOperationId { get; private set; }
    public string? ActiveEndpointId { get; private set; }
    public string? ActiveEndpointName { get; private set; }
    public DateTimeOffset? StartedAt { get; private set; }
    public event Action<AudioCaptureLimit>? CaptureLimitReached;

    public IReadOnlyList<AudioDevice> ListDevices() => captureFactory.ListDevices();

    public async Task StartAsync(string operationId, string path, string? endpointId)
    {
        RequireOperationId(operationId);
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("A capture path is required.", nameof(path));

        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (capture is not null) throw new AudioCaptureException("busy", "Capture is already active.");
            var parent = Path.GetDirectoryName(path);
            if (string.IsNullOrWhiteSpace(parent)) throw new ArgumentException("Capture path has no parent directory.", nameof(path));
            Directory.CreateDirectory(parent);
            if (File.Exists(path)) File.Delete(path);

            var nextCapture = captureFactory.Create(endpointId);
            var nextWave = new MemoryStream();
            var nextWriter = new WaveFileWriter(new IgnoreDisposeStream(nextWave), nextCapture.WaveFormat);
            var nextStopped = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

            capture = nextCapture;
            capturedWave = nextWave;
            writer = nextWriter;
            stopped = nextStopped;
            outputPath = path;
            ActiveOperationId = operationId;
            ActiveEndpointId = nextCapture.EndpointId;
            ActiveEndpointName = nextCapture.EndpointName;
            terminalReason = "released";
            rawBytes = 0;
            stopRequested = 0;
            limitSignaled = 0;
            nextCapture.DataAvailable += OnDataAvailable;
            nextCapture.RecordingStopped += OnRecordingStopped;

            nextCapture.Start();
            StartedAt = utcNow();
            limitTimer = new Timer(
                _ => RequestLimitStop("maximum_duration"),
                null,
                maximumDuration,
                Timeout.InfiniteTimeSpan);
        }
        catch
        {
            await DeleteOutputAsync(throwOnFailure: false).ConfigureAwait(false);
            DisposeCapture();
            ResetState();
            throw;
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<AudioCaptureResult> StopAsync(string operationId)
    {
        RequireOperationId(operationId);
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            EnsureMatchingActiveOperation(operationId);
            try
            {
                var finalPath = outputPath!;
                var endpointId = ActiveEndpointId!;
                var endpointName = ActiveEndpointName!;
                var startedAt = StartedAt;
                var completion = stopped!;

                RequestStop("released");
                await completion.Task.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
                limitTimer?.Dispose();
                limitTimer = null;
                DisposeCaptureBackend();

                var duration = startedAt is null ? 0 : Math.Max(0, (long)(utcNow() - startedAt.Value).TotalMilliseconds);
                if (duration < minimumDurationMs || rawBytes == 0)
                    throw new AudioCaptureException("invalid_audio", "The recording was too short. Hold the shortcut until the reviewer finishes speaking.");

                ConvertBufferedCaptureToPcm16kMono(finalPath);
                using var reader = new WaveFileReader(finalPath);
                var bytes = new FileInfo(finalPath).Length;
                var convertedDuration = (long)reader.TotalTime.TotalMilliseconds;
                if (convertedDuration < minimumDurationMs || bytes <= 44)
                    throw new AudioCaptureException("invalid_audio", "The recording did not contain enough audio to transcribe.");

                var result = new AudioCaptureResult(
                    finalPath,
                    convertedDuration,
                    bytes,
                    reader.WaveFormat.SampleRate,
                    reader.WaveFormat.Channels,
                    endpointId,
                    endpointName,
                    terminalReason ?? "stopped");
                DisposeCapturedWave();
                ResetState();
                return result;
            }
            catch
            {
                await DeleteOutputAsync(throwOnFailure: false).ConfigureAwait(false);
                DisposeCapture();
                ResetState();
                throw;
            }
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task CancelAsync(string? operationId, bool allowIdle = false)
    {
        if (!allowIdle) RequireOperationId(operationId);
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (capture is null)
            {
                if (allowIdle) return;
                // Cancellation is idempotent once an operation has already cleaned itself up.
                return;
            }
            if (!allowIdle) EnsureMatchingActiveOperation(operationId!);
            try
            {
                var completion = stopped;
                RequestStop("cancelled");
                if (completion is not null)
                    await completion.Task.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
                DisposeCapture();
                await DeleteOutputAsync(throwOnFailure: true).ConfigureAwait(false);
                ResetState();
            }
            catch
            {
                DisposeCapture();
                await DeleteOutputAsync(throwOnFailure: false).ConfigureAwait(false);
                ResetState();
                throw;
            }
        }
        finally
        {
            gate.Release();
        }
    }

    private void OnDataAvailable(byte[] buffer, int bytesRecorded)
    {
        if (bytesRecorded <= 0) return;
        var reachedLimit = false;
        lock (ioLock)
        {
            if (writer is null || capture is null) return;
            var remaining = maximumRawBytes - rawBytes;
            var writable = (int)Math.Min(bytesRecorded, Math.Max(0, remaining));
            writable -= writable % Math.Max(1, capture.WaveFormat.BlockAlign);
            if (writable > 0)
            {
                writer.Write(buffer, 0, writable);
                rawBytes += writable;
            }
            reachedLimit = writable < bytesRecorded || rawBytes >= maximumRawBytes;
        }
        if (reachedLimit) RequestLimitStop("maximum_size");
    }

    private void OnRecordingStopped(Exception? error)
    {
        TaskCompletionSource<bool>? completion;
        lock (ioLock)
        {
            try
            {
                writer?.Flush();
                writer?.Dispose();
                writer = null;
            }
            catch (Exception writerError)
            {
                error ??= writerError;
            }
            completion = stopped;
        }
        if (error is null) completion?.TrySetResult(true);
        else completion?.TrySetException(error);
    }

    private void RequestLimitStop(string signalReason)
    {
        AudioCaptureLimit? notification = null;
        lock (ioLock)
        {
            if (capture is null || stopped?.Task.IsCompleted == true || limitSignaled != 0) return;
            limitSignaled = 1;
            terminalReason = signalReason;
            if (ActiveOperationId is { } operationId)
                notification = new AudioCaptureLimit(operationId, signalReason);
        }
        RequestStop(signalReason);
        if (notification is not null) CaptureLimitReached?.Invoke(notification);
    }

    private void RequestStop(string reason)
    {
        ILoopbackCapture? activeCapture;
        lock (ioLock)
        {
            if (terminalReason is "released" or "stopped" || reason is "maximum_duration" or "maximum_size")
                terminalReason = reason;
            activeCapture = capture;
        }
        if (activeCapture is null || Interlocked.Exchange(ref stopRequested, 1) != 0) return;
        try
        {
            activeCapture.Stop();
        }
        catch (Exception error)
        {
            stopped?.TrySetException(error);
        }
    }

    private void ConvertBufferedCaptureToPcm16kMono(string destination)
    {
        var source = capturedWave ?? throw new AudioCaptureException("invalid_audio", "No captured audio buffer is available.");
        source.Position = 0;
        using var reader = new WaveFileReader(source);
        ISampleProvider samples;
        try
        {
            samples = reader.ToSampleProvider();
        }
        catch (Exception error)
        {
            throw new AudioCaptureException("invalid_audio", "The output device produced an unsupported audio format.", error);
        }
        if (samples.WaveFormat.Channels > 1) samples = new DownmixToMonoSampleProvider(samples);
        if (samples.WaveFormat.SampleRate != 16_000) samples = new WdlResamplingSampleProvider(samples, 16_000);
        // WASAPI can deliver a final buffered packet after the duration timer
        // requests Stop. Bound the finalized PCM itself, not only the timer,
        // so protocol metadata and the uploaded file can never exceed 90 s.
        samples = new OffsetSampleProvider(samples) { Take = maximumDuration };
        WaveFileWriter.CreateWaveFile16(destination, samples);
    }

    private void EnsureMatchingActiveOperation(string operationId)
    {
        if (capture is null || ActiveOperationId is null)
            throw new AudioCaptureException("invalid_state", "Capture is not active.");
        if (!string.Equals(ActiveOperationId, operationId, StringComparison.Ordinal))
            throw new AudioCaptureException("stale_operation", "The capture command does not belong to the active operation.");
    }

    private static void RequireOperationId(string? operationId)
    {
        if (string.IsNullOrWhiteSpace(operationId))
            throw new ArgumentException("A non-empty operationId is required.", nameof(operationId));
    }

    private async Task DeleteOutputAsync(bool throwOnFailure)
    {
        if (string.IsNullOrWhiteSpace(outputPath)) return;
        Exception? lastError = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                if (File.Exists(outputPath)) File.Delete(outputPath);
                return;
            }
            catch (Exception error)
            {
                lastError = error;
                await Task.Delay(50).ConfigureAwait(false);
            }
        }
        if (throwOnFailure && File.Exists(outputPath))
            throw new IOException("PresenterAI could not delete its temporary audio file.", lastError);
    }

    private void DisposeCaptureBackend()
    {
        limitTimer?.Dispose();
        limitTimer = null;
        if (capture is not null)
        {
            capture.DataAvailable -= OnDataAvailable;
            capture.RecordingStopped -= OnRecordingStopped;
            capture.Dispose();
            capture = null;
        }
    }

    private void DisposeCapturedWave()
    {
        lock (ioLock)
        {
            writer?.Dispose();
            writer = null;
            capturedWave?.Dispose();
            capturedWave = null;
        }
    }

    private void DisposeCapture()
    {
        DisposeCaptureBackend();
        DisposeCapturedWave();
    }

    private void ResetState()
    {
        outputPath = null;
        ActiveOperationId = null;
        ActiveEndpointId = null;
        ActiveEndpointName = null;
        StartedAt = null;
        stopped = null;
        terminalReason = null;
        rawBytes = 0;
        stopRequested = 0;
        limitSignaled = 0;
    }
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
            for (var channel = 0; channel < channels; channel++)
                sum += sourceBuffer[frame * channels + channel];
            buffer[offset + frame] = sum / channels;
        }
        return frames;
    }
}
