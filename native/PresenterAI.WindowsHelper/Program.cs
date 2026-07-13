using System.Text.Json;

namespace PresenterAI.WindowsHelper;

internal static class Program
{
    private const int ProtocolVersion = 1;
    private static readonly object OutputLock = new();
    private static readonly AudioCaptureService Audio = new();
    private static readonly ShortcutHook Hook = new();

    public static async Task Main()
    {
        Hook.ShortcutDown += () => Emit(new { type = "shortcutDown" });
        Hook.ShortcutUp += () => Emit(new { type = "shortcutUp" });
        Hook.Start();
        Emit(new { type = "ready", protocolVersion = ProtocolVersion, features = Features() });

        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            string? requestId = null;
            try
            {
                using var json = JsonDocument.Parse(line);
                var root = json.RootElement;
                var type = root.GetProperty("type").GetString();
                requestId = root.TryGetProperty("requestId", out var id) ? id.GetString() : null;
                switch (type)
                {
                    case "hello":
                        Emit(new { type = "ready", requestId, protocolVersion = ProtocolVersion, features = Features() });
                        break;
                    case "listDevices":
                        Emit(new { type = "deviceList", requestId, devices = Audio.ListDevices() });
                        break;
                    case "configureShortcut":
                        Hook.Configure(root.GetProperty("accelerator").GetString()!);
                        Emit(new { type = "shortcutConfigured", requestId });
                        break;
                    case "startCapture":
                        var endpointId = root.TryGetProperty("endpointId", out var endpoint) && endpoint.ValueKind == JsonValueKind.String ? endpoint.GetString() : null;
                        await Audio.StartAsync(root.GetProperty("path").GetString()!, endpointId);
                        Emit(new { type = "captureStarted", requestId, endpointId = Audio.ActiveEndpointId, startedAt = Audio.StartedAt });
                        break;
                    case "stopCapture":
                        var result = await Audio.StopAsync();
                        Emit(new { type = "captureStopped", requestId, result.Path, result.DurationMs, result.Bytes, result.SampleRate, result.Channels, result.EndpointId });
                        break;
                    case "cancel":
                        await Audio.CancelAsync();
                        Emit(new { type = "captureCancelled", requestId });
                        break;
                    case "shutdown":
                        await Audio.CancelAsync();
                        Emit(new { type = "shutdownComplete", requestId });
                        Hook.Dispose();
                        return;
                    default:
                        Emit(new { type = "error", requestId, code = "unknown_command", message = $"Unknown command: {type}" });
                        break;
                }
            }
            catch (Exception ex)
            {
                Emit(new { type = "error", requestId, code = ErrorCode(ex), message = ex.Message });
            }
        }

        await Audio.CancelAsync();
        Hook.Dispose();
    }

    private static string[] Features() => ["wasapi-system-loopback", "device-selection", "hold-shortcut", "pcm16k-mono"];
    private static string ErrorCode(Exception error) => error switch
    {
        ArgumentException => "invalid_argument",
        InvalidOperationException => "invalid_state",
        FileNotFoundException => "missing_file",
        _ => "helper_error"
    };
    internal static void Emit(object value)
    {
        lock (OutputLock)
        {
            Console.Out.WriteLine(JsonSerializer.Serialize(value, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
            Console.Out.Flush();
        }
    }
}
