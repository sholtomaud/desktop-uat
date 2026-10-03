#include "core.hpp"

#include <algorithm>
#include <cctype>
#include <cstdio>

namespace uatdemo {
namespace {

std::string_view trim(std::string_view s) {
  while (!s.empty() && std::isspace(static_cast<unsigned char>(s.front()))) s.remove_prefix(1);
  while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back()))) s.remove_suffix(1);
  return s;
}

std::string lower(std::string_view s) {
  std::string out(s);
  std::transform(out.begin(), out.end(), out.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return out;
}

std::string pdf_string(std::string_view s) {
  std::string out = "(";
  for (char c : s) {
    if (c == '(' || c == ')' || c == '\\') out += '\\';
    out += c;
  }
  return out + ")";
}

}  // namespace

std::optional<User> sign_in(std::string_view username, std::string_view password) {
  if (lower(trim(username)) == "uat.tester" && password == "Uat-Test-Only-1") {
    return User{"uat.tester", "UAT Tester"};
  }
  return std::nullopt;
}

std::string window_title(std::string_view version, const std::optional<User>& user) {
  std::string t = "UAT Demo " + std::string(version);
  if (user) t += " - " + user->display_name;
  return t;
}

const std::vector<std::string>& reports() {
  static const std::vector<std::string> r{"Monthly summary", "Quarterly trend", "Audit log"};
  return r;
}

std::string export_file_name(std::string_view report) {
  std::string name(trim(report));
  if (name.empty()) name = "report";
  for (char& c : name) {
    if (std::string_view("<>:\"/\\|?*").find(c) != std::string_view::npos ||
        static_cast<unsigned char>(c) < 32) {
      c = '_';
    }
  }
  return name + ".pdf";
}

std::string render_pdf(std::string_view title, const std::vector<std::string>& lines) {
  std::string content = "BT /F1 18 Tf 72 770 Td " + pdf_string(title) + " Tj /F1 11 Tf";
  for (const auto& l : lines) content += " 0 -20 Td " + pdf_string(l) + " Tj";
  content += " ET";

  const std::vector<std::string> objects{
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
      "/Resources << /Font << /F1 5 0 R >> >> >>",
      "<< /Length " + std::to_string(content.size()) + " >>\nstream\n" + content + "\nendstream",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  };

  std::string pdf = "%PDF-1.4\n";
  std::vector<std::size_t> offsets;
  for (std::size_t i = 0; i < objects.size(); ++i) {
    offsets.push_back(pdf.size());
    pdf += std::to_string(i + 1) + " 0 obj\n" + objects[i] + "\nendobj\n";
  }
  const std::size_t xref = pdf.size();
  pdf += "xref\n0 " + std::to_string(objects.size() + 1) + "\n0000000000 65535 f \n";
  for (auto off : offsets) {
    char entry[21];
    std::snprintf(entry, sizeof entry, "%010zu 00000 n \n", off);
    pdf += entry;
  }
  pdf += "trailer\n<< /Size " + std::to_string(objects.size() + 1) + " /Root 1 0 R >>\n";
  pdf += "startxref\n" + std::to_string(xref) + "\n%%EOF\n";
  return pdf;
}

std::string settings_to_ini(const Settings& s) {
  return "[UatDemo]\nlast_user=" + s.last_user + "\n";
}

Settings settings_from_ini(std::string_view ini) {
  Settings s;
  while (!ini.empty()) {
    const auto nl = ini.find('\n');
    const auto line = trim(ini.substr(0, nl));
    ini = nl == std::string_view::npos ? std::string_view{} : ini.substr(nl + 1);
    const auto eq = line.find('=');
    if (eq == std::string_view::npos) continue;
    if (trim(line.substr(0, eq)) == "last_user") s.last_user = std::string(trim(line.substr(eq + 1)));
  }
  return s;
}

}  // namespace uatdemo
