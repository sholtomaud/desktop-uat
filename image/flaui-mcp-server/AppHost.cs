using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.UIA3;

namespace FlaUiMcpServer;

/// <summary>Holds the UIA3 automation and the app under test for the life of the session.</summary>
public sealed class AppHost : IDisposable
{
    public UIA3Automation Automation { get; } = new();
    public Application? App { get; private set; }

    public void Attach(Application app) { Close(); App = app; }

    public Window MainWindow(TimeSpan timeout) =>
        App?.GetMainWindow(Automation, timeout)
        ?? throw new InvalidOperationException("App not launched (call launch_app) or main window not found.");

    public void Close()
    {
        try
        {
            if (App is { HasExited: false })
            {
                App.Close();
                if (!App.HasExited) App.Kill();
            }
        }
        catch { /* best effort */ }
        App?.Dispose();
        App = null;
    }

    public void Dispose() { Close(); Automation.Dispose(); }
}
