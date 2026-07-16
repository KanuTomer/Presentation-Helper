using System.Diagnostics;
using System.Text.Json;

namespace PresenterAI.WindowsHelper.Tests;

public sealed class ProtocolIntegrationTests
{
    private static readonly string[] RequiredFeatures =
    [
        "wasapi-system-loopback",
        "device-selection",
        "hold-shortcut",
        "pcm16k-mono",
        "hook-ready",
        "single-file-capture",
        "bounded-capture",
        "capture-limit-events",
        "operation-ids"
    ];

    [Fact]
    public async Task SupportsV2HandshakeDevicesCancellationUnknownCommandAndCleanShutdown()
    {
        using var process = StartHelper();
        using var startup = await ReadNext(process);
        Assert.Equal("ready", startup.RootElement.GetProperty("type").GetString());
        Assert.Equal(2, startup.RootElement.GetProperty("protocolVersion").GetInt32());
        Assert.True(startup.RootElement.GetProperty("shortcutReady").GetBoolean());
        var startupFeatures = startup.RootElement.GetProperty("features")
            .EnumerateArray().Select(feature => feature.GetString()).ToArray();
        Assert.All(RequiredFeatures, feature => Assert.Contains(feature, startupFeatures));

        await Write(process, new { type = "hello", requestId = "hello-1", protocolVersion = 2 });
        using var hello = await ReadFor(process, "hello-1");
        Assert.Equal("ready", hello.RootElement.GetProperty("type").GetString());
        Assert.Equal(2, hello.RootElement.GetProperty("protocolVersion").GetInt32());
        Assert.True(hello.RootElement.GetProperty("shortcutReady").GetBoolean());

        await Write(process, new { type = "listDevices", requestId = "devices-1" });
        using var devices = await ReadFor(process, "devices-1");
        Assert.Equal("deviceList", devices.RootElement.GetProperty("type").GetString());
        Assert.Equal(JsonValueKind.Array, devices.RootElement.GetProperty("devices").ValueKind);

        await Write(process, new { type = "cancel", requestId = "cancel-1", operationId = "op-cancel" });
        using var cancelled = await ReadFor(process, "cancel-1");
        Assert.Equal("captureCancelled", cancelled.RootElement.GetProperty("type").GetString());
        Assert.Equal("op-cancel", cancelled.RootElement.GetProperty("operationId").GetString());
        Assert.Equal("cancelled", cancelled.RootElement.GetProperty("terminalReason").GetString());

        await Write(process, new { type = "cancel", requestId = "cancel-2", operationId = "op-cancel" });
        using var duplicate = await ReadFor(process, "cancel-2");
        Assert.Equal("error", duplicate.RootElement.GetProperty("type").GetString());
        Assert.Equal("duplicate_terminal", duplicate.RootElement.GetProperty("code").GetString());

        await Write(process, new { type = "notACommand", requestId = "bad-1" });
        using var error = await ReadFor(process, "bad-1");
        Assert.Equal("unknown_command", error.RootElement.GetProperty("code").GetString());

        await Write(process, new { type = "shutdown", requestId = "stop-1" });
        using var stopped = await ReadFor(process, "stop-1");
        Assert.Equal("shutdownComplete", stopped.RootElement.GetProperty("type").GetString());
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, process.ExitCode);
    }

    [Fact]
    public async Task RejectsProtocolMismatchAndMissingOperationId()
    {
        using var process = StartHelper();
        using var startup = await ReadNext(process);
        Assert.Equal("ready", startup.RootElement.GetProperty("type").GetString());

        await Write(process, new { type = "hello", requestId = "hello-old", protocolVersion = 1 });
        using var mismatch = await ReadFor(process, "hello-old");
        Assert.Equal("protocol_mismatch", mismatch.RootElement.GetProperty("code").GetString());

        await Write(process, new { type = "startCapture", requestId = "start-bad", path = "unused.wav" });
        using var missingOperation = await ReadFor(process, "start-bad");
        Assert.Equal("invalid_argument", missingOperation.RootElement.GetProperty("code").GetString());

        await Write(process, new { type = "shutdown", requestId = "stop-2" });
        using var stopped = await ReadFor(process, "stop-2");
        Assert.Equal("shutdownComplete", stopped.RootElement.GetProperty("type").GetString());
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
    }

    private static Process StartHelper()
    {
        var assembly = Path.Combine(AppContext.BaseDirectory, "PresenterAI.WindowsHelper.dll");
        return Process.Start(new ProcessStartInfo("dotnet", $"\"{assembly}\"")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        })!;
    }

    private static async Task Write(Process process, object command)
    {
        await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(command));
        await process.StandardInput.FlushAsync();
    }

    private static async Task<JsonDocument> ReadNext(Process process)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var line = await process.StandardOutput.ReadLineAsync(timeout.Token);
        if (line is null)
            throw new InvalidOperationException($"Helper exited before responding: {await process.StandardError.ReadToEndAsync(timeout.Token)}");
        return JsonDocument.Parse(line);
    }

    private static async Task<JsonDocument> ReadFor(Process process, string requestId)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (await process.StandardOutput.ReadLineAsync(timeout.Token) is { } line)
        {
            var json = JsonDocument.Parse(line);
            if (json.RootElement.TryGetProperty("requestId", out var id) && id.GetString() == requestId)
                return json;
            json.Dispose();
        }
        throw new TimeoutException($"No helper response for {requestId}.");
    }
}
