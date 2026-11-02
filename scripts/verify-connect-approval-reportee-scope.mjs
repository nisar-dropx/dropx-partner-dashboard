import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const component = read("apps/connect/src/components/connect-approval-inbox.tsx");
const scope = read("apps/connect/src/lib/connect-reportee-scope.ts");
const reportingTree = read("apps/connect/src/lib/connect-reporting-tree.ts");
const approvals = read("apps/connect/app/api/connect/approvals/route.ts");
const reimbursements = read("apps/connect/app/api/connect/reimbursements/route.ts");
const attendance = read("apps/connect/src/lib/connect-manager-approvals.ts");
const location = read("apps/connect/src/lib/connect-location-integrity.ts");
const resignation = read("apps/connect/src/lib/exit-resignation-route.ts");
const designations = read("apps/connect/src/lib/approval-designation-labels.ts");

function extractExport(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  if (start < 0) return "";
  const next = source.indexOf("\nexport async function ", start + 1);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

const attendanceManagerList = extractExport(attendance, "listConnectAttendanceApprovals");
const attendanceHrList = extractExport(attendance, "listConnectAttendanceHrApprovals");
const rosterSwapList = extractExport(attendance, "listConnectRosterSwapApprovals");

const checks = [
  [component.includes('useState<ReporteeScope>("immediate")'), "Approval Inbox always opens with immediate reportees"],
  [component.includes("Immediate reportees") && component.includes("Entire team"), "the user-controlled scope switch is present"],
  [component.includes("reporteeScope })"), "all Approval Inbox fetches send the selected reportee scope"],
  [component.includes('reporteeScope === "team" && payAdvanceOversight.length'), "pay-advance team oversight stays off Immediate reportees"],
  [component.includes('reporteeScope === "team" && expenseOversight.length'), "expense team oversight stays off Immediate reportees"],
  [scope.includes('=== "team" ? "team" : "immediate"'), "unknown or missing scope values safely default to immediate"],
  [scope.includes('relationship_type", "solid_line"') && scope.includes('is_primary", true'), "scope follows active primary solid-line Org Chart relationships"],
  [reportingTree.includes("while (queue.length)"), "Entire team recursively traverses the reporting tree"],
  [approvals.includes("loadConnectReporteeAccess(account, scope)"), "leave, attendance and location APIs load one shared reportee scope"],
  [
    approvals.includes('scope === "team"')
      && approvals.includes("resolveConnectVisibleApproverUserIds(account)")
      && approvals.includes("resolveConnectActorUserIds(account)")
      && approvals.includes('scope === "team" ? listConnectPayAdvanceOversight(account)'),
    "Entire team expands assigned queues; Immediate stays on this login only"
  ],
  [
    attendanceManagerList.includes("reportees.scope === \"team\"")
      && attendanceManagerList.includes("resolveConnectVisibleApproverUserIds")
      && attendanceManagerList.includes('.in("approver_user_id", actorUserIds)')
      && !attendanceManagerList.includes("connectReporteeMatches")
      && attendanceHrList.includes("loadConnectAttendanceApproveScope")
      && attendanceHrList.includes("connectWorkforceMatches")
      && !attendanceHrList.includes("connectReporteeMatches")
      && rosterSwapList.includes('.in("approver_user_id", actorUserIds)')
      && !rosterSwapList.includes("connectReporteeMatches"),
    "attendance reporting-line expansion follows the Immediate / Entire team toggle"
  ],
  [
    approvals.includes("listConnectWfhHrApprovals(account)")
      && approvals.includes("listConnectBusinessTripHrApprovals(account)")
      && approvals.includes("matchesReportee: () => true"),
    "HR queues remain independent of oversight filters"
  ],
  [
    reimbursements.includes('.in("approver_user_id", userIds)')
      && reimbursements.includes("Do not require org-chart reportee scope")
      && reimbursements.includes('scope === "team" ? expenseOversightSummary')
      && !reimbursements.includes("connectReporteeMatches(reportees"),
    "claims stay assignee-scoped; expense oversight loads only for Entire team"
  ],
  [location.includes("loadConnectReporteeAccess(account, reporteeScope)"), "location review authorization follows the selected reporting scope"],
  [
    designations.includes("isOperationsHeadDesignation")
      && resignation.includes("isOperationsHeadDesignation(designation)"),
    "Cluster Manager resignations can resolve to Head / Area Operations"
  ]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
