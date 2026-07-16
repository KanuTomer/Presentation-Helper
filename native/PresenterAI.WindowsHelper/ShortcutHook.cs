using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PresenterAI.WindowsHelper;

internal sealed record ShortcutDefinition(int TriggerKey, bool Control, bool Shift, bool Alt)
{
    private const int Space = 0x20;
    private static readonly string[] ControlTokens = ["CONTROL", "CTRL", "COMMANDORCONTROL"];
    private static readonly string[] ModifierTokens = [.. ControlTokens, "SHIFT", "ALT"];

    public static ShortcutDefinition Parse(string accelerator)
    {
        if (string.IsNullOrWhiteSpace(accelerator))
            throw new ArgumentException("A shortcut is required.", nameof(accelerator));
        if (accelerator.Split('+').Any(string.IsNullOrWhiteSpace))
            throw new ArgumentException("Shortcut tokens cannot be empty.", nameof(accelerator));

        var tokens = accelerator.Split('+', StringSplitOptions.TrimEntries)
            .Select(token => token.ToUpperInvariant())
            .ToArray();
        if (tokens.Distinct(StringComparer.Ordinal).Count() != tokens.Length)
            throw new ArgumentException("Shortcut tokens cannot be repeated.", nameof(accelerator));

        var controls = tokens.Count(token => ControlTokens.Contains(token, StringComparer.Ordinal));
        if (controls > 1)
            throw new ArgumentException("Only one Control alias may be used.", nameof(accelerator));

        var keyTokens = tokens.Where(token => !ModifierTokens.Contains(token, StringComparer.Ordinal)).ToArray();
        if (keyTokens.Length != 1)
            throw new ArgumentException("A shortcut must contain exactly one trigger key.", nameof(accelerator));
        if (!tokens.Any(token => ModifierTokens.Contains(token, StringComparer.Ordinal)))
            throw new ArgumentException("A shortcut must contain at least one modifier.", nameof(accelerator));

        var key = keyTokens[0];
        var trigger = key switch
        {
            "SPACE" => Space,
            { Length: 1 } when char.IsAsciiLetterOrDigit(key[0]) => key[0],
            _ when key.StartsWith('F') && int.TryParse(key[1..], out var f) && f is >= 1 and <= 24 => 0x6F + f,
            _ => throw new ArgumentException("Shortcut key must be Space, A-Z, 0-9, or F1-F24.", nameof(accelerator))
        };

        return new ShortcutDefinition(
            trigger,
            controls == 1,
            tokens.Contains("SHIFT", StringComparer.Ordinal),
            tokens.Contains("ALT", StringComparer.Ordinal));
    }
}

internal sealed class ShortcutHook : IDisposable
{
    private const int WhKeyboardLowLevel = 13;
    private const int KeyDown = 0x0100;
    private const int KeyUp = 0x0101;
    private const int SystemKeyDown = 0x0104;
    private const int SystemKeyUp = 0x0105;
    private const int Control = 0x11;
    private const int Shift = 0x10;
    private const int Alt = 0x12;
    private const int LeftWindows = 0x5B;
    private const int RightWindows = 0x5C;
    private const uint WmQuit = 0x0012;

    private readonly HookProc callback;
    private readonly object stateLock = new();
    private IntPtr hook;
    private uint hookThreadId;
    private Thread? thread;
    private TaskCompletionSource<bool>? startup;
    private bool active;
    private bool disposed;
    private volatile bool isReady;
    private ShortcutDefinition definition = ShortcutDefinition.Parse("Control+Shift+Space");

    public event Action? ShortcutDown;
    public event Action? ShortcutUp;
    public bool IsReady => isReady;

    public ShortcutHook() => callback = Handle;

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        Task startupTask;
        lock (stateLock)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (thread is not null)
            {
                startupTask = startup?.Task ?? Task.CompletedTask;
            }
            else
            {
                startup = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                startupTask = startup.Task;
                thread = new Thread(HookThreadMain)
                {
                    IsBackground = true,
                    Name = "PresenterAI shortcut hook"
                };
                thread.Start();
            }
        }
        await startupTask.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken).ConfigureAwait(false);
    }

    public void Configure(string accelerator)
    {
        var parsed = ShortcutDefinition.Parse(accelerator);
        lock (stateLock)
        {
            definition = parsed;
            active = false;
        }
    }

    internal bool ProcessKey(int key, bool down, bool up, Func<int, bool> isPressed)
    {
        Action? notification = null;
        lock (stateLock)
        {
            var modifiersMatch = definition.Control == isPressed(Control)
                && definition.Shift == isPressed(Shift)
                && definition.Alt == isPressed(Alt)
                && !isPressed(LeftWindows)
                && !isPressed(RightWindows);
            if (key == definition.TriggerKey && down && !active && modifiersMatch)
            {
                active = true;
                notification = ShortcutDown;
            }
            else if (key == definition.TriggerKey && up && active)
            {
                active = false;
                notification = ShortcutUp;
            }
        }
        notification?.Invoke();
        return notification is not null;
    }

    private void HookThreadMain()
    {
        try
        {
            hookThreadId = GetCurrentThreadId();
            using var process = Process.GetCurrentProcess();
            using var module = process.MainModule ?? throw new InvalidOperationException("Unable to find the helper module.");
            hook = SetWindowsHookEx(WhKeyboardLowLevel, callback, GetModuleHandle(module.ModuleName), 0);
            if (hook == IntPtr.Zero)
                throw new InvalidOperationException("Unable to install the Windows shortcut hook.");
            isReady = true;
            startup?.TrySetResult(true);

            while (GetMessage(out var message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        }
        catch (Exception error)
        {
            startup?.TrySetException(error);
        }
        finally
        {
            isReady = false;
            if (hook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(hook);
                hook = IntPtr.Zero;
            }
        }
    }

    private IntPtr Handle(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            var key = Marshal.ReadInt32(lParam);
            var message = wParam.ToInt32();
            ProcessKey(
                key,
                message is KeyDown or SystemKeyDown,
                message is KeyUp or SystemKeyUp,
                IsPressed);
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }

    public void Dispose()
    {
        Thread? activeThread;
        uint activeThreadId;
        lock (stateLock)
        {
            if (disposed) return;
            disposed = true;
            active = false;
            activeThread = thread;
            activeThreadId = hookThreadId;
        }

        if (activeThreadId != 0) PostThreadMessage(activeThreadId, WmQuit, UIntPtr.Zero, IntPtr.Zero);
        if (activeThread is not null && activeThread != Thread.CurrentThread)
            activeThread.Join(TimeSpan.FromSeconds(2));
    }

    private static bool IsPressed(int key) => (GetAsyncKeyState(key) & 0x8000) != 0;
    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr Window;
        public uint Id;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? moduleName);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
}
