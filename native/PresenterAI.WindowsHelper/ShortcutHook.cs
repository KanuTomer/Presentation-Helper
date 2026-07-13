using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PresenterAI.WindowsHelper;

internal sealed record ShortcutDefinition(int TriggerKey, bool Control, bool Shift, bool Alt)
{
    private const int Space = 0x20;
    public static ShortcutDefinition Parse(string accelerator)
    {
        var tokens = accelerator.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(token => token.ToUpperInvariant()).ToArray();
        var key = tokens.LastOrDefault(token => token is not ("CONTROL" or "CTRL" or "COMMANDORCONTROL" or "SHIFT" or "ALT"));
        var trigger = key switch
        {
            "SPACE" => Space,
            { Length: 1 } when char.IsLetterOrDigit(key[0]) => key[0],
            _ when key?.StartsWith('F') == true && int.TryParse(key[1..], out var f) && f is >= 1 and <= 24 => 0x6F + f,
            _ => throw new ArgumentException("Shortcut key must be Space, A-Z, 0-9, or F1-F24.")
        };
        return new ShortcutDefinition(trigger, tokens.Contains("CONTROL") || tokens.Contains("CTRL") || tokens.Contains("COMMANDORCONTROL"), tokens.Contains("SHIFT"), tokens.Contains("ALT"));
    }
}

internal sealed class ShortcutHook : IDisposable
{
    private const int WhKeyboardLowLevel = 13, KeyDown = 0x0100, KeyUp = 0x0101, SystemKeyDown = 0x0104, SystemKeyUp = 0x0105;
    private const int Control = 0x11, Shift = 0x10, Alt = 0x12;
    private readonly HookProc callback;
    private IntPtr hook;
    private Thread? thread;
    private volatile bool active;
    private ShortcutDefinition definition = ShortcutDefinition.Parse("Control+Shift+Space");
    public event Action? ShortcutDown;
    public event Action? ShortcutUp;
    public ShortcutHook() => callback = Handle;
    public void Start()
    {
        thread = new Thread(() =>
        {
            using var process = Process.GetCurrentProcess();
            using var module = process.MainModule!;
            hook = SetWindowsHookEx(WhKeyboardLowLevel, callback, GetModuleHandle(module.ModuleName), 0);
            if (hook == IntPtr.Zero) throw new InvalidOperationException("Unable to install the Windows shortcut hook.");
            while (GetMessage(out var message, IntPtr.Zero, 0, 0)) { TranslateMessage(ref message); DispatchMessage(ref message); }
        }) { IsBackground = true, Name = "PresenterAI shortcut hook" };
        thread.Start();
    }
    public void Configure(string accelerator) { definition = ShortcutDefinition.Parse(accelerator); active = false; }
    internal bool ProcessKey(int key, bool down, bool up, Func<int, bool> isPressed)
    {
        var modifiersMatch = (!definition.Control || isPressed(Control)) && (!definition.Shift || isPressed(Shift)) && (!definition.Alt || isPressed(Alt));
        if (key == definition.TriggerKey && down && !active && modifiersMatch) { active = true; ShortcutDown?.Invoke(); return true; }
        if (key == definition.TriggerKey && up && active) { active = false; ShortcutUp?.Invoke(); return true; }
        return false;
    }
    private IntPtr Handle(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            var key = Marshal.ReadInt32(lParam); var message = wParam.ToInt32();
            ProcessKey(key, message is KeyDown or SystemKeyDown, message is KeyUp or SystemKeyUp, IsPressed);
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }
    public void Dispose() { if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook); }
    private static bool IsPressed(int key) => (GetAsyncKeyState(key) & 0x8000) != 0;
    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public int X; public int Y; }
    [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? moduleName);
    [DllImport("user32.dll")] private static extern bool GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
}
