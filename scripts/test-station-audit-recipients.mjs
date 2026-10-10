import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const company = id(1),
  station = id(2),
  role = id(3),
  page = id(4);
const person = (n, extra = {}) => ({
  id: id(n),
  company_id: company,
  full_name: `User ${n}`,
  email: `user${n}@example.test`,
  is_active: true,
  ...extra,
});
const tables = {
  profiles: [
    person(10, { is_master_owner: true }),
    person(11),
    person(12),
    person(13, { is_active: false }),
    person(14, { company_id: id(999) }),
    person(15),
    person(16),
    person(17),
  ],
  company_product_memberships: [11, 12, 13, 14, 15, 16, 17].map((n) => ({
    company_id: n === 14 ? id(999) : company,
    user_id: id(n),
    role_id: n === 17 ? id(99) : role,
    location_scope_ids: [n === 12 ? id(888) : station],
    has_all_location_access: n === 15,
    is_active: n !== 16,
    product_code: "operations",
  })),
  user_roles: [
    {
      id: role,
      company_id: company,
      code: "AUDITOR",
      location_access_mode: "role_based",
      is_active: true,
    },
    { id: id(99), company_id: company, code: "NO_ACCESS", is_active: true },
  ],
  app_pages: [
    { id: page, company_id: company, code: "station_audits", is_active: true },
  ],
  role_page_permissions: [
    { role_id: role, page_id: page, company_id: company, can_view: true },
  ],
  hr_user_person_links: [
    {
      person_id: id(21),
      user_id: id(11),
      company_id: company,
      status: "active",
    },
    {
      person_id: id(22),
      user_id: id(12),
      company_id: company,
      status: "active",
    },
    {
      person_id: id(23),
      user_id: id(13),
      company_id: company,
      status: "active",
    },
  ],
};
let failure = "",
  hierarchyFailure = "";
const db = {
  from(table) {
    let rows = tables[table] || [];
    const q = {
      select() {
        return q;
      },
      eq(k, v) {
        rows = rows.filter((r) => r[k] === v);
        return q;
      },
      in(k, v) {
        rows = rows.filter((r) => v.includes(r[k]));
        return q;
      },
      order(k) {
        assert.ok(
          rows.length === 0 || k in rows[0],
          `${table}.${k} does not exist`,
        );
        return q;
      },
      range(a, b) {
        rows = rows.slice(a, b + 1);
        return q;
      },
      then(resolve) {
        return Promise.resolve({
          data: rows,
          error: failure === table ? { message: "DB unavailable" } : null,
        }).then(resolve);
      },
    };
    return q;
  },
};
const mocks = {
  "server-only": {},
  "@/lib/supabase-admin": { supabaseAdmin: db },
  "./station-audit-query": { allAuditRows: (query) => query(0, 499) },
  "@/lib/people-operational-hierarchy": {
    loadPeopleOperationalHierarchy: async (c, s, options) => {
      assert.equal(c, company);
      assert.deepEqual(s, [station]);
      assert.equal(options.includeStationResponsibilities, true);
      return {
        error: hierarchyFailure,
        byLocation: new Map([
          [
            station,
            {
              clusterManagers: [
                { personId: id(21) },
                { personId: id(22) },
                { personId: id(23) },
              ],
              primaryReportingChain: [{ personId: id(21) }],
            },
          ],
        ]),
      };
    },
  },
};
const m = { exports: {} };
new Function(
  "require",
  "module",
  "exports",
  ts.transpileModule(
    fs.readFileSync("src/lib/ops-pulse/station-audit-recipients.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
)(
  (key) => {
    assert.ok(key in mocks, key);
    return mocks[key];
  },
  m,
  m.exports,
);
const {
  validAuditRecipientRule,
  loadAuditNotificationUsers,
  resolveStationAuditRecipients,
} = m.exports;
assert.equal(validAuditRecipientRule("arbitrary@example.test"), false);
assert.equal(validAuditRecipientRule(`user:${id(11)}`), true);
assert.equal(validAuditRecipientRule("people_reporting_chain"), true);
assert.deepEqual(
  (await loadAuditNotificationUsers(company)).map((u) => u.id),
  [10, 11, 12, 15].map(id),
);
const st = {
  id: station,
  station_email: "Station@example.test",
  cluster_manager_email: "outdated@example.test",
};
assert.deepEqual(
  await resolveStationAuditRecipients(
    company,
    st,
    ["station_email"],
    [
      "people_reporting_chain",
      "company_owners",
      `user:${id(11)}`,
      `user:${id(12)}`,
      `user:${id(13)}`,
      `user:${id(14)}`,
      `user:${id(15)}`,
    ],
  ),
  {
    to: ["station@example.test"],
    cc: ["user11@example.test", "user10@example.test", "user15@example.test"],
  },
);
assert.deepEqual(
  await resolveStationAuditRecipients(
    company,
    st,
    [`user:${id(11)}`],
    ["cluster_manager_email", `role:${role}`],
  ),
  { to: ["user11@example.test"], cc: ["user15@example.test"] },
);
failure = "role_page_permissions";
await assert.rejects(loadAuditNotificationUsers(company), /DB unavailable/);
failure = "";
hierarchyFailure = "People unavailable";
await assert.rejects(
  resolveStationAuditRecipients(
    company,
    st,
    ["station_email"],
    ["people_reporting_chain"],
  ),
  /could not be verified/,
);
console.log(
  "Audit recipient tests passed: active tenants, audit permissions, station scope, current People chain, named stakeholders, roles, deduplication and fail-closed lookups.",
);
