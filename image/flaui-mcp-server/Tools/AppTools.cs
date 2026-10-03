using System.ComponentModel;
using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using FlaUI.Core;
using ModelContextProtocol.Server;

namespace FlaUiMcpServer.Tools;

/// <summary>
/// Setup tools. The harness withholds install_build, reset_app_state and launch_app from the LLM;
/// they are only called deterministically by the test runner.
/// </summary>
[McpServerToolType]
public static class AppTools
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(15) };

    [McpServerTool(Name = "install_build"),
     Description("Harness only. Download the build under test from an allow-listed HTTPS URL, verify SHA-256, install silently (per-user).")]
    public static async Task<string> InstallBuild(
        ServerOptions opts,
        [Description("Presigned HTTPS URL of the installer (.msi, .exe or .zip).")] string url,
        [Description("Expected SHA-256, hex.")] string sha256,
        [Description("Extra installer arguments.")] string? installerArgs = null,
        CancellationToken ct = default)
    {
        var uri = new Uri(url);
        if (uri.Scheme != Uri.UriSchemeHttps || !opts.AllowedHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase))
            return Json.Fail($"host '{uri.Host}' is not in --allowed-hosts");

        Directory.CreateDirectory(opts.InstallRoot);
        Directory.CreateDirectory(opts.LogRoot);
        var file = Path.Combine(opts.InstallRoot, Path.GetFileName(Uri.UnescapeDataString(uri.AbsolutePath)));

        await using (var src = await Http.GetStreamAsync(uri, ct))
        await using (var dst = File.Create(file))
            await src.CopyToAsync(dst, ct);

        string actual;
        await using (var fs = File.OpenRead(file))
            actual = Convert.ToHexString(await SHA256.HashDataAsync(fs, ct)).ToLowerInvariant();
        if (!actual.Equals(sha256.Trim(), StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(file);
            return Json.Fail($"sha256 mismatch: expected {sha256}, got {actual}");
        }

        var ext = Path.GetExtension(file).ToLowerInvariant();
        if (ext == ".zip")
        {
            var dest = Path.Combine(opts.InstallRoot, "app");
            if (Directory.Exists(dest)) Directory.Delete(dest, recursive: true);
            ZipFile.ExtractToDirectory(file, dest);
            return Json.Ok(new { installedTo = dest, sha256 = actual });
        }

        var log = Path.Combine(opts.LogRoot, "install.log");
        var psi = ext switch
        {
            // Session users are not administrators: the MSI must support per-user installs.
            ".msi" => new ProcessStartInfo("msiexec.exe",
                $"/i \"{file}\" /qn /norestart /l*v \"{log}\" {installerArgs ?? "ALLUSERS=2 MSIINSTALLPERUSER=1"}"),
            ".exe" => new ProcessStartInfo(file, installerArgs ?? "/S"),
            _ => null,
        };
        if (psi is null) return Json.Fail($"unsupported installer type '{ext}'");
        psi.UseShellExecute = false;

        using var p = Process.Start(psi) ?? throw new InvalidOperationException("installer did not start");
        await p.WaitForExitAsync(ct);
        return p.ExitCode is 0 or 3010
            ? Json.Ok(new { exitCode = p.ExitCode, sha256 = actual, log })
            : Json.Fail($"installer exit code {p.ExitCode}; see {log}");
    }

    [McpServerTool(Name = "launch_app"),
     Description("Harness only. Start the application and wait for its main window.")]
    public static string LaunchApp(
        AppHost host, ServerOptions opts,
        [Description("Path to the .exe; environment variables are expanded.")] string executablePath,
        [Description("Command-line arguments.")] string? arguments = null,
        [Description("Seconds to wait for the main window.")] int mainWindowTimeoutSeconds = 90)
    {
        var exe = Path.GetFullPath(Environment.ExpandEnvironmentVariables(executablePath));
        if (!opts.LaunchRoots.Any(r => ServerOptions.IsUnder(exe, r)))
            return Json.Fail($"'{exe}' is outside --launch-roots");
        if (!File.Exists(exe)) return Json.Fail($"'{exe}' does not exist");

        var app = Application.Launch(new ProcessStartInfo(exe, arguments ?? "")
        {
            WorkingDirectory = Path.GetDirectoryName(exe)!,
            UseShellExecute = false,
        });
        host.Attach(app);
        var win = app.GetMainWindow(host.Automation, TimeSpan.FromSeconds(mainWindowTimeoutSeconds));
        if (win is null) return Json.Fail($"main window did not appear within {mainWindowTimeoutSeconds}s");
        win.Focus();
        return Json.Ok(new { pid = app.ProcessId, title = win.Title });
    }

    [McpServerTool(Name = "reset_app_state"),
     Description("Harness only. Kill the app and delete per-user state directories under --state-root.")]
    public static string ResetAppState(
        AppHost host, ServerOptions opts,
        [Description("Process name without .exe.")] string processName,
        [Description("Directories relative to the parent of --state-root, e.g. YourCompany\\YourApp.")] string[] relativePaths)
    {
        host.Close();
        foreach (var p in Process.GetProcessesByName(processName))
        {
            try { p.Kill(entireProcessTree: true); p.WaitForExit(10_000); } catch { /* already gone */ }
        }
        var baseDir = Path.GetDirectoryName(opts.StateRoot.TrimEnd('\\'))!;
        var deleted = new List<string>();
        foreach (var rel in relativePaths)
        {
            var full = Path.GetFullPath(Path.Combine(baseDir, rel));
            if (!ServerOptions.IsUnder(full, opts.StateRoot) && !full.TrimEnd('\\').Equals(opts.StateRoot.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                return Json.Fail($"'{full}' is outside --state-root");
            if (Directory.Exists(full)) { Directory.Delete(full, recursive: true); deleted.Add(full); }
        }
        return Json.Ok(new { deleted });
    }

    [McpServerTool(Name = "read_log_tail"),
     Description("Return the last N lines of an application log file under the log or state root.")]
    public static string ReadLogTail(
        ServerOptions opts,
        [Description("Absolute path; environment variables are expanded.")] string path,
        [Description("Number of lines (max 500).")] int lines = 100)
    {
        var full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path));
        if (!ServerOptions.IsUnder(full, opts.LogRoot) && !ServerOptions.IsUnder(full, opts.StateRoot))
            return Json.Fail("path is outside --log-root/--state-root");
        if (!File.Exists(full)) return Json.Fail("file not found");
        using var fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var sr = new StreamReader(fs);
        var all = sr.ReadToEnd().Split('\n');
        return Json.Ok(new { lines = all.TakeLast(Math.Clamp(lines, 1, 500)) });
    }
}
