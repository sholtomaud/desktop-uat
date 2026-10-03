using System.Text.Json;

namespace FlaUiMcpServer;

internal static class Json
{
    private static readonly JsonSerializerOptions Opts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public static string Ok(object? data = null) => JsonSerializer.Serialize(new { ok = true, data }, Opts);
    public static string Fail(string message) => JsonSerializer.Serialize(new { ok = false, message }, Opts);
    public static string Assert(bool pass, string? actual, string expected, string message) =>
        JsonSerializer.Serialize(new { pass, actual, expected, message }, Opts);
    public static string Raw(object o) => JsonSerializer.Serialize(o, Opts);
}
