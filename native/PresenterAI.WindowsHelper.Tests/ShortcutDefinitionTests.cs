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
    [InlineData("CommandOrControl+7", 0x37)]
    [InlineData("Shift+F24", 0x87)]
    public void ParsesSupportedTriggerKeys(string accelerator, int expected) =>
        Assert.Equal(expected, ShortcutDefinition.Parse(accelerator).TriggerKey);

    [Theory]
    [InlineData("Control+VolumeUp")]
    [InlineData("Space")]
    [InlineData("Control+K+L")]
    [InlineData("Control+Control+K")]
    [InlineData("Control+Ctrl+K")]
    [InlineData("Control++K")]
    [InlineData("Control+Shift")]
    [InlineData("")]
    public void RejectsMalformedOrUnsafeAccelerators(string accelerator) =>
        Assert.Throws<ArgumentException>(() => ShortcutDefinition.Parse(accelerator));

    [Fact]
    public void SuppressesAutoRepeatAndRearmsOnlyAfterRelease()
    {
        using var hook = new ShortcutHook();
        var downs = 0;
        var ups = 0;
        hook.ShortcutDown += () => downs++;
        hook.ShortcutUp += () => ups++;
        bool Pressed(int key) => key is 0x11 or 0x10;

        hook.ProcessKey(0x20, true, false, Pressed);
        hook.ProcessKey(0x20, true, false, Pressed);
        hook.ProcessKey(0x20, false, true, Pressed);
        hook.ProcessKey(0x20, false, true, Pressed);
        hook.ProcessKey(0x20, true, false, Pressed);
        hook.ProcessKey(0x20, true, false, Pressed);
        hook.ProcessKey(0x20, false, true, Pressed);

        Assert.Equal(2, downs);
        Assert.Equal(2, ups);
    }

    [Fact]
    public void DoesNotActivateWhenConfiguredModifiersAreMissing()
    {
        using var hook = new ShortcutHook();
        var downs = 0;
        hook.ShortcutDown += () => downs++;

        var handled = hook.ProcessKey(0x20, true, false, _ => false);

        Assert.False(handled);
        Assert.Equal(0, downs);
    }

    [Fact]
    public void DoesNotActivateWhenAnUnconfiguredModifierIsPressed()
    {
        using var hook = new ShortcutHook();
        hook.Configure("Control+Space");
        var downs = 0;
        hook.ShortcutDown += () => downs++;

        bool Pressed(int key) => key is 0x11 or 0x10;
        var handled = hook.ProcessKey(0x20, true, false, Pressed);

        Assert.False(handled);
        Assert.Equal(0, downs);
    }

    [Fact]
    public void DoesNotActivateWhenAWindowsKeyIsAlsoPressed()
    {
        using var hook = new ShortcutHook();
        var downs = 0;
        hook.ShortcutDown += () => downs++;

        bool Pressed(int key) => key is 0x11 or 0x10 or 0x5B;
        var handled = hook.ProcessKey(0x20, true, false, Pressed);

        Assert.False(handled);
        Assert.Equal(0, downs);
    }
}
