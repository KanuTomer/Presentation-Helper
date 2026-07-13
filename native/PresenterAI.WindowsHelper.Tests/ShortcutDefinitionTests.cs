namespace PresenterAI.WindowsHelper.Tests;

public sealed class ShortcutDefinitionTests
{
    [Fact]
    public void ParsesConfiguredModifiersAndSpace()
    {
        var result = ShortcutDefinition.Parse("Control+Shift+Space");
        Assert.Equal(0x20, result.TriggerKey);
        Assert.True(result.Control);
        Assert.True(result.Shift);
        Assert.False(result.Alt);
    }

    [Theory]
    [InlineData("Alt+F12", 0x7B)]
    [InlineData("Control+K", 0x4B)]
    [InlineData("Control+7", 0x37)]
    public void ParsesSupportedTriggerKeys(string accelerator, int expected) => Assert.Equal(expected, ShortcutDefinition.Parse(accelerator).TriggerKey);

    [Fact]
    public void RejectsUnsupportedTrigger() => Assert.Throws<ArgumentException>(() => ShortcutDefinition.Parse("Control+VolumeUp"));

    [Fact]
    public void SuppressesAutoRepeatAndEmitsOneRelease()
    {
        using var hook = new ShortcutHook();
        var downs = 0; var ups = 0;
        hook.ShortcutDown += () => downs++;
        hook.ShortcutUp += () => ups++;
        bool Pressed(int key) => key is 0x11 or 0x10;
        hook.ProcessKey(0x20, true, false, Pressed);
        hook.ProcessKey(0x20, true, false, Pressed);
        hook.ProcessKey(0x20, false, true, Pressed);
        hook.ProcessKey(0x20, false, true, Pressed);
        Assert.Equal(1, downs);
        Assert.Equal(1, ups);
    }
}
