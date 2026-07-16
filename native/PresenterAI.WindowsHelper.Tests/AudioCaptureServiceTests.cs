using NAudio.Wave;

namespace PresenterAI.WindowsHelper.Tests;

public sealed class AudioCaptureServiceTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "PresenterAI-helper-tests", Guid.NewGuid().ToString("N"));

    public AudioCaptureServiceTests() => Directory.CreateDirectory(directory);

    [Fact]
    public async Task FinalizesOnePcm16kMonoFileWithEndpointMetadata()
    {
        var now = DateTimeOffset.UtcNow;
        var backend = new FakeCapture();
        var service = CreateService(backend, () => now);
        var path = CapturePath();

        await service.StartAsync("operation-1", path, "endpoint-1");
        backend.EmitStereoFloat(seconds: 0.5);
        now += TimeSpan.FromMilliseconds(500);
        var result = await service.StopAsync("operation-1");

        Assert.Equal(path, result.Path);
        Assert.Equal("endpoint-1", result.EndpointId);
        Assert.Equal("Test output", result.EndpointName);
        Assert.Equal("released", result.TerminalReason);
        Assert.Equal(16_000, result.SampleRate);
        Assert.Equal(1, result.Channels);
        Assert.InRange(result.DurationMs, 490, 510);
        Assert.Equal(new FileInfo(path).Length, result.Bytes);
        Assert.Single(Directory.GetFiles(directory));
        Assert.DoesNotContain(Directory.GetFiles(directory), file => file.Contains("raw", StringComparison.OrdinalIgnoreCase));

        using var reader = new WaveFileReader(path);
        Assert.Equal(16_000, reader.WaveFormat.SampleRate);
        Assert.Equal(1, reader.WaveFormat.Channels);
        Assert.Equal(16, reader.WaveFormat.BitsPerSample);
    }

    [Fact]
    public async Task RejectsShortAudioAndDeletesOutput()
    {
        var now = DateTimeOffset.UtcNow;
        var backend = new FakeCapture();
        var service = CreateService(backend, () => now);
        var path = CapturePath();

        await service.StartAsync("short", path, null);
        backend.EmitStereoFloat(seconds: 0.1);
        now += TimeSpan.FromMilliseconds(100);
        var error = await Assert.ThrowsAsync<AudioCaptureException>(() => service.StopAsync("short"));

        Assert.Equal("invalid_audio", error.Code);
        Assert.False(File.Exists(path));
        Assert.Empty(Directory.GetFiles(directory));
    }

    [Fact]
    public async Task CancellationStopsOnceAndLeavesNoFile()
    {
        var backend = new FakeCapture();
        var service = CreateService(backend);
        var path = CapturePath();

        await service.StartAsync("cancelled", path, null);
        backend.EmitStereoFloat(seconds: 0.5);
        await Task.WhenAll(
            service.CancelAsync("cancelled"),
            service.CancelAsync("cancelled"));

        Assert.Equal(1, backend.StopCalls);
        Assert.False(File.Exists(path));
        Assert.Null(service.ActiveOperationId);
    }

    [Fact]
    public async Task StaleOperationCannotStopCurrentCapture()
    {
        var backend = new FakeCapture();
        var service = CreateService(backend);
        await service.StartAsync("current", CapturePath(), null);

        var error = await Assert.ThrowsAsync<AudioCaptureException>(() => service.StopAsync("old"));

        Assert.Equal("stale_operation", error.Code);
        Assert.Equal(0, backend.StopCalls);
        Assert.Equal("current", service.ActiveOperationId);
        await service.CancelAsync("current");
    }

    [Fact]
    public async Task MemoryLimitStopsCaptureWithoutExceedingBound()
    {
        var now = DateTimeOffset.UtcNow;
        var backend = new FakeCapture();
        var service = CreateService(backend, () => now, maximumRawBytes: 4_800, minimumDurationMs: 0);
        var path = CapturePath();
        var limits = new List<AudioCaptureLimit>();
        service.CaptureLimitReached += limits.Add;

        await service.StartAsync("bounded", path, null);
        backend.EmitStereoFloat(seconds: 0.5);
        backend.EmitStereoFloat(seconds: 0.5);
        now += TimeSpan.FromMilliseconds(500);
        var result = await service.StopAsync("bounded");

        Assert.Equal(1, backend.StopCalls);
        var limit = Assert.Single(limits);
        Assert.Equal("bounded", limit.OperationId);
        Assert.Equal("maximum_size", limit.Reason);
        Assert.Equal("maximum_size", result.TerminalReason);
        Assert.True(result.Bytes < 4_800, "The 16 kHz mono final WAV should be smaller than its bounded stereo source.");
    }

    [Fact]
    public async Task DurationLimitStopsCaptureAndCanBeFinalized()
    {
        var now = DateTimeOffset.UtcNow;
        var backend = new FakeCapture();
        var factory = new FakeCaptureFactory(backend);
        var service = new AudioCaptureService(
            factory,
            maximumDuration: TimeSpan.FromMilliseconds(20),
            minimumDurationMs: 0,
            utcNow: () => now);
        var path = CapturePath();
        var limits = new List<AudioCaptureLimit>();
        service.CaptureLimitReached += limits.Add;

        await service.StartAsync("timed", path, null);
        backend.EmitStereoFloat(seconds: 0.5);
        await WaitUntil(() => backend.StopCalls == 1);
        now += TimeSpan.FromMilliseconds(500);
        var result = await service.StopAsync("timed");

        Assert.Equal("maximum_duration", result.TerminalReason);
        Assert.InRange(result.DurationMs, 1, 20);
        Assert.Equal(1, backend.StopCalls);
        var limit = Assert.Single(limits);
        Assert.Equal("timed", limit.OperationId);
        Assert.Equal("maximum_duration", limit.Reason);
    }

    [Fact]
    public async Task CaptureFailureDeletesOutputAndResetsState()
    {
        var backend = new FakeCapture { StopError = new IOException("device removed") };
        var service = CreateService(backend);
        var path = CapturePath();
        await service.StartAsync("failure", path, null);
        backend.EmitStereoFloat(seconds: 0.5);

        await Assert.ThrowsAsync<IOException>(() => service.StopAsync("failure"));

        Assert.Null(service.ActiveOperationId);
        Assert.False(File.Exists(path));
    }

    [Fact]
    public void ListsStableEndpointMetadataFromFactory()
    {
        var backend = new FakeCapture();
        var service = CreateService(backend);

        var device = Assert.Single(service.ListDevices());

        Assert.Equal("endpoint-1", device.Id);
        Assert.Equal("Test output", device.Name);
        Assert.True(device.IsDefault);
    }

    private AudioCaptureService CreateService(
        FakeCapture backend,
        Func<DateTimeOffset>? now = null,
        long maximumRawBytes = AudioCaptureService.DefaultMaximumRawBytes,
        long minimumDurationMs = AudioCaptureService.MinimumDurationMs) =>
        new(
            new FakeCaptureFactory(backend),
            maximumDuration: TimeSpan.FromMinutes(5),
            maximumRawBytes,
            minimumDurationMs,
            now);

    private string CapturePath() => Path.Combine(directory, $"{Guid.NewGuid():N}.wav");

    private static async Task WaitUntil(Func<bool> predicate)
    {
        var timeout = DateTime.UtcNow + TimeSpan.FromSeconds(2);
        while (!predicate() && DateTime.UtcNow < timeout) await Task.Delay(10);
        Assert.True(predicate(), "Timed out waiting for the capture backend to stop.");
    }

    public void Dispose()
    {
        try { Directory.Delete(directory, recursive: true); } catch { }
    }

    private sealed class FakeCaptureFactory(FakeCapture capture) : ILoopbackCaptureFactory
    {
        public IReadOnlyList<AudioDevice> ListDevices() => [new("endpoint-1", "Test output", true)];
        public ILoopbackCapture Create(string? endpointId)
        {
            if (endpointId is not null && endpointId != "endpoint-1")
                throw new AudioCaptureException("device_unavailable", "Unknown test endpoint.");
            return capture;
        }
    }

    private sealed class FakeCapture : ILoopbackCapture
    {
        private int stopped;
        public string EndpointId => "endpoint-1";
        public string EndpointName => "Test output";
        public WaveFormat WaveFormat { get; } = WaveFormat.CreateIeeeFloatWaveFormat(48_000, 2);
        public int StopCalls { get; private set; }
        public Exception? StopError { get; init; }
        public event Action<byte[], int>? DataAvailable;
        public event Action<Exception?>? RecordingStopped;

        public void Start() { }

        public void Stop()
        {
            StopCalls++;
            if (Interlocked.Exchange(ref stopped, 1) != 0) return;
            RecordingStopped?.Invoke(StopError);
        }

        public void EmitStereoFloat(double seconds)
        {
            var frames = (int)(WaveFormat.SampleRate * seconds);
            var samples = new float[frames * WaveFormat.Channels];
            for (var frame = 0; frame < frames; frame++)
            {
                samples[frame * 2] = 0.25f;
                samples[frame * 2 + 1] = -0.125f;
            }
            var bytes = new byte[samples.Length * sizeof(float)];
            Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
            DataAvailable?.Invoke(bytes, bytes.Length);
        }

        public void Dispose() { }
    }
}
