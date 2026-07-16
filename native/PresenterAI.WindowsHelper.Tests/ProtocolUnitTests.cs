using System.Text.Json;

namespace PresenterAI.WindowsHelper.Tests;

public sealed class ProtocolUnitTests
{
    [Fact]
    public void SerializesCaptureLimitReachedWithOperationAndReason()
    {
        var message = Program.CreateCaptureLimitReachedEvent(new AudioCaptureLimit("operation-42", "maximum_size"));

        using var json = JsonDocument.Parse(Program.SerializeForProtocol(message));

        Assert.Equal("captureLimitReached", json.RootElement.GetProperty("type").GetString());
        Assert.Equal("operation-42", json.RootElement.GetProperty("operationId").GetString());
        Assert.Equal("maximum_size", json.RootElement.GetProperty("reason").GetString());
        Assert.Equal(3, json.RootElement.EnumerateObject().Count());
    }

    [Fact]
    public void TerminalOperationHistoryEvictsOldestEntryAtCapacity()
    {
        var history = new BoundedOperationHistory(1_024);
        for (var index = 0; index < 1_024; index++)
            Assert.True(history.Add($"operation-{index}"));

        Assert.False(history.Add("operation-1023"));
        Assert.Equal(1_024, history.Count);
        Assert.True(history.Add("operation-1024"));

        Assert.Equal(1_024, history.Count);
        Assert.False(history.Contains("operation-0"));
        Assert.True(history.Contains("operation-1"));
        Assert.True(history.Contains("operation-1024"));
    }
}
