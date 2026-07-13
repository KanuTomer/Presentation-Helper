using System.Diagnostics;
using System.Text.Json;

namespace PresenterAI.WindowsHelper.Tests;

public sealed class ProtocolIntegrationTests
{
    [Fact]
    public async Task SupportsHandshakeDevicesCancellationUnknownCommandAndCleanShutdown()
    {
        var assembly = Path.Combine(AppContext.BaseDirectory, "PresenterAI.WindowsHelper.dll");
        using var process = Process.Start(new ProcessStartInfo("dotnet", $"\"{assembly}\"") { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true })!;
        await Write(process, new { type = "hello", requestId = "hello-1", protocolVersion = 1 });
        using var hello = await ReadFor(process, "hello-1");
        Assert.Equal("ready", hello.RootElement.GetProperty("type").GetString());
        Assert.Equal(1, hello.RootElement.GetProperty("protocolVersion").GetInt32());

        await Write(process, new { type = "listDevices", requestId = "devices-1" });
        using var devices = await ReadFor(process, "devices-1");
        Assert.Equal("deviceList", devices.RootElement.GetProperty("type").GetString());
        Assert.Equal(JsonValueKind.Array, devices.RootElement.GetProperty("devices").ValueKind);

        await Write(process, new { type = "cancel", requestId = "cancel-1" });
        using var cancelled = await ReadFor(process, "cancel-1");
        Assert.Equal("captureCancelled", cancelled.RootElement.GetProperty("type").GetString());

        await Write(process, new { type = "notACommand", requestId = "bad-1" });
        using var error = await ReadFor(process, "bad-1");
        Assert.Equal("unknown_command", error.RootElement.GetProperty("code").GetString());

        await Write(process, new { type = "shutdown", requestId = "stop-1" });
        using var stopped = await ReadFor(process, "stop-1");
        Assert.Equal("shutdownComplete", stopped.RootElement.GetProperty("type").GetString());
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, process.ExitCode);
    }

    private static async Task Write(Process process, object command)
    {
        await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(command));
        await process.StandardInput.FlushAsync();
    }
    private static async Task<JsonDocument> ReadFor(Process process, string requestId)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (await process.StandardOutput.ReadLineAsync(timeout.Token) is { } line)
        {
            var json = JsonDocument.Parse(line);
            if (json.RootElement.TryGetProperty("requestId", out var id) && id.GetString() == requestId) return json;
            json.Dispose();
        }
        throw new TimeoutException($"No helper response for {requestId}.");
    }
}
