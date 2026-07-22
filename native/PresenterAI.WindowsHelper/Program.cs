using System.Text.Json;

namespace PresenterAI.WindowsHelper;

internal sealed record CaptureLimitReachedEvent(string Type, string OperationId, string Reason);

internal sealed class BoundedOperationHistory
{
    private readonly int capacity;
    private readonly HashSet<string> entries = new(StringComparer.Ordinal);
    private readonly Queue<string> insertionOrder = new();

    public BoundedOperationHistory(int capacity)
    {
        if (capacity <= 0) throw new ArgumentOutOfRangeException(nameof(capacity));
        this.capacity = capacity;
    }

    public int Count => entries.Count;
    public bool Contains(string operationId) => entries.Contains(operationId);

    public bool Add(string operationId)
    {
        if (!entries.Add(operationId)) return false;
        insertionOrder.Enqueue(operationId);
        while (insertionOrder.Count > capacity)
            entries.Remove(insertionOrder.Dequeue());
        return true;
    }
}

internal static class Program
{
    private const int ProtocolVersion = 2;
    private const string SyntheticAudioFlag = "--presenterai-synthetic-audio-test";
    private const string SyntheticAudioEnvironment = "PRESENTERAI_ENABLE_SYNTHETIC_AUDIO_TEST";
    private static readonly object OutputLock = new();
    private static readonly JsonSerializerOptions ProtocolJsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static AudioCaptureService Audio = new();
    private static readonly ShortcutHook Hook = new();
    private static readonly BoundedOperationHistory TerminalOperations = new(1_024);
    private static string CaptureBackend = "wasapi-system-loopback";

    public static async Task Main(string[] args)
    {
        var syntheticAudioTest = IsSyntheticAudioTestEnabled(
            args,
            Environment.GetEnvironmentVariable(SyntheticAudioEnvironment));
        Audio = new AudioCaptureService(syntheticAudioTest ? new DeterministicTestLoopbackCaptureFactory() : null);
        CaptureBackend = syntheticAudioTest ? "synthetic-test" : "wasapi-system-loopback";
        Hook.ShortcutDown += () => Emit(new { type = "shortcutDown" });
        Hook.ShortcutUp += () => Emit(new { type = "shortcutUp" });
        Audio.CaptureLimitReached += EmitCaptureLimitReached;

        try
        {
            await Hook.StartAsync().ConfigureAwait(false);
        }
        catch (Exception error)
        {
            Emit(new { type = "error", code = "shortcut_hook_unavailable", message = error.Message, fatal = true });
            Hook.Dispose();
            Environment.ExitCode = 1;
            return;
        }

        EmitReady(requestId: null);

        string? line;
        while ((line = await Console.In.ReadLineAsync().ConfigureAwait(false)) is not null)
        {
            if (!await ProcessCommand(line).ConfigureAwait(false)) return;
        }

        await Audio.CancelAsync(operationId: null, allowIdle: true).ConfigureAwait(false);
        Hook.Dispose();
    }

    private static async Task<bool> ProcessCommand(string line)
    {
        string? requestId = null;
        string? operationId = null;
        string? type = null;
        try
        {
            using var json = JsonDocument.Parse(line);
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new ArgumentException("A command must be a JSON object.");
            type = RequiredString(root, "type");
            requestId = RequiredString(root, "requestId");
            operationId = OptionalString(root, "operationId");

            switch (type)
            {
                case "hello":
                    var requestedVersion = root.TryGetProperty("protocolVersion", out var protocol)
                        && protocol.TryGetInt32(out var version)
                        ? version
                        : 0;
                    if (requestedVersion != ProtocolVersion)
                        throw new AudioCaptureException(
                            "protocol_mismatch",
                            $"Protocol version {requestedVersion} is unsupported. Expected {ProtocolVersion}.");
                    EmitReady(requestId);
                    break;

                case "listDevices":
                    Emit(new { type = "deviceList", requestId, devices = Audio.ListDevices() });
                    break;

                case "configureShortcut":
                    Hook.Configure(RequiredString(root, "accelerator"));
                    Emit(new { type = "shortcutConfigured", requestId });
                    break;

                case "startCapture":
                    operationId = RequireOperationId(operationId);
                    if (TerminalOperations.Contains(operationId))
                        throw new AudioCaptureException("duplicate_operation", "This operation has already reached a terminal state.");
                    var endpointId = OptionalString(root, "endpointId");
                    await Audio.StartAsync(operationId, RequiredString(root, "path"), endpointId).ConfigureAwait(false);
                    Emit(new
                    {
                        type = "captureStarted",
                        requestId,
                        operationId,
                        endpointId = Audio.ActiveEndpointId,
                        endpointName = Audio.ActiveEndpointName,
                        startedAt = Audio.StartedAt
                    });
                    break;

                case "stopCapture":
                    operationId = RequireOperationId(operationId);
                    EnsureNotTerminal(operationId);
                    try
                    {
                        var result = await Audio.StopAsync(operationId).ConfigureAwait(false);
                        TerminalOperations.Add(operationId);
                        Emit(new
                        {
                            type = "captureStopped",
                            requestId,
                            operationId,
                            result.Path,
                            result.DurationMs,
                            result.Bytes,
                            result.SampleRate,
                            result.Channels,
                            result.EndpointId,
                            result.EndpointName,
                            result.TerminalReason
                        });
                    }
                    catch
                    {
                        if (Audio.ActiveOperationId is null) TerminalOperations.Add(operationId);
                        throw;
                    }
                    break;

                case "cancel":
                    operationId = RequireOperationId(operationId);
                    EnsureNotTerminal(operationId);
                    try
                    {
                        await Audio.CancelAsync(operationId).ConfigureAwait(false);
                        TerminalOperations.Add(operationId);
                        Emit(new { type = "captureCancelled", requestId, operationId, terminalReason = "cancelled" });
                    }
                    catch
                    {
                        if (Audio.ActiveOperationId is null) TerminalOperations.Add(operationId);
                        throw;
                    }
                    break;

                case "shutdown":
                    await Audio.CancelAsync(operationId: null, allowIdle: true).ConfigureAwait(false);
                    Emit(new { type = "shutdownComplete", requestId });
                    Hook.Dispose();
                    return false;

                default:
                    Emit(new { type = "error", requestId, code = "unknown_command", message = $"Unknown command: {type}" });
                    break;
            }
        }
        catch (Exception error)
        {
            Emit(new
            {
                type = "error",
                requestId,
                operationId,
                code = ErrorCode(error),
                message = error.Message
            });
        }
        return true;
    }

    private static void EmitReady(string? requestId) => Emit(new
    {
        type = "ready",
        requestId,
        protocolVersion = ProtocolVersion,
        shortcutReady = Hook.IsReady,
        captureBackend = CaptureBackend,
        features = Features()
    });

    private static string[] Features() =>
    [
        CaptureBackend == "synthetic-test" ? "synthetic-test-audio" : "wasapi-system-loopback",
        "device-selection",
        "hold-shortcut",
        "pcm16k-mono",
        "hook-ready",
        "single-file-capture",
        "bounded-capture",
        "capture-limit-events",
        "operation-ids"
    ];

    internal static bool IsSyntheticAudioTestEnabled(IEnumerable<string> args, string? environmentValue) =>
        string.Equals(environmentValue, "1", StringComparison.Ordinal)
        && args.Contains(SyntheticAudioFlag, StringComparer.Ordinal);

    private static string RequiredString(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
            throw new ArgumentException($"A non-empty {property} is required.");
        return value.GetString()!;
    }

    private static string? OptionalString(JsonElement root, string property) =>
        root.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string RequireOperationId(string? operationId)
    {
        if (string.IsNullOrWhiteSpace(operationId))
            throw new ArgumentException("A non-empty operationId is required.");
        return operationId;
    }

    private static void EnsureNotTerminal(string operationId)
    {
        if (TerminalOperations.Contains(operationId))
            throw new AudioCaptureException("duplicate_terminal", "This operation has already reached a terminal state.");
    }

    private static string ErrorCode(Exception error) => error switch
    {
        AudioCaptureException captureError => captureError.Code,
        ArgumentException => "invalid_argument",
        TimeoutException => "capture_timeout",
        FileNotFoundException => "missing_file",
        InvalidOperationException => "invalid_state",
        _ => "helper_error"
    };

    private static void EmitCaptureLimitReached(AudioCaptureLimit limit) =>
        Emit(CreateCaptureLimitReachedEvent(limit));

    internal static CaptureLimitReachedEvent CreateCaptureLimitReachedEvent(AudioCaptureLimit limit) =>
        new("captureLimitReached", limit.OperationId, limit.Reason);

    internal static string SerializeForProtocol(object value) =>
        JsonSerializer.Serialize(value, ProtocolJsonOptions);

    internal static void Emit(object value)
    {
        lock (OutputLock)
        {
            Console.Out.WriteLine(SerializeForProtocol(value));
            Console.Out.Flush();
        }
    }
}
