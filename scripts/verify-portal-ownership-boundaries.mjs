import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const checks = [
  {
    file: "src/lib/app-navigation.ts",
    required: [
      'label: "Platform Control"',
      'label: "People"',
      'label: "All People", href: "/people/all"',
      'label: "Under Review", href: "/people/review"',
      'label: "Exception", href: "/people/exceptions"',
      'label: "Workforce Lifecycle", href: "/people/workforce-lifecycle"',
      'label: "Attendance Integrity", href: "/attendance/integrity"',
      'label: "Platform & Access Owners", href: "/master/platform-access-owners"',
      'label: "Locations & Station Mail", href: "/master/location"',
      'label: "Google Mail IDs & Mapping", href: "/settings/google-workspace"'
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
    file: "src/app/dashboard-people/all/page.tsx",
    required: [
      'title="All People"',
      'table: "employees"',
      'table: "contractors"',
      'table: "vendors"',
      'table: "workers"',
      "dynamicWorkforceTable",
      '.from("workforce")',
      'category: "Workforce"'
    ],
    forbidden: ['title="All Employees"']
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
    required: ["RESTORED_DASHBOARD_PEOPLE_PATHS", "isRestoredDashboardPeoplePath", "MOVED_PEOPLE_WORKFORCE_PATHS", "MOVED_PEOPLE_OPS_PATHS", "MOVED_OPS_WORKFORCE_PATHS", 'rewriteUrl.pathname = "/dashboard-people/all"'],
    forbidden: []
  },
  {
    file: "src/app/master/platform-access-owners/page.tsx",
    required: ["requireCompanyId(authorization)", "Company:", 'className="form-grid two"'],
    forbidden: ['name="company_id"', "Select company"]
  },
  {
    file: "src/app/master/location/page.tsx",
    required: [
      'title="Locations"',
      'Location Google Mail ID',
      'People owns manager scope, cluster responsibility and escalation assignments.'
    ],
    forbidden: [
      'name="station_manager_email"',
      'name="cluster_manager_email"',
      'name="ops_manager_email"',
      'name="ops_program_manager_email"'
    ]
  },
  {
    file: "src/lib/ops-pulse/location-mail.ts",
    required: ['station_email: email', 'Never overwrite an existing different address.'],
    forbidden: []
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
