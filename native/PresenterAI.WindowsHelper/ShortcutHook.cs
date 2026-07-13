using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PresenterAI.WindowsHelper;

internal sealed class ShortcutHook : IDisposable
{
    private const int WH_KEYBOARD_LL = 13, WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
    private const int VK_SPACE = 0x20, VK_CONTROL = 0x11, VK_SHIFT = 0x10, VK_MENU = 0x12;
    private readonly HookProc callback;
    private IntPtr hook;
    private Thread? thread;
    private bool active;
    private int triggerKey = VK_SPACE;
    private bool requireControl = true, requireShift = true, requireAlt;
    public event Action? ShortcutDown;
    public event Action? ShortcutUp;
    public ShortcutHook() => callback = Handle;
    public void Start()
    {
        thread = new Thread(() => {
            using var process = Process.GetCurrentProcess(); using var module = process.MainModule!;
            hook = SetWindowsHookEx(WH_KEYBOARD_LL, callback, GetModuleHandle(module.ModuleName), 0);
            while (GetMessage(out var message, IntPtr.Zero, 0, 0)) { TranslateMessage(ref message); DispatchMessage(ref message); }
        }) { IsBackground = true, Name = "PresenterAI shortcut hook" };
        thread.Start();
    }
    public void Configure(string accelerator)
    {
        var tokens = accelerator.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(token => token.ToUpperInvariant()).ToArray();
        requireControl = tokens.Contains("CONTROL") || tokens.Contains("CTRL") || tokens.Contains("COMMANDORCONTROL");
        requireShift = tokens.Contains("SHIFT"); requireAlt = tokens.Contains("ALT");
        var key = tokens.LastOrDefault(token => token is not ("CONTROL" or "CTRL" or "COMMANDORCONTROL" or "SHIFT" or "ALT"));
        triggerKey = key switch { "SPACE" => VK_SPACE, { Length: 1 } => key![0], _ when key?.StartsWith('F') == true && int.TryParse(key[1..], out var f) && f is >= 1 and <= 24 => 0x6F + f, _ => throw new ArgumentException("Shortcut key must be Space, A-Z, 0-9, or F1-F24.") };
        active = false;
    }
    private IntPtr Handle(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            var key = Marshal.ReadInt32(lParam); var message = wParam.ToInt32();
            var down = message is WM_KEYDOWN or WM_SYSKEYDOWN; var up = message is WM_KEYUP or WM_SYSKEYUP;
            var modifiersMatch = (!requireControl || IsPressed(VK_CONTROL)) && (!requireShift || IsPressed(VK_SHIFT)) && (!requireAlt || IsPressed(VK_MENU));
            if (key == triggerKey && down && !active && modifiersMatch) { active = true; ShortcutDown?.Invoke(); }
            else if (key == triggerKey && up && active) { active = false; ShortcutUp?.Invoke(); }
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }
    public void Dispose() { if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook); }
    private static bool IsPressed(int key) => (GetAsyncKeyState(key) & 0x8000) != 0;
    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
    [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? moduleName);
    [DllImport("user32.dll")] private static extern bool GetMessage(out MSG message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG message);
}
