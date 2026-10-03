// The UAT Demo's logic, kept free of Win32 so it builds and is tested natively.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace uatdemo {

struct User {
  std::string username;
  std::string display_name;
};

// The one account the demo knows: the credentials the example scenario uses.
// The username is trimmed and case-insensitive; the password is exact.
std::optional<User> sign_in(std::string_view username, std::string_view password);

// "UAT Demo <version>", plus " - <display name>" once signed in.
std::string window_title(std::string_view version, const std::optional<User>& user);

const std::vector<std::string>& reports();

// "<report>.pdf" with characters Windows forbids in file names replaced by '_'.
std::string export_file_name(std::string_view report);

// A one-page PDF: the title, then one line per entry.
std::string render_pdf(std::string_view title, const std::vector<std::string>& lines);

// Per-user state under %APPDATA%\UatDemo, so reset_app_state has something to reset.
struct Settings {
  std::string last_user;
};
std::string settings_to_ini(const Settings& s);
Settings settings_from_ini(std::string_view ini);

}  // namespace uatdemo
