import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const checks = [
  {
    file: "src/lib/app-navigation.ts",
    required: [
      'label: "People"',
      'label: "All People", href: "/people/all"',
      'label: "Under Review", href: "/people/review"',
      'label: "Exception", href: "/people/exceptions"',
      'label: "Workforce Lifecycle", href: "/people/workforce-lifecycle"',
      'label: "Attendance Integrity", href: "/attendance/integrity"'
    ],
    forbidden: []
  },
  {
    file: "src/lib/people/navigation.ts",
    required: ['label: "All Employees"', 'label: "HR Designations"'],
    forbidden: ["Independent Contractors", "Field Executives", "Workforce Lifecycle", "Business Docs", "master_documents"]
  },
  {
    file: "src/app/people/all/page.tsx",
    required: ['table: "employees"', 'people_module', 'title="All Employees"'],
    forbidden: ['table: "contractors"', 'table: "field_executives"', "dynamicWorkforceTable"]
  },
  {
    file: "src/app/people/review/page.tsx",
    required: ['queryProfileTypes: WorkforceProfileType[] = ["employee"]'],
    forbidden: ["nonEmployeeProfileConfigs", "nonEmployeeTypes.map"]
  },
  {
    file: "src/app/people/exceptions/page.tsx",
    required: ['table: "employees", profileType: "employee"'],
    forbidden: ['table: "contractors"', 'table: "field_executives"', 'table: "vendors"', 'table: "workers"']
  },
  {
    file: "src/lib/ops-pulse/navigation.ts",
    required: ['label: "Business Docs"', 'label: "Document Master"'],
    forbidden: ["Work Force Register", 'href: "/work-force-register"']
  },
  {
    file: "src/lib/product-ownership.ts",
    required: ['"business_documents", "master_documents"'],
    forbidden: ['"business_documents", "biometric_devices", "master_documents"']
  },
  {
    file: "src/middleware.ts",
    required: ["RESTORED_DASHBOARD_PEOPLE_PATHS", "isRestoredDashboardPeoplePath", "MOVED_PEOPLE_WORKFORCE_PATHS", "MOVED_PEOPLE_OPS_PATHS", "MOVED_OPS_WORKFORCE_PATHS"],
    forbidden: []
  },
  {
    file: "src/app/master/platform-access-owners/page.tsx",
    required: ["requireCompanyId(authorization)", "Company:", 'className="form-grid two"'],
    forbidden: ['name="company_id"', "Select company"]
  }
];

const violations = [];
for (const check of checks) {
  const source = read(check.file);
  for (const text of check.required) if (!source.includes(text)) violations.push(`${check.file}: missing ${text}`);
  for (const text of check.forbidden) if (source.includes(text)) violations.push(`${check.file}: forbidden ${text}`);
}

if (violations.length) {
  console.error("Portal ownership boundary verification failed:\n" + violations.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`Portal ownership boundaries verified across ${checks.length} runtime files.`);
