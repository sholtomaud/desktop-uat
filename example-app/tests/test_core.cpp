// Tests for the UAT Demo's logic. No framework: a failed CHECK prints where and
// what, and the process exits non-zero.
#include "core.hpp"

#include <cstdio>
#include <cstdlib>
#include <string>

static int failures = 0;
#define CHECK(cond)                                                              \
  do {                                                                           \
    if (!(cond)) {                                                               \
      std::fprintf(stderr, "%s:%d: CHECK(%s) failed\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                                \
    }                                                                            \
  } while (0)

using namespace uatdemo;

static void the_test_account_signs_in() {
  auto u = sign_in("uat.tester", "Uat-Test-Only-1");
  CHECK(u.has_value());
  CHECK(u && u->username == "uat.tester");
  CHECK(u && u->display_name == "UAT Tester");
}

static void the_username_is_forgiving_but_the_password_is_not() {
  CHECK(sign_in("  UAT.Tester ", "Uat-Test-Only-1").has_value());
  CHECK(!sign_in("uat.tester", "uat-test-only-1").has_value());
  CHECK(!sign_in("uat.tester", "Uat-Test-Only-1 ").has_value());
  CHECK(!sign_in("uat.tester", "").has_value());
  CHECK(!sign_in("", "Uat-Test-Only-1").has_value());
  CHECK(!sign_in("someone.else", "Uat-Test-Only-1").has_value());
}

static void the_title_carries_the_version_and_who_is_signed_in() {
  CHECK(window_title("1.4.0", std::nullopt) == "UAT Demo 1.4.0");
  CHECK(window_title("1.4.0", sign_in("uat.tester", "Uat-Test-Only-1")) == "UAT Demo 1.4.0 - UAT Tester");
}

static void there_is_a_monthly_summary_report_first() {
  CHECK(!reports().empty());
  CHECK(reports().front() == "Monthly summary");
}

static void export_names_are_safe_file_names() {
  CHECK(export_file_name("Monthly summary") == "Monthly summary.pdf");
  CHECK(export_file_name("a/b\\c:d*e?f\"g<h>i|j") == "a_b_c_d_e_f_g_h_i_j.pdf");
  CHECK(export_file_name("") == "report.pdf");
}

static std::size_t offset_of_object(const std::string& pdf, int n) {
  return pdf.find("\n" + std::to_string(n) + " 0 obj") + 1;
}

static void the_pdf_is_well_formed() {
  const std::string pdf = render_pdf("Monthly summary", {"Prepared for UAT Tester", "Total (net): 42"});
  CHECK(pdf.rfind("%PDF-1.4\n", 0) == 0);
  CHECK(pdf.size() > 6 && pdf.compare(pdf.size() - 6, 6, "%%EOF\n") == 0);

  // Every xref entry points at the object it names.
  const auto xref = pdf.find("xref\n0 6\n");
  CHECK(xref != std::string::npos);
  for (int n = 1; n <= 5; ++n) {
    const auto entry = pdf.substr(xref + 9 + 20 * n, 10);
    CHECK(std::stoul(entry) == offset_of_object(pdf, n));
  }
  // startxref points at the xref table.
  const auto sx = pdf.find("startxref\n");
  CHECK(std::stoul(pdf.substr(sx + 10)) == xref);
}

static void pdf_text_is_escaped() {
  const std::string pdf = render_pdf("A (b) \\ c", {});
  CHECK(pdf.find("(A \\(b\\) \\\\ c) Tj") != std::string::npos);
}

static void settings_round_trip() {
  Settings s;
  s.last_user = "uat.tester";
  CHECK(settings_from_ini(settings_to_ini(s)).last_user == "uat.tester");
}

static void settings_tolerate_junk_and_missing_keys() {
  CHECK(settings_from_ini("").last_user.empty());
  CHECK(settings_from_ini("garbage\n[x]\nlast_user = a.b \r\nother=1\n").last_user == "a.b");
}

int main() {
  the_test_account_signs_in();
  the_username_is_forgiving_but_the_password_is_not();
  the_title_carries_the_version_and_who_is_signed_in();
  there_is_a_monthly_summary_report_first();
  export_names_are_safe_file_names();
  the_pdf_is_well_formed();
  pdf_text_is_escaped();
  settings_round_trip();
  settings_tolerate_junk_and_missing_keys();
  if (failures) {
    std::fprintf(stderr, "%d check(s) failed\n", failures);
    return EXIT_FAILURE;
  }
  std::puts("core: all checks passed");
  return EXIT_SUCCESS;
}
