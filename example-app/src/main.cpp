// UAT Demo: the Win32 front end. All behaviour worth testing lives in core.cpp;
// this file is controls, layout and wiring.
//
// Every control a test touches gets a string AutomationId through UI Automation's
// dynamic annotation (IAccPropServices). A plain Win32 control's AutomationId is
// otherwise its numeric control ID, which is meaningless in a scenario. Setting
// them explicitly is the reliability advice in the README, put into practice.
#include <windows.h>
#include <commctrl.h>
#include <oleacc.h>
#include <shlobj.h>

#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "core.hpp"

#ifndef UATDEMO_VERSION
#define UATDEMO_VERSION "0.0.0"
#endif

namespace {

namespace fs = std::filesystem;

// UIA_AutomationIdPropertyId's GUID, for IAccPropServices. MinGW's headers lack it.
const GUID kAutomationIdProperty = {0xc82c0500, 0xb60e, 0x4310, {0xa2, 0x67, 0x30, 0x3c, 0x53, 0x1f, 0x8e, 0xe5}};
const CLSID kAccPropServices = {0xb5f8350b, 0x0548, 0x48b1, {0xa6, 0xee, 0x88, 0xbd, 0x00, 0xb4, 0xa5, 0xe7}};

enum : int {
  IDC_LOGO = 100, IDC_USER_LABEL, IDC_USERNAME, IDC_PASS_LABEL, IDC_PASSWORD, IDC_SIGNIN, IDC_SIGNIN_ERROR,
  IDC_DISPLAY_NAME, IDC_TABS, IDC_OVERVIEW, IDC_REPORTS, IDC_EXPORT, IDC_EXPORT_STATUS, IDC_STATUS,
  IDM_EXIT = 200, IDM_ABOUT,
};

// Help > About is shown after the menu command returns, not inside it. A UI
// Automation client that invokes the menu item would otherwise wait on the
// modal dialog until someone closed it.
constexpr UINT WM_APP_SHOW_ABOUT = WM_APP + 1;

struct App {
  HWND wnd{};
  HFONT font{}, big_font{};
  IAccPropServices* props{};
  std::vector<HWND> annotated;
  std::vector<HWND> login, dashboard, overview_page, reports_page;
  HWND username{}, password{}, signin_error{}, display_name{}, tabs{}, report_list{}, export_button{},
      export_status{}, status{};
  std::optional<uatdemo::User> user;
} g;

std::wstring widen(std::string_view s) {
  if (s.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

std::string narrow(std::wstring_view w) {
  if (w.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
  return s;
}

std::wstring text_of(HWND h) {
  const int n = GetWindowTextLengthW(h);
  std::wstring w(n + 1, L'\0');
  GetWindowTextW(h, w.data(), n + 1);
  w.resize(n);
  return w;
}

fs::path known_folder(REFKNOWNFOLDERID id) {
  PWSTR p = nullptr;
  fs::path out;
  if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &p))) out = p;
  CoTaskMemFree(p);
  return out;
}

// %APPDATA%\UatDemo: settings and log. reset_app_state deletes it.
fs::path state_dir() { return known_folder(FOLDERID_RoamingAppData) / L"UatDemo"; }

void log_line(const std::string& line) {
  std::error_code ec;
  fs::create_directories(state_dir(), ec);
  std::ofstream(state_dir() / L"uatdemo.log", std::ios::app) << line << "\n";
}

uatdemo::Settings load_settings() {
  std::ifstream f(state_dir() / L"settings.ini");
  std::stringstream ss;
  ss << f.rdbuf();
  return uatdemo::settings_from_ini(ss.str());
}

void save_settings(const uatdemo::Settings& s) {
  std::error_code ec;
  fs::create_directories(state_dir(), ec);
  std::ofstream(state_dir() / L"settings.ini") << uatdemo::settings_to_ini(s);
}

HWND make(const wchar_t* cls, const wchar_t* text, DWORD style, int x, int y, int w, int h, int id,
          const wchar_t* automation_id, DWORD ex_style = 0, HFONT font = nullptr) {
  HWND c = CreateWindowExW(ex_style, cls, text, WS_CHILD | WS_VISIBLE | style, x, y, w, h, g.wnd,
                           reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), GetModuleHandleW(nullptr), nullptr);
  SendMessageW(c, WM_SETFONT, reinterpret_cast<WPARAM>(font ? font : g.font), TRUE);
  if (g.props && automation_id) {
    g.props->SetHwndPropStr(c, OBJID_CLIENT, CHILDID_SELF, kAutomationIdProperty, automation_id);
    g.annotated.push_back(c);
  }
  return c;
}

void show(const std::vector<HWND>& group, bool visible) {
  for (HWND h : group) ShowWindow(h, visible ? SW_SHOW : SW_HIDE);
}

void show_tab(int index) {
  show(g.overview_page, g.user && index == 0);
  show(g.reports_page, g.user && index == 1);
}

void update_title() { SetWindowTextW(g.wnd, widen(uatdemo::window_title(UATDEMO_VERSION, g.user)).c_str()); }

void create_controls() {
  // Sign-in screen
  g.login = {
      make(L"STATIC", L"ACME  \x25C6  UAT Demo", SS_LEFT, 40, 30, 600, 44, IDC_LOGO, L"AppLogo", 0, g.big_font),
      make(L"STATIC", L"Username", SS_LEFT, 40, 110, 320, 20, IDC_USER_LABEL, nullptr),
      g.username = make(L"EDIT", L"", WS_TABSTOP | ES_AUTOHSCROLL, 40, 132, 320, 28, IDC_USERNAME,
                        L"UsernameBox", WS_EX_CLIENTEDGE),
      make(L"STATIC", L"Password", SS_LEFT, 40, 172, 320, 20, IDC_PASS_LABEL, nullptr),
      g.password = make(L"EDIT", L"", WS_TABSTOP | ES_AUTOHSCROLL | ES_PASSWORD, 40, 194, 320, 28, IDC_PASSWORD,
                        L"PasswordBox", WS_EX_CLIENTEDGE),
      make(L"BUTTON", L"Sign in", WS_TABSTOP | BS_DEFPUSHBUTTON, 40, 240, 120, 34, IDC_SIGNIN, L"SignInButton"),
      g.signin_error = make(L"STATIC", L"", SS_LEFT, 40, 286, 600, 22, IDC_SIGNIN_ERROR, L"SignInError"),
  };

  // Dashboard
  g.display_name = make(L"STATIC", L"", SS_LEFT, 40, 20, 600, 36, IDC_DISPLAY_NAME, L"DisplayName", 0, g.big_font);
  g.tabs = make(WC_TABCONTROLW, L"", WS_TABSTOP | WS_CLIPSIBLINGS, 40, 66, 800, 420, IDC_TABS, L"MainTabs");
  TCITEMW item{};
  item.mask = TCIF_TEXT;
  item.pszText = const_cast<wchar_t*>(L"Overview");
  SendMessageW(g.tabs, TCM_INSERTITEMW, 0, reinterpret_cast<LPARAM>(&item));
  item.pszText = const_cast<wchar_t*>(L"Reports");
  SendMessageW(g.tabs, TCM_INSERTITEMW, 1, reinterpret_cast<LPARAM>(&item));
  g.dashboard = {g.display_name, g.tabs};

  std::wstring overview = L"Welcome back. You have " + std::to_wstring(uatdemo::reports().size()) +
                          L" reports available on the Reports tab.";
  g.overview_page = {make(L"STATIC", overview.c_str(), SS_LEFT, 64, 116, 740, 60, IDC_OVERVIEW, L"OverviewText")};

  g.report_list = make(L"LISTBOX", L"", WS_TABSTOP | WS_BORDER | WS_VSCROLL | LBS_NOTIFY, 64, 116, 320, 120,
                       IDC_REPORTS, L"ReportList");
  for (const auto& r : uatdemo::reports()) {
    SendMessageW(g.report_list, LB_ADDSTRING, 0, reinterpret_cast<LPARAM>(widen(r).c_str()));
  }
  SendMessageW(g.report_list, LB_SETCURSEL, 0, 0);
  g.export_button = make(L"BUTTON", L"Export PDF", WS_TABSTOP, 404, 116, 140, 34, IDC_EXPORT, L"ExportButton");
  g.export_status = make(L"STATIC", L"", SS_LEFT, 64, 256, 740, 44, IDC_EXPORT_STATUS, L"ExportStatus");
  g.reports_page = {g.report_list, g.export_button, g.export_status};

  // The pages sit over the tab control's client area, so keep them above it.
  for (HWND h : g.overview_page) SetWindowPos(h, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
  for (HWND h : g.reports_page) SetWindowPos(h, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);

  g.status = make(L"STATIC", L"Ready", SS_LEFT | SS_SUNKEN, 0, 520, 880, 24, IDC_STATUS, L"StatusBarConnection");

  show(g.dashboard, false);
  show_tab(-1);

  const auto settings = load_settings();
  SetWindowTextW(g.username, widen(settings.last_user).c_str());
  SetFocus(settings.last_user.empty() ? g.username : g.password);
}

void try_sign_in() {
  auto u = uatdemo::sign_in(narrow(text_of(g.username)), narrow(text_of(g.password)));
  if (!u) {
    SetWindowTextW(g.signin_error, L"Incorrect username or password.");
    SetWindowTextW(g.password, L"");
    SetFocus(g.password);
    log_line("sign-in failed");
    return;
  }
  g.user = u;
  save_settings({u->username});
  log_line("signed in as " + u->username);

  show(g.login, false);
  SetWindowTextW(g.display_name, widen("Signed in as " + u->display_name).c_str());
  show(g.dashboard, true);
  SendMessageW(g.tabs, TCM_SETCURSEL, 0, 0);
  show_tab(0);
  SetWindowTextW(g.status, L"Connected");
  update_title();
}

void export_report() {
  auto sel = static_cast<int>(SendMessageW(g.report_list, LB_GETCURSEL, 0, 0));
  if (sel < 0) sel = 0;
  const auto& report = uatdemo::reports().at(static_cast<size_t>(sel));
  const fs::path path = known_folder(FOLDERID_Documents) / widen(uatdemo::export_file_name(report));
  const auto pdf = uatdemo::render_pdf(report, {"Prepared for " + g.user->display_name,
                                                std::string("Generated by UAT Demo ") + UATDEMO_VERSION,
                                                "Total (net): 42"});
  std::ofstream f(path, std::ios::binary);
  f << pdf;
  f.close();
  if (!f) {
    SetWindowTextW(g.export_status, (L"Export failed: could not write " + path.wstring()).c_str());
    log_line("export failed");
    return;
  }
  SetWindowTextW(g.export_status, (L"Exported " + widen(report) + L" to " + path.wstring()).c_str());
  log_line("exported " + report);
}

LRESULT CALLBACK wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_CREATE:
      g.wnd = hwnd;
      create_controls();
      return 0;
    case WM_COMMAND:
      switch (LOWORD(wp)) {
        case IDOK:  // Enter, via IsDialogMessage
        case IDC_SIGNIN:
          if (!g.user) try_sign_in();
          return 0;
        case IDC_EXPORT:
          export_report();
          return 0;
        case IDC_REPORTS:
          if (HIWORD(wp) == LBN_SELCHANGE) {
            EnableWindow(g.export_button, SendMessageW(g.report_list, LB_GETCURSEL, 0, 0) >= 0);
          }
          return 0;
        case IDM_ABOUT:
          PostMessageW(hwnd, WM_APP_SHOW_ABOUT, 0, 0);
          return 0;
        case IDM_EXIT:
          DestroyWindow(hwnd);
          return 0;
      }
      break;
    case WM_APP_SHOW_ABOUT: {
      const auto text = widen(std::string("UAT Demo ") + UATDEMO_VERSION) +
                        L"\nAn example application for desktop-uat.";
      MessageBoxW(hwnd, text.c_str(), L"About UAT Demo", MB_OK | MB_ICONINFORMATION);
      return 0;
    }
    case WM_NOTIFY:
      if (reinterpret_cast<NMHDR*>(lp)->code == TCN_SELCHANGE) {
        show_tab(static_cast<int>(SendMessageW(g.tabs, TCM_GETCURSEL, 0, 0)));
      }
      return 0;
    case WM_CTLCOLORSTATIC:
      SetBkColor(reinterpret_cast<HDC>(wp), GetSysColor(COLOR_WINDOW));
      return reinterpret_cast<LRESULT>(GetSysColorBrush(COLOR_WINDOW));
    case WM_DESTROY:
      // Annotations outlive their windows unless cleared.
      for (HWND h : g.annotated) g.props->ClearHwndProps(h, OBJID_CLIENT, CHILDID_SELF, &kAutomationIdProperty, 1);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

HMENU build_menu() {
  HMENU file = CreatePopupMenu();
  AppendMenuW(file, MF_STRING, IDM_EXIT, L"E&xit");
  HMENU help = CreatePopupMenu();
  AppendMenuW(help, MF_STRING, IDM_ABOUT, L"&About UAT Demo");
  HMENU bar = CreateMenu();
  AppendMenuW(bar, MF_POPUP, reinterpret_cast<UINT_PTR>(file), L"&File");
  AppendMenuW(bar, MF_POPUP, reinterpret_cast<UINT_PTR>(help), L"&Help");
  return bar;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show_cmd) {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  CoCreateInstance(kAccPropServices, nullptr, CLSCTX_INPROC_SERVER, IID_IAccPropServices,
                   reinterpret_cast<void**>(&g.props));

  INITCOMMONCONTROLSEX icc{};
  icc.dwSize = sizeof icc;
  icc.dwICC = ICC_TAB_CLASSES | ICC_STANDARD_CLASSES;
  InitCommonControlsEx(&icc);
  g.font = CreateFontW(-15, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
  g.big_font = CreateFontW(-26, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof wc;
  wc.lpfnWndProc = wnd_proc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
  wc.lpszClassName = L"UatDemoMain";
  wc.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  RegisterClassExW(&wc);

  // An 880x544 client area: fits a 1280x720 WorkSpaces desktop with room to spare.
  RECT r{0, 0, 880, 544};
  const DWORD style = WS_OVERLAPPEDWINDOW & ~(WS_THICKFRAME | WS_MAXIMIZEBOX);
  AdjustWindowRect(&r, style, TRUE);
  const auto title = widen(uatdemo::window_title(UATDEMO_VERSION, std::nullopt));
  HWND hwnd = CreateWindowExW(0, wc.lpszClassName, title.c_str(), style, CW_USEDEFAULT, CW_USEDEFAULT,
                              r.right - r.left, r.bottom - r.top, nullptr, build_menu(), instance, nullptr);
  ShowWindow(hwnd, show_cmd);
  UpdateWindow(hwnd);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    if (!IsDialogMessageW(hwnd, &msg)) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
  }
  if (g.props) g.props->Release();
  CoUninitialize();
  return static_cast<int>(msg.wParam);
}
