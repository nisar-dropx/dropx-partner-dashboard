import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
const uid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [company, station, type, manager, auditor, role, audit, second] = [
  1, 2, 3, 4, 5, 6, 7, 8,
].map(uid);
await db.exec(`create role anon;create role authenticated;create role service_role;
 create table stations(id uuid primary key);
 create table profiles(id uuid primary key,company_id uuid,full_name text,email text,is_active boolean,is_master_owner boolean);
 create table user_roles(id uuid primary key,company_id uuid,code text,is_active boolean,location_access_mode text);
 create table company_product_memberships(company_id uuid,user_id uuid,role_id uuid,is_active boolean,product_code text,has_all_location_access boolean,location_scope_ids uuid[]);
 insert into stations values('${station}');
 insert into profiles values('${manager}','${company}','Leader','lead@example.test',true,false),('${auditor}','${company}','Auditor','auditor@example.test',true,false);
 insert into user_roles values('${role}','${company}','OPERATIONS_BH',true,'role_based');
 insert into company_product_memberships values('${company}','${manager}','${role}',true,'operations',false,array['${station}']::uuid[]);`);
const initial = fs.readFileSync(
  "supabase/migrations/20261001010000_ops_station_audits.sql",
  "utf8",
);
await db.exec(initial.slice(0, initial.indexOf("create index")));
await db.exec(
  `insert into ops_audit_types(id,company_id,code,name,cadence_unit,required_count,scheduling_config) values('${type}','${company}','physical_station','Physical','monthly',2,'{"period_slots":[{"code":"first_half","start_day":1,"end_day":15},{"code":"second_half","start_day":16,"end_day":31}]}');`,
);
await db.exec(
  fs.readFileSync(
    "supabase/migrations/20261005144751_station_audit_rescheduling.sql",
    "utf8",
  ),
);
await db.exec(
  fs.readFileSync(
    "supabase/migrations/20261005155255_station_audit_personal_tracker.sql",
    "utf8",
  ),
);
const insert = (id, date, slot) =>
  db.query(
    `insert into ops_station_audits(id,company_id,audit_number,audit_type_id,location_id,scheduled_for,cycle_key,period_slot,assigned_to,assigned_name,assignment_verified) values($1::uuid,$2,$1::text,$3,$4,$5,'2099-10',$6,$7,'Auditor',true)`,
    [id, company, type, station, date, slot, auditor],
  );
await assert.rejects(
  insert(audit, "2099-10-05T04:00Z", "second_half"),
  /within its configured window/,
);
await insert(audit, "2099-10-05T04:00Z", "first_half");
await assert.rejects(
  insert(second, "2099-10-08T04:00Z", "first_half"),
  /already has an audit/,
);
const row = async () =>
  (await db.query("select * from ops_station_audits where id=$1", [audit]))
    .rows[0];
const manage = async (op, actor = manager, changes = {}) => {
  const v = await row();
  return db.query(
    "select manage_station_audit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      company,
      audit,
      op,
      changes.updated || v.updated_at,
      changes.target || auditor,
      "Operational correction",
      actor,
      "Leader",
      "lead@example.test",
      "OPERATIONS_BH",
    ],
  );
};
await assert.rejects(manage("delete", auditor), /cannot delete/);
await assert.rejects(
  manage("delete", manager, { updated: "2000-01-01" }),
  /changed/,
);
await manage("reassign");
assert.equal((await row()).assignment_verified, true);
await assert.rejects(
  db.query(
    "select reschedule_station_audit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      company,
      audit,
      "2099-10-05T04:00Z",
      "2099-10-20T04:00Z",
      "2099-10",
      "second_half",
      "Moved",
      manager,
      "Leader",
      "lead@example.test",
      "OPERATIONS_BH",
    ],
  ),
  /original date window/,
);
await db.query(
  "update ops_station_audits set status_code='in_progress',started_at=now() where id=$1",
  [audit],
);
const submit = async (counts) =>
  db.query(
    "select submit_station_audit_report($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
    [
      company,
      audit,
      (await row()).updated_at,
      {
        status_code: "awaiting_station_response",
        station_response_status: "requested",
        system_cash_amount: 100,
        physical_cash_amount: 50,
        cash_variance_amount: -50,
      },
      [],
      counts,
      [],
      [
        {
          title: "Cash difference",
          corrective_action: "Explain shortage",
          status_code: "open",
        },
      ],
      [
        {
          media_url: "storage://test/proof",
          evidence_kind_code: "erp_screenshot",
        },
      ],
      auditor,
      "Auditor",
      "auditor@example.test",
      "OPERATIONS_CLM",
    ],
  );
await assert.rejects(
  submit([{ cash_side: "physical", denomination_value: 50, note_count: -1 }]),
  /check constraint/,
);
assert.equal(
  (await row()).completed_at,
  null,
  "failed report transaction does not mark complete",
);
await submit([
  { cash_side: "physical", denomination_value: 50, note_count: 1 },
]);
assert.ok((await row()).completed_at);
assert.equal(
  (await db.query("select computed_amount from ops_station_audit_cash_counts"))
    .rows[0].computed_amount,
  "50.00",
);
assert.equal(
  (await db.query("select count(*) n from ops_station_audit_evidence")).rows[0]
    .n,
  1,
);
await manage("delete");
assert.ok((await row()).deleted_at);
assert.equal(
  (await db.query("select count(*) n from ops_station_audit_evidence")).rows[0]
    .n,
  1,
  "deletion retains proof",
);
await insert(second, "2099-10-08T04:00Z", "first_half");
assert.equal(
  (
    await db.query(
      "select has_function_privilege('authenticated','public.manage_station_audit(uuid,uuid,text,timestamptz,uuid,text,uuid,text,text,text)','EXECUTE') allowed",
    )
  ).rows[0].allowed,
  false,
);
await db.close();
const mod = { exports: {} };
new Function(
  "require",
  "module",
  "exports",
  ts.transpileModule(
    fs.readFileSync("src/lib/ops-pulse/station-audit-people.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
)(() => ({}), mod, mod.exports);
const canDelete = mod.exports.canDeleteStationAudit;
for (const code of [
  "OPERATIONS_BH",
  "OPERATIONS_HLM",
  "OPERATIONS_SLPM",
  "OPERATIONS_NH",
])
  assert.equal(canDelete({ effectiveRoleCodes: [code] }), true);
for (const code of [
  "OPERATIONS_CLM",
  "OPERATIONS_AOM",
  "OPERATIONS_RM",
  "LOCATION",
  "FINANCE_NATIONAL_HEAD",
])
  assert.equal(canDelete({ effectiveRoleCodes: [code] }), false);
assert.equal(canDelete({ isMasterOwner: true, readOnly: true }), false);
console.log(
  "Audit tracker passed: role-restricted soft deletion, stale writes, retained evidence, date windows, duplicate slots, assignment and atomic report rollback.",
);
