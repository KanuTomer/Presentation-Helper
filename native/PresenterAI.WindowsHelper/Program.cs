using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace PresenterAI.WindowsHelper;

internal static class Program
{
    private static readonly object OutputLock = new();
    private static WasapiLoopbackCapture? capture;
    private static WaveFileWriter? writer;
    private static string? capturePath;
    private static readonly ShortcutHook hook = new();

    public static async Task Main()
    {
        hook.ShortcutDown += () => Emit(new { type = "shortcutDown" });
        hook.ShortcutUp += () => Emit(new { type = "shortcutUp" });
        hook.Start();
        Emit(new { type = "ready", protocolVersion = 1 });
        string? line;
        while ((line = await Console.In.ReadLineAsync()) != null)
        {
            try
            {
                using var json = JsonDocument.Parse(line);
                var root = json.RootElement;
                var type = root.GetProperty("type").GetString();
                var requestId = root.TryGetProperty("requestId", out var id) ? id.GetString() : null;
                switch (type)
                {
                    case "hello": Emit(new { type = "ready", requestId, protocolVersion = 1 }); break;
                    case "listDevices": ListDevices(requestId); break;
                    case "configureShortcut":
                        hook.Configure(root.GetProperty("accelerator").GetString()!);
                        Emit(new { type = "shortcutConfigured", requestId });
                        break;
                    case "startCapture": StartCapture(root.GetProperty("path").GetString()!, requestId); break;
                    case "stopCapture": StopCapture(requestId, false); break;
                    case "cancel": StopCapture(requestId, true); break;
                    default: Emit(new { type = "error", requestId, message = $"Unknown command: {type}" }); break;
                }
            }
            catch (Exception ex) { Emit(new { type = "error", message = ex.Message }); }
        }
        hook.Dispose(); StopCapture(null, true);
    }

    private static void ListDevices(string? requestId)
    {
        using var enumerator = new MMDeviceEnumerator();
        var devices = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active).Select(device => new { id = device.ID, name = device.FriendlyName });
        Emit(new { type = "deviceList", requestId, devices });
    }

    private static void StartCapture(string path, string? requestId)
    {
        if (capture != null) throw new InvalidOperationException("Capture is already active.");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        capturePath = path; capture = new WasapiLoopbackCapture(); writer = new WaveFileWriter(path, capture.WaveFormat);
        capture.DataAvailable += (_, e) => writer?.Write(e.Buffer, 0, e.BytesRecorded);
        capture.RecordingStopped += (_, e) => { if (e.Exception != null) Emit(new { type = "warning", message = e.Exception.Message }); };
        capture.StartRecording(); Emit(new { type = "captureStarted", requestId, path });
    }

    private static void StopCapture(string? requestId, bool cancelled)
    {
        if (capture == null) { Emit(new { type = cancelled ? "captureCancelled" : "captureStopped", requestId, path = capturePath }); return; }
        capture.StopRecording(); capture.Dispose(); capture = null; writer?.Dispose(); writer = null;
        var path = capturePath; capturePath = null;
        if (cancelled && path != null && File.Exists(path)) File.Delete(path);
        Emit(new { type = cancelled ? "captureCancelled" : "captureStopped", requestId, path });
    }

    internal static void Emit(object value) { lock (OutputLock) Console.Out.WriteLine(JsonSerializer.Serialize(value)); }
}
