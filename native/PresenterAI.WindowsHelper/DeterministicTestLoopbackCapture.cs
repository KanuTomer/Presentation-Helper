using NAudio.Wave;

namespace PresenterAI.WindowsHelper;

// This backend is an explicit CI diagnostic, never a product audio source.
// Program requires both a command-line flag and an environment opt-in before
// constructing it, and its handshake intentionally omits the WASAPI feature.
internal sealed class DeterministicTestLoopbackCaptureFactory : ILoopbackCaptureFactory
{
    internal const string EndpointId = "presenterai-synthetic-test-render";
    internal const string EndpointName = "PresenterAI deterministic test output";

    public IReadOnlyList<AudioDevice> ListDevices() => [new(EndpointId, EndpointName, true)];

    public ILoopbackCapture Create(string? endpointId)
    {
        if (!string.IsNullOrWhiteSpace(endpointId) && endpointId != EndpointId)
            throw new AudioCaptureException("device_unavailable", "The deterministic test output is unavailable.");
        return new DeterministicTestLoopbackCapture();
    }
}

internal sealed class DeterministicTestLoopbackCapture : ILoopbackCapture
{
    private int started;
    private int stopped;

    public string EndpointId => DeterministicTestLoopbackCaptureFactory.EndpointId;
    public string EndpointName => DeterministicTestLoopbackCaptureFactory.EndpointName;
    public WaveFormat WaveFormat { get; } = WaveFormat.CreateIeeeFloatWaveFormat(48_000, 2);
    public event Action<byte[], int>? DataAvailable;
    public event Action<Exception?>? RecordingStopped;

    public void Start()
    {
        if (Interlocked.Exchange(ref started, 1) != 0)
            throw new InvalidOperationException("The deterministic test capture was already started.");
        const int frames = 24_000;
        var samples = new float[frames * 2];
        for (var frame = 0; frame < frames; frame++)
        {
            samples[frame * 2] = 0.25f;
            samples[frame * 2 + 1] = -0.125f;
        }
        var bytes = new byte[samples.Length * sizeof(float)];
        Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
        DataAvailable?.Invoke(bytes, bytes.Length);
    }

    public void Stop()
    {
        if (Interlocked.Exchange(ref stopped, 1) != 0) return;
        RecordingStopped?.Invoke(null);
    }

    public void Dispose() { }
}
