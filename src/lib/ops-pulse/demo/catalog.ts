import type { NavItem } from "../../app-navigation";
export type Workspace = "last-mile" | "q-commerce";
export type Kind =
  | "dashboard"
  | "attendance"
  | "roster"
  | "checklist"
  | "shift-report"
  | "store-report"
  | "audit"
  | "performance"
  | "review"
  | "payment"
  | "cost"
  | "workforce"
  | "mapping"
  | "cod"
  | "fleet"
  | "loss"
  | "document"
  | "report-bot"
  | "report"
  | "master"
  | "people";
export type Definition = {
  kind: Kind;
  description: string;
  columns: string[];
  examples: string[][];
  action?: string;
};
export type DemoMenu = {
  id: string;
  label: string;
  group: string;
  href: string;
  definition: Definition;
};
const definitions: Record<string, Definition> = {};
function define(
  paths: string[],
  kind: Kind,
  description: string,
  columns: string[],
  examples: string[][],
  action?: string,
) {
  for (const path of paths)
    definitions[path] = { kind, description, columns, examples, action };
}
define(
  ["/"],
  "dashboard",
  "A connected view of today’s operation, priorities and cost.",
  [],
  [],
);
define(
  ["/ops-pulse?view=manpower", "/attendance", "/daily-submission"],
  "attendance",
  "Scheduled people, reporting times and exceptions by location.",
  ["Person", "Designation", "Shift", "Reported at"],
  [
    ["Alex Rao", "Shift incharge", "06:00–14:00", "05:54"],
    ["Maya Das", "Team leader", "14:00–22:00", "13:52"],
    ["Leena Shah", "Associate", "06:00–14:00", "06:08"],
    ["Arjun Sen", "Associate", "22:00–06:00", "21:50"],
  ],
  "Record check-in",
);
define(
  ["/rostering"],
  "roster",
  "Plan shifts, review coverage and follow the approval journey.",
  ["Person", "Designation", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  [
    [
      "Alex Rao",
      "Shift incharge",
      "06–14",
      "06–14",
      "Off",
      "14–22",
      "14–22",
      "14–22",
      "06–14",
    ],
    [
      "Maya Das",
      "Shift incharge",
      "14–22",
      "14–22",
      "06–14",
      "Off",
      "06–14",
      "06–14",
      "14–22",
    ],
    [
      "Leena Shah",
      "Associate",
      "06–14",
      "Off",
      "06–14",
      "06–14",
      "14–22",
      "14–22",
      "06–14",
    ],
    [
      "Arjun Sen",
      "Associate",
      "22–06",
      "22–06",
      "22–06",
      "22–06",
      "Off",
      "22–06",
      "22–06",
    ],
  ],
  "Approve roster",
);
define(
  ["/si-handover?view=start", "/store-ops?view=start"],
  "checklist",
  "Complete the sample checklist, record a gap and follow it through handover.",
  ["Report", "Owner", "Shift / period", "Required answers"],
  [
    ["Morning shift", "Alex Rao", "06:00–14:00", "6 / 8"],
    ["Afternoon shift", "Maya Das", "14:00–22:00", "8 / 8"],
    ["Night shift", "Arjun Sen", "22:00–06:00", "5 / 8"],
  ],
  "Open checklist",
);
define(
  ["/si-handover/report?tab=shift"],
  "shift-report",
  "Submission and acceptance are separate. Open a report to see the tasks and handover.",
  ["Owner", "Shift", "Submitted", "Completion", "Handover"],
  [
    ["Alex Rao", "06:00–14:00", "No", "75%", "Not submitted"],
    ["Maya Das", "14:00–22:00", "Yes", "100%", "Accepted"],
    ["Arjun Sen", "22:00–06:00", "No", "63%", "In progress"],
  ],
  "Open checklist",
);
define(
  ["/si-handover/report?tab=store"],
  "store-report",
  "Daily store reporting with named owners, completion and previous-day context.",
  ["Owner", "Report date", "Submitted", "Completion", "Previous day"],
  [
    ["Alex Rao", "26 Oct 2026", "No", "75%", "100%"],
    ["Maya Das", "26 Oct 2026", "Yes", "100%", "100%"],
    ["Leena Shah", "26 Oct 2026", "No", "63%", "88%"],
  ],
  "Open checklist",
);
define(
  ["/store-audits", "/audits"],
  "audit",
  "Schedule an inspection, record evidence and close corrective actions.",
  ["Audit", "Auditor", "Scheduled", "Score", "Open actions"],
  [
    ["Safety & readiness", "Maya Das", "26 Oct · 10:00", "96%", "1"],
    ["Process compliance", "Alex Rao", "25 Oct · 11:00", "100%", "0"],
    ["Monthly inspection", "Leena Shah", "28 Oct · 09:30", "Not started", "0"],
  ],
  "Record action taken",
);
define(
  [
    "/performance?view=daily",
    "/performance?view=sls",
    "/performance/review-status",
    "/?view=hourly",
    "/?view=shift",
  ],
  "performance",
  "Targets, actuals and exceptions with the evidence behind each result.",
  ["Metric", "Actual", "Target", "Previous day"],
  [
    ["On-time completion", "98.6%", "98.0%", "98.2%"],
    ["First-time success", "98.1%", "97.0%", "97.8%"],
    ["Quality compliance", "99.2%", "99.0%", "99.0%"],
    ["Reporting compliance", "100%", "100%", "100%"],
  ],
  "Record review",
);
define(
  ["/performance?view=reviews"],
  "review",
  "Review an exception, assign its owner and verify the corrective action.",
  ["Review", "Owner", "Metric", "Due"],
  [
    ["Repeat scan exception", "Alex Rao", "2 of 1,240 orders", "Today · 17:00"],
    [
      "Peak-hour coverage",
      "Maya Das",
      "1 additional associate",
      "Today · 14:00",
    ],
    ["Quality follow-up", "Leena Shah", "99.2% compliance", "27 Oct · 12:00"],
  ],
  "Resolve review",
);
define(
  [
    "/payments/advance-request",
    "/payments/pay-advances",
    "/payments/requests",
    "/payments/approvals",
    "/payments/report",
  ],
  "payment",
  "Explore a sample request from approval through payment details and settlement.",
  ["Request", "Payment head", "Requested by", "Amount"],
  [
    ["DEMO-PAY-101", "Adhoc support", "Alex Rao", "₹1,200"],
    ["DEMO-PAY-102", "Van fuel", "Maya Das", "₹800"],
    ["DEMO-PAY-103", "Maintenance", "Leena Shah", "₹2,400"],
    ["DEMO-PAY-104", "Consumables", "Arjun Sen", "₹650"],
  ],
  "Review request",
);
define(
  ["/cps", "/cpu", "/cps/adhoc-activity"],
  "cost",
  "Trace unit economics to the volumes and cost components in this sample.",
  ["Component", "Units", "Amount", "Cost / unit"],
  [
    ["People / associate pay", "12,400", "₹1,55,000", "₹12.50"],
    ["Fleet / facilities", "12,400", "₹37,200", "₹3.00"],
    ["Fuel / utilities", "12,400", "₹18,600", "₹1.50"],
    ["Other operations", "12,400", "₹12,400", "₹1.00"],
  ],
  "Inspect cost source",
);
define(
  [
    "/work-force-register",
    "/payments/workforce-payouts",
    "/payments/workforce-advances",
    "/payments/disputes",
  ],
  "workforce",
  "Sample workforce records with attendance, production and payment context.",
  ["Person", "Workforce ID", "Worked days", "Production", "Gross pay"],
  [
    ["Alex Rao", "DEMO-DA-001", "24", "1,840", "₹31,280"],
    ["Maya Das", "DEMO-DA-002", "25", "1,920", "₹32,640"],
    ["Leena Shah", "DEMO-DA-003", "24", "1,780", "₹30,260"],
    ["Arjun Sen", "DEMO-DA-004", "23", "1,730", "₹29,410"],
  ],
  "Review profile",
);
define(
  ["/provider-id-mapping", "/provider-id-mapping/summary", "/fleet/da-mapping"],
  "mapping",
  "Map a sample identifier to a person or vehicle with effective dates.",
  ["Provider / vehicle ID", "Person", "Effective from", "Payment / assignment"],
  [
    ["DEMO-ID-001", "Alex Rao", "01 Oct 2026", "₹17 / delivery"],
    ["DEMO-ID-002", "Maya Das", "01 Oct 2026", "₹17 / delivery"],
    ["DEMO-ID-003", "Leena Shah", "15 Oct 2026", "₹17 / delivery"],
  ],
  "Save mapping",
);
define(
  [
    "/capacity",
    "/capacity/associates",
    "/capacity/hiring",
    "/performance/shipments",
    "/service-network",
    "/edd/flash",
  ],
  "performance",
  "Connect demand, coverage and delivery outcomes to the next operational action.",
  ["Measure", "Actual", "Planned", "Context"],
  [
    ["Delivered / processed", "1,240", "1,260", "98.4% completion"],
    ["Active associates", "16", "16", "Coverage met"],
    ["Production / associate", "77.5", "75", "Above plan"],
    ["Tomorrow demand", "1,310", "1,350 capacity", "40-unit headroom"],
  ],
  "Review plan",
);
define(
  ["/edd/scrub"],
  "report",
  "In-station and on-road scrub status together, with pending days and history.",
  ["Station", "In-station", "On-road", "Last fetched"],
  [
    ["DEMO-01", "Done today", "2d pending", "Today · 09:10"],
    ["DEMO-02", "3d pending", "Done today", "Today · 09:10"],
    ["DEMO-03", "7+ days pending", "1d pending", "Today · 09:10"],
  ],
  "View scrub history",
);
define(
  [
    "/capacity/distance",
    "/attendance/da-distance",
    "/attendance/workforce-mileage",
  ],
  "fleet",
  "Distance, trips and fuel evidence for the selected operation.",
  ["Person / vehicle", "Distance", "Trips", "Claim"],
  [
    ["Alex Rao · DEMO-V01", "78 km", "2", "₹234"],
    ["Maya Das · DEMO-V02", "64 km", "2", "₹192"],
    ["Leena Shah · DEMO-V03", "91 km", "3", "₹273"],
  ],
  "Verify evidence",
);
define(
  [
    "/cod/executive-reconciliation?client=amazon",
    "/cod/submission?client=amazon",
    "/cod/submission?client=flipkart",
    "/cod/status?client=amazon",
    "/cod/status?client=flipkart",
    "/cod/cash-in-associate?client=amazon",
    "/cod/pending",
    "/cod/status",
  ],
  "cod",
  "Reconcile collected cash, remittance and deposit evidence. Variance needs attention.",
  ["Reference", "Collected", "Deposited", "Variance"],
  [
    ["DEMO-COD-01", "₹24,500", "₹24,500", "₹0"],
    ["DEMO-COD-02", "₹18,750", "₹18,650", "₹100"],
    ["DEMO-COD-03", "₹32,100", "₹32,098", "₹2"],
  ],
  "Verify remittance",
);
define(
  [
    "/fleet?tab=action-center",
    "/fleet?tab=vehicle-view",
    "/fleet?tab=date-view",
    "/fleet?tab=station-view",
    "/fleet?tab=tracking",
    "/fleet?tab=fuel-log",
    "/fleet?tab=live-gps",
    "/fleet?tab=maintenance",
    "/fleet?tab=report",
  ],
  "fleet",
  "Fleet readiness, assignment, documents and operating evidence.",
  ["Vehicle", "Type", "Assigned person", "Distance", "Next service"],
  [
    ["DEMO-V01", "Electric van", "Alex Rao", "78 km", "03 Nov"],
    ["DEMO-V02", "Three wheeler", "Maya Das", "64 km", "06 Nov"],
    ["DEMO-V03", "Cargo van", "Arjun Sen", "91 km", "Today"],
  ],
  "Update sample vehicle",
);
define(
  [
    "/team-ops/losses",
    "/attendance/workforce-losses",
    "/attendance/salary-hold",
    "/attendance/workforce-holds",
  ],
  "loss",
  "Track a sample decision, responsible person and recovery plan without payroll effects.",
  ["Tracking / claim", "Reason", "Decision", "Amount", "Recovery owner"],
  [
    ["DEMO-TID-101", "Package damage", "Recoverable", "₹450", "Alex Rao"],
    ["DEMO-TID-102", "Missing item", "Under review", "₹800", "Unassigned"],
    [
      "DEMO-TID-103",
      "Scan discrepancy",
      "Non-recoverable",
      "₹620",
      "Not applicable",
    ],
  ],
  "Update sample plan",
);
define(
  [
    "/attendance/my-team",
    "/attendance/unplanned-leaves",
    "/attendance/offboarding",
  ],
  "people",
  "People, reporting lines and operational follow-up in the sample organisation.",
  ["Person", "Designation", "Reports to", "Action"],
  [
    ["Alex Rao", "Team leader", "Sample area manager", "Roster review"],
    ["Maya Das", "Shift incharge", "Sample store manager", "Handover review"],
    ["Leena Shah", "Associate", "Alex Rao", "Training follow-up"],
  ],
  "Update sample record",
);
define(
  ["/business-documents"],
  "document",
  "Preview sample compliance documents and renewal dates without leaving the page.",
  ["Document", "Reference", "Valid through", "Owner"],
  [
    ["Trade licence", "SAMPLE-DOC-01", "31 Dec 2026", "Sample compliance lead"],
    [
      "Safety inspection",
      "SAMPLE-DOC-02",
      "30 Nov 2026",
      "Sample operations lead",
    ],
    [
      "Facility agreement",
      "SAMPLE-DOC-03",
      "31 Mar 2027",
      "Sample facility lead",
    ],
  ],
  "View document",
);
define(
  ["/report-bot"],
  "report-bot",
  "Try a scripted reporting conversation and inspect the structured store update.",
  ["Message", "Source", "Parsed result", "Time"],
  [
    [
      "Opening readiness complete",
      "Sample shift group",
      "8 / 8 checks",
      "06:05",
    ],
    [
      "Inbound received: 1,240 units",
      "Sample store group",
      "1,240 units received",
      "10:15",
    ],
    [
      "Shift closed with one carry-forward",
      "Sample handover group",
      "1 issue assigned",
      "14:02",
    ],
  ],
  "View parsed report",
);
define(
  ["/reports"],
  "report",
  "Download and explore example reports from across the workspace.",
  ["Report", "Period", "Records", "Format"],
  [
    ["Operational performance", "20–26 Oct 2026", "21", "CSV"],
    ["Shift reporting", "20–26 Oct 2026", "63", "CSV"],
    ["Cost breakdown", "October 2026", "12", "CSV"],
    ["Approval history", "October 2026", "18", "CSV"],
  ],
  "View report",
);
define(
  ["/master/cps", "/cpu/master"],
  "master",
  "Configure illustrative cost heads, units and targets.",
  ["Setting", "Value", "Applies to", "Owner"],
  [
    [
      "Target cost / unit",
      "₹18.00",
      "All sample locations",
      "Sample finance lead",
    ],
    [
      "People cost source",
      "Approved payroll",
      "Monthly",
      "Sample finance lead",
    ],
    ["Volume source", "Completed units", "Daily", "Sample operations lead"],
  ],
  "Edit sample setting",
);
define(
  ["/master/store-audits", "/master/audits"],
  "master",
  "Sections, questions, evidence requirements and action deadlines.",
  ["Question / rule", "Requirement", "Evidence", "Response timeline"],
  [
    ["Fire exits unobstructed", "Mandatory", "1 photo", "24 hours"],
    ["Temperature controls", "Mandatory", "4 photos", "4 hours"],
    ["Stock area clean", "Mandatory", "1–3 photos", "48 hours"],
  ],
  "Edit sample setting",
);
define(
  ["/master/si-handover", "/master/store-ops"],
  "master",
  "Checklist questions, shift slots, evidence and reporting cadence.",
  ["Question / rule", "Cadence", "Requirement", "Evidence"],
  [
    ["Opening readiness", "Every shift", "Mandatory", "1 photo"],
    ["Cold-chain temperatures", "Every 2 hours", "Mandatory", "4 photos"],
    ["Weekly safety review", "Weekly", "Mandatory", "1 document"],
  ],
  "Edit sample setting",
);
define(
  ["/master/location"],
  "master",
  "Fictional locations and their operating assignments.",
  ["Setting", "Value", "Model", "Owner"],
  [
    ["Location 01", "Primary operation", "Sample model", "Alex Rao"],
    ["Location 02", "Regional operation", "Sample model", "Maya Das"],
    ["Location 03", "City operation", "Sample model", "Leena Shah"],
  ],
  "Edit sample setting",
);
define(
  ["/master/providers", "/master/models", "/master/client-id"],
  "master",
  "Illustrative client and operating-model configuration.",
  ["Setting", "Value", "Rule", "Status"],
  [
    ["Client", "Sample marketplace", "Location-scoped", "Enabled"],
    ["Provider ID", "DEMO-ID-001", "Unique identity", "Enabled"],
    ["Operational model", "Sample operation", "Effective-dated", "Enabled"],
  ],
  "Edit sample setting",
);
define(
  ["/master/performance-targets", "/master/capacity"],
  "master",
  "Review sample targets and capacity planning thresholds.",
  ["Measure", "Target", "Cadence", "Escalation"],
  [
    ["On-time completion", "98%", "Daily", "Operations lead"],
    ["Quality compliance", "99%", "Daily", "Store / station lead"],
    ["Coverage", "100%", "Each shift", "Area manager"],
  ],
  "Edit sample setting",
);
define(
  ["/master/advertising"],
  "master",
  "Sample hiring campaigns and their approval limits.",
  ["Campaign", "Budget", "Channel", "Owner"],
  [
    ["Associate hiring", "₹5,000", "Local awareness", "Sample area lead"],
    [
      "Peak season campaign",
      "₹10,000",
      "Digital campaign",
      "Sample recruiting lead",
    ],
    [
      "Referral drive",
      "₹2,500",
      "Employee referrals",
      "Sample recruiting lead",
    ],
  ],
  "Edit sample campaign",
);
define(
  ["/master/cod-master"],
  "master",
  "Cash pickup windows and variance controls.",
  ["Control", "Value", "Cadence", "Owner"],
  [
    [
      "Deposit variance tolerance",
      "₹5",
      "Every remittance",
      "Sample finance lead",
    ],
    ["Cash pickup window", "14:00–15:00", "Daily", "Sample station lead"],
    ["Reconciliation deadline", "21:00", "Daily", "Sample operations lead"],
  ],
  "Edit sample setting",
);
define(
  ["/master/loss-recovery"],
  "master",
  "Illustrative recovery actions and supporting evidence rules.",
  ["Action", "Requirement", "Evidence", "Review"],
  [
    [
      "Employee recovery",
      "Named person and amount",
      "Recovery plan",
      "Operations approval",
    ],
    [
      "Company absorption",
      "Business justification",
      "Decision note",
      "Finance approval",
    ],
    [
      "Restricted re-dispute",
      "Reason and ticket reference",
      "Footage link",
      "Authorised reviewer",
    ],
  ],
  "Edit sample action",
);
define(
  ["/master/service-network"],
  "master",
  "Example service areas, linked stations and capacity.",
  ["Area", "Station", "Coverage", "Capacity"],
  [
    ["North zone", "LM01", "Sample route A", "450 shipments"],
    ["Central zone", "LM02", "Sample route B", "420 shipments"],
    ["South zone", "LM03", "Sample route C", "480 shipments"],
  ],
  "Edit sample area",
);
define(
  ["/settings/notifications"],
  "master",
  "Example notifications; delivery is simulated in the demo.",
  ["Notification", "Schedule", "Scope", "Threading"],
  [
    ["Store summary", "09:00 IST · D−1", "Sample operations team", "Monthly"],
    ["Review summary", "19:00 IST", "Sample operations team", "Monthly"],
    [
      "Audit response",
      "On completion",
      "Sample store stakeholders",
      "Per audit",
    ],
  ],
  "Edit sample setting",
);
define(
  ["/settings/payout-disputes"],
  "master",
  "Example dispute windows, stages and evidence rules.",
  ["Rule", "Value", "Owner", "Evidence"],
  [
    ["Submission window", "5 days", "Sample associate", "Payment reference"],
    [
      "Initial review",
      "2 working days",
      "Sample operations lead",
      "Reason and production record",
    ],
    [
      "Final decision",
      "3 working days",
      "Sample finance lead",
      "Decision note",
    ],
  ],
  "Edit sample rule",
);
define(
  ["/report-bot/setup"],
  "master",
  "Illustrative reporting rules; no messaging account is connected.",
  ["Rule", "Format", "Destination", "State"],
  [
    [
      "Opening readiness",
      "Checklist message",
      "Sample shift group",
      "Simulation",
    ],
    [
      "Inbound reporting",
      "Units and receipt time",
      "Sample store group",
      "Simulation",
    ],
    [
      "Shift handover",
      "Summary and open actions",
      "Sample handover group",
      "Simulation",
    ],
  ],
  "Edit sample rule",
);
define(
  ["/access", "/users?section=roles"],
  "people",
  "Fictional roles and scope. These profiles do not exist in the live user directory.",
  ["Profile", "Designation", "Scope", "Access"],
  [
    [
      "Sample operations lead",
      "Area manager",
      "3 sample locations",
      "Review & approval",
    ],
    [
      "Sample store lead",
      "Store manager",
      "1 sample store",
      "Store operations",
    ],
    [
      "Sample shift lead",
      "Shift incharge",
      "1 sample store",
      "Checklists & handover",
    ],
  ],
  "Inspect sample access",
);

export function definitionFor(href: string): Definition | undefined {
  return definitions[href];
}
export function demoMenus(items: NavItem[]): DemoMenu[] {
  return items.flatMap((group) =>
    (group.children ?? [group])
      .filter((item) => item.href)
      .map((item) => {
        const definition = definitionFor(item.href!);
        if (!definition)
          throw new Error(`Demo sample missing for ${item.href}`);
        return {
          id: `${group.code}--${item.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          label: item.label,
          group: group.label,
          href: item.href!,
          definition,
        };
      }),
  );
}
export const demoDate = "26 Oct 2026";
export const names = ["Alex Rao", "Maya Das", "Leena Shah", "Arjun Sen"];
export function demoLocations(workspace: Workspace) {
  return workspace === "q-commerce"
    ? ["QC01 · Cedar Park", "QC02 · Orchid Square", "QC03 · Maple Grove"]
    : ["LM01 · Harbour", "LM02 · Riverside", "LM03 · Lakeside"];
}
export type DemoRecord = {
  id: string;
  location: string;
  values: string[];
  status: string;
  notes: string;
  history: string[];
  tasks?: boolean[];
  proof?: boolean;
};
export function recordGroup(menu: DemoMenu) {
  if (menu.definition.kind === "payment") return "payments";
  if (
    ["checklist", "shift-report", "store-report"].includes(menu.definition.kind)
  )
    return menu.href.includes("store")
      ? "store-checklists"
      : "shift-checklists";
  return menu.id;
}
export function seedRecords(
  menu: DemoMenu,
  workspace: Workspace,
): DemoRecord[] {
  const locations = demoLocations(workspace),
    kind = menu.definition.kind;
  const checklist = ["checklist", "shift-report", "store-report"].includes(
    kind,
  );
  let examples = menu.definition.examples;
  if (menu.href === "/store-ops?view=start")
    examples = [
      ["Daily store report", "Alex Rao", "26 Oct 2026", "6 / 8"],
      ["Daily store report", "Maya Das", "26 Oct 2026", "8 / 8"],
      ["Daily store report", "Leena Shah", "26 Oct 2026", "5 / 8"],
    ];
  return examples.map((values, i) => ({
    id: `SAMPLE-${recordGroup(menu)}-${i + 1}`,
    location: locations[i % locations.length],
    values: [...values],
    status: checklist
      ? i === 1
        ? "Accepted"
        : "In progress"
      : kind === "payment"
        ? ["Pending approval", "Approved", "Paid", "Returned"][i % 4]
        : kind === "review"
          ? ["Open", "In progress", "Resolved"][i % 3]
          : kind === "audit"
            ? ["Awaiting response", "Closed", "Scheduled"][i % 3]
            : kind === "cod"
              ? i === 1
                ? "Variance"
                : "Reconciled"
              : kind === "loss"
                ? ["Recovery pending", "Under review", "Non-recoverable"][i % 3]
                : ["Active", "Complete", "Needs review", "Active"][i % 4],
    notes:
      kind === "payment"
        ? i === 0
          ? "Additional support for the planned afternoon volume. Sample request with supporting evidence."
          : i === 3
            ? "Returned: explain the consumable quantity and attach the sample bill."
            : "Sample expense linked to operational activity."
        : kind === "audit"
          ? "One finding: label the emergency equipment rack. Owner assigned; response due within 24 hours."
          : "Illustrative record for this product walkthrough. All names, identifiers and values are fictional.",
    history: [
      "26 Oct · 08:15 — Sample record created",
      "26 Oct · 09:10 — Reviewed by sample operations lead",
    ],
    ...(checklist
      ? {
          tasks: Array.from(
            { length: 8 },
            (_, n) => n < (i === 1 ? 8 : i === 0 ? 6 : 5),
          ),
        }
      : {}),
  }));
}
export const checklistTasks = [
  "Attendance and opening readiness recorded",
  "Safety exits and equipment checked",
  "Facility, power and water checked",
  "Temperature readings reviewed",
  "Inbound / inventory reconciled",
  "Quality and housekeeping completed",
  "Open issues assigned to an owner",
  "Handover summary prepared",
];
export function demoLink(workspace: Workspace, screen?: string) {
  return `/demo/${workspace === "last-mile" ? "last-mile" : "dark-store"}${screen ? `?screen=${encodeURIComponent(screen)}` : ""}`;
}
export function csvText(columns: string[], rows: string[][]) {
  const quote = (s: string) =>
    `"${(/^[=+\-@\t\r]/.test(s) ? "'" : "") + s.replaceAll('"', '""')}"`;
  return [columns, ...rows].map((row) => row.map(quote).join(",")).join("\r\n");
}
