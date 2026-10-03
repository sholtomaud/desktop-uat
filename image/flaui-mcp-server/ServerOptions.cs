namespace FlaUiMcpServer;

/// <summary>Guard rails passed as args in mcp_server_redirection_config.json.</summary>
public sealed record ServerOptions(
    string[] AllowedHosts,   // hosts install_build may download from (the builds bucket)
    string StateRoot,        // only paths under here may be deleted by reset_app_state
    string LogRoot,          // read_log_tail is confined here (plus StateRoot)
    string InstallRoot,      // downloads and zip extractions
    string[] LaunchRoots)    // launch_app only starts executables under these
{
    public static ServerOptions Parse(string[] args)
    {
        string? Get(string name)
        {
            var i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? Environment.ExpandEnvironmentVariables(args[i + 1]) : null;
        }
        string[] List(string name) => (Get(name) ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var install = Get("--install-root") ?? Path.Combine(local, "UatInstall");
        var launch = List("--launch-roots");
        return new ServerOptions(
            AllowedHosts: List("--allowed-hosts"),
            StateRoot: Full(Get("--state-root") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "YourCompany")),
            LogRoot: Full(Get("--log-root") ?? @"C:\UAT\logs"),
            InstallRoot: Full(install),
            LaunchRoots: (launch.Length > 0 ? launch : new[] { install, Path.Combine(local, "Programs") }).Select(Full).ToArray());
    }

    public static string Full(string p) => Path.GetFullPath(p).TrimEnd('\\') + "\\";

    public static bool IsUnder(string path, string root) =>
        Path.GetFullPath(path).StartsWith(root, StringComparison.OrdinalIgnoreCase);
}
