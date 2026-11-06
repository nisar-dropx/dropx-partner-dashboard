import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const login = readFileSync(new URL("../components/connect-login-flow.tsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../components/connect-dashboard.tsx", import.meta.url), "utf8");

test("workforce navigation goes directly to attendance", () => {
  assert.match(login, /open\("attendance"\).*<Fingerprint \/>Attendance/);
  assert.match(dashboard, /workforce && attendanceAllowed[\s\S]*onClick=\{onAttendance\}[\s\S]*<strong>Attendance<\/strong>/);
  assert.doesNotMatch(login, />Work schedule<|Pincode & weekly off|Attendance &amp; time off/);
  assert.doesNotMatch(dashboard, />Work schedule<|Attendance &amp; time off|onWork/);
});

test("legacy workforce work routes resolve to attendance", () => {
  assert.match(login, /next === "work" && !isIsolatedAmazonOtpAccount\(account\)\) next = "attendance"/);
  assert.match(login, /isWorkforceWorkspace\(account\) && \["roster", "leave", "lop", "wfh"\]\.includes\(next\)\) next = "attendance"/);
  assert.doesNotMatch(login, /<ConnectWorkforceWork/);
});

test("associate-facing components use Workforce language instead of HR labels", () => {
  for (const file of [
    "connect-attendance.tsx",
    "connect-approval-inbox.tsx",
    "connect-business-trip.tsx",
    "connect-communication-center.tsx",
    "connect-documents.tsx",
    "connect-leave.tsx",
    "connect-my-requests.tsx",
    "connect-performance.tsx",
    "connect-training.tsx",
    "connect-wfh.tsx"
  ]) {
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");
    const visibleCopy = source.replaceAll(/\bhr(?:Note|Help|Approvals?|HrApprovals?)?\b/g, "");
    assert.doesNotMatch(visibleCopy, /\bHR\b|Human Resources/, file);
  }
});
