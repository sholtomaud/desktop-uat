using System.ComponentModel;
using System.Text.RegularExpressions;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.Core.Tools;
using ModelContextProtocol.Server;

namespace FlaUiMcpServer.Tools;

/// <summary>Deterministic UI Automation queries and actions. Safe to expose to the agent.</summary>
[McpServerToolType]
public static class UiTools
{
    // ------------------------------------------------------------------ helpers
    private static AutomationElement? Find(AppHost host, string? automationId, string? name, string? controlType,
                                           string? windowTitle, double timeoutSeconds)
    {
        var cf = host.Automation.ConditionFactory;
        var parts = new List<ConditionBase>();
        if (!string.IsNullOrEmpty(automationId)) parts.Add(cf.ByAutomationId(automationId));
        if (!string.IsNullOrEmpty(name)) parts.Add(cf.ByName(name));
        if (!string.IsNullOrEmpty(controlType))
        {
            if (!Enum.TryParse<ControlType>(controlType, ignoreCase: true, out var ct))
                throw new ArgumentException($"unknown controlType '{controlType}'");
            parts.Add(cf.ByControlType(ct));
        }
        if (parts.Count == 0) throw new ArgumentException("provide automationId, name and/or controlType");
        var cond = parts.Count == 1 ? parts[0] : new AndCondition(parts.ToArray());

        // A titled window is either top-level (a child of the desktop) or a dialog the app
        // owns, which UIA places under its owner window instead. It may also not exist yet:
        // null keeps the retry polling until it appears or the timeout passes.
        AutomationElement? Root()
        {
            if (string.IsNullOrEmpty(windowTitle)) return host.MainWindow(TimeSpan.FromSeconds(5));
            var byTitle = cf.ByName(windowTitle).And(cf.ByControlType(ControlType.Window));
            return host.Automation.GetDesktop().FindFirstChild(byTitle)
                ?? (host.App is null ? null : host.MainWindow(TimeSpan.FromSeconds(1)).FindFirstDescendant(byTitle));
        }

        return Retry.WhileNull(() => Root()?.FindFirstDescendant(cond),
            TimeSpan.FromSeconds(timeoutSeconds), TimeSpan.FromMilliseconds(250), throwOnTimeout: false).Result;
    }

    private static string? Read(AutomationElement e, string property) => property.ToLowerInvariant() switch
    {
        "name" => e.Properties.Name.ValueOrDefault,
        "automationid" => e.Properties.AutomationId.ValueOrDefault,
        "classname" => e.Properties.ClassName.ValueOrDefault,
        "helptext" => e.Properties.HelpText.ValueOrDefault,
        "isenabled" => B(e.Properties.IsEnabled.ValueOrDefault),
        "isoffscreen" => B(e.Properties.IsOffscreen.ValueOrDefault),
        "isvisible" => B(!e.Properties.IsOffscreen.ValueOrDefault),
        "haskeyboardfocus" => B(e.Properties.HasKeyboardFocus.ValueOrDefault),
        "value" => e.Patterns.Value.PatternOrDefault?.Value.ValueOrDefault,
        "togglestate" => e.Patterns.Toggle.PatternOrDefault?.ToggleState.ValueOrDefault.ToString(),
        "isselected" => e.Patterns.SelectionItem.PatternOrDefault is { } s ? B(s.IsSelected.ValueOrDefault) : null,
        "childcount" => e.FindAllChildren().Length.ToString(),
        _ => throw new ArgumentException($"unsupported property '{property}'"),
    };

    private static string B(bool b) => b ? "true" : "false";

    private static bool Compare(string? actual, string expected, string comparison) => comparison.ToLowerInvariant() switch
    {
        "equals" => string.Equals(actual, expected, StringComparison.Ordinal),
        "equals_ignore_case" => string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase),
        "not_equals" => !string.Equals(actual, expected, StringComparison.Ordinal),
        "contains" => actual?.Contains(expected, StringComparison.Ordinal) ?? false,
        "regex" => actual is not null && Regex.IsMatch(actual, expected, RegexOptions.None, TimeSpan.FromSeconds(1)),
        _ => throw new ArgumentException($"unknown comparison '{comparison}'"),
    };

    private static object Describe(AutomationElement e) => new
    {
        name = e.Properties.Name.ValueOrDefault,
        automationId = e.Properties.AutomationId.ValueOrDefault,
        controlType = e.Properties.ControlType.ValueOrDefault.ToString(),
        className = e.Properties.ClassName.ValueOrDefault,
        isEnabled = e.Properties.IsEnabled.ValueOrDefault,
        isOffscreen = e.Properties.IsOffscreen.ValueOrDefault,
        value = e.Patterns.Value.PatternOrDefault?.Value.ValueOrDefault,
        bounds = e.Properties.BoundingRectangle.ValueOrDefault.ToString(),
    };

    // ------------------------------------------------------------------ assertions
    [McpServerTool(Name = "assert_element"),
     Description("Deterministic assertion on a UI element property, polled until it passes or times out. " +
                 "property: exists|name|value|isEnabled|isVisible|isOffscreen|toggleState|isSelected|hasKeyboardFocus|className|helpText|childCount. " +
                 "comparison: equals|equals_ignore_case|not_equals|contains|regex. Returns {pass, actual, expected, message}.")]
    public static string AssertElement(
        AppHost host,
        string property, string expected,
        string? automationId = null, string? name = null, string? controlType = null, string? windowTitle = null,
        string comparison = "equals", double timeoutSeconds = 10)
    {
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
        string? actual = null;
        do
        {
            var el = Find(host, automationId, name, controlType, windowTitle, timeoutSeconds: 0.5);
            actual = property.Equals("exists", StringComparison.OrdinalIgnoreCase)
                ? B(el is not null)
                : el is null ? null : Read(el, property);
            if (actual is not null && Compare(actual, expected, comparison))
                return Json.Assert(true, actual, expected, $"{property} {comparison} '{expected}'");
            Thread.Sleep(250);
        } while (DateTime.UtcNow < deadline);

        var what = automationId ?? name ?? controlType;
        return Json.Assert(false, actual, expected,
            actual is null ? $"element '{what}' not found or property unavailable" : $"{property} was '{actual}'");
    }

    [McpServerTool(Name = "assert_window_title"),
     Description("Deterministic assertion on the main window title. comparison: equals|contains|regex|not_equals.")]
    public static string AssertWindowTitle(AppHost host, string expected, string comparison = "equals", double timeoutSeconds = 10)
    {
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
        string? title = null;
        do
        {
            try { title = host.MainWindow(TimeSpan.FromSeconds(1)).Title; } catch { title = null; }
            if (title is not null && Compare(title, expected, comparison))
                return Json.Assert(true, title, expected, "title matched");
            Thread.Sleep(250);
        } while (DateTime.UtcNow < deadline);
        return Json.Assert(false, title, expected, $"title was '{title}'");
    }

    // ------------------------------------------------------------------ queries & actions
    [McpServerTool(Name = "get_element"), Description("Return properties of the first matching UI element.")]
    public static string GetElement(AppHost host, string? automationId = null, string? name = null,
                                    string? controlType = null, string? windowTitle = null, double timeoutSeconds = 5)
    {
        var el = Find(host, automationId, name, controlType, windowTitle, timeoutSeconds);
        return el is null ? Json.Fail("element not found") : Json.Ok(Describe(el));
    }

    [McpServerTool(Name = "click_element"),
     Description("Invoke/click a UI element by AutomationId/Name. More reliable than clicking coordinates.")]
    public static string ClickElement(AppHost host, string? automationId = null, string? name = null,
                                      string? controlType = null, string? windowTitle = null, double timeoutSeconds = 5)
    {
        var el = Find(host, automationId, name, controlType, windowTitle, timeoutSeconds);
        if (el is null) return Json.Fail("element not found");
        if (!el.Properties.IsEnabled.ValueOrDefault) return Json.Fail("element is disabled");
        if (el.Patterns.Invoke.PatternOrDefault is { } inv) inv.Invoke();
        else el.Click(moveMouse: true);
        return Json.Ok(Describe(el));
    }

    [McpServerTool(Name = "set_text"), Description("Replace the text of an edit control.")]
    public static string SetText(AppHost host, string text, string? automationId = null, string? name = null,
                                 string? windowTitle = null, double timeoutSeconds = 5)
    {
        var el = Find(host, automationId, name, null, windowTitle, timeoutSeconds);
        if (el is null) return Json.Fail("element not found");
        if (el.Patterns.Value.PatternOrDefault is { } v && !v.IsReadOnly.ValueOrDefault) v.SetValue(text);
        else el.AsTextBox().Enter(text);
        return Json.Ok(new { automationId = el.Properties.AutomationId.ValueOrDefault });
    }

    [McpServerTool(Name = "dump_ui_tree"),
     Description("Return the UI Automation tree of the main window (name, automationId, controlType) to discover selectors.")]
    public static string DumpUiTree(AppHost host, int maxDepth = 4, int maxNodes = 300)
    {
        var count = 0;
        object Walk(AutomationElement e, int depth)
        {
            count++;
            var children = depth >= maxDepth || count >= maxNodes
                ? Array.Empty<object>()
                : e.FindAllChildren().TakeWhile(_ => count < maxNodes).Select(c => Walk(c, depth + 1)).ToArray();
            return new
            {
                n = e.Properties.Name.ValueOrDefault,
                id = e.Properties.AutomationId.ValueOrDefault,
                t = e.Properties.ControlType.ValueOrDefault.ToString(),
                c = children,
            };
        }
        return Json.Raw(Walk(host.MainWindow(TimeSpan.FromSeconds(5)), 0));
    }
}
