import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const db = new PGlite();
const schema = JSON.parse(
  readFileSync("scripts/fixtures/worked-id-schema.json", "utf8"),
);
await db.exec(
  "create role service_role bypassrls;create role anon;create role authenticated;",
);
for (const table of new Set(schema.map((c) => c.table_name))) {
  const fields = schema
    .filter((c) => c.table_name === table)
    .map((c) => {
      let t = c.udt_name;
      if (t.startsWith("_")) t = t.slice(1) + "[]";
      if (
        ![
          "uuid",
          "text",
          "date",
          "timestamp",
          "timestamptz",
          "time",
          "timetz",
          "bool",
          "int2",
          "int4",
          "int8",
          "numeric",
          "float4",
          "float8",
          "jsonb",
          "json",
          "uuid[]",
          "text[]",
          "int4[]",
        ].includes(t)
      )
        t = "text";
      return `"${c.column_name}" ${t}${c.column_name === "id" ? " primary key" : ""}`;
    });
  await db.exec(`create table public.${table}(${fields});`);
}
await db.exec(`create function public.lock_workforce_payment_allocation_company(uuid) returns void language sql as 'select pg_advisory_xact_lock(1)';
create function public.workforce_bump_payout_period_dependency_revision(uuid,date) returns void language sql as 'select null::void';
create function public.enqueue_workforce_payout_dependency_refresh(uuid,uuid,uuid,date,date,uuid) returns void language sql as 'select null::void';`);
const migration = readFileSync(
  "supabase/migrations/20261107055448_workforce_worked_id_review.sql",
  "utf8",
);
await db.exec(migration);
await db.exec(migration);
await db.exec(`create table workforce_payout_publications(id uuid primary key,company_id uuid,workforce_id uuid,station_id uuid,period_start date,period_end date,publication_kind text);
create table queued_worked_refresh(company_id uuid,workforce_id uuid,station_id uuid,period_start date,period_end date);
create or replace function public.enqueue_workforce_payout_dependency_refresh(uuid,uuid,uuid,date,date,uuid) returns void language sql as 'insert into public.queued_worked_refresh values($1,$2,$3,$4,$5)';`);
const monthMigration=readFileSync('supabase/migrations/20261107063633_worked_id_month_refresh_guards.sql','utf8');
await db.exec(monthMigration);await db.exec(monthMigration);
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const company = id(1),
  station = id(2),
  worker = id(3),
  owner = id(4),
  third = id(5),
  actor = id(6),
  source = id(7),
  provider = id(8),
  method = id(9),
  date = "2026-10-15";
await db.query("insert into companies(id) values($1)", [company]);
await db.query(
  "insert into stations(id,company_id,station_code) values($1,$2,$3)",
  [station, company, "TEST"],
);
for (const [w, name] of [
  [worker, "Borrower"],
  [owner, "Owner"],
  [third, "Borrower two"],
]) {
  await db.query(
    "insert into workforce(id,company_id,full_name,date_of_join) values($1,$2,$3,$4)",
    [w, company, name, "2026-10-01"],
  );
  await db.query(
    "insert into attendance_punches(id,company_id,account_id,location_id,punch_date,source) values($1,$2,$3,$4,$5,'biometric')",
    [id(30 + Number(w.slice(-2))), company, w, station, date],
  );
  await db.query(
    "insert into attendance_daily(id,company_id,workforce_id,location_id,punch_date,status,work_minutes,in_time) values($1,$2,$3,$4,$5,'P',480,'2026-10-15 03:30+00')",
    [id(50 + Number(w.slice(-2))), company, w, station, date],
  );
}
await db.query(
  "insert into providers(id,company_id,code,name) values($1,$2,'AMAZON','Amazon')",
  [provider, company],
);
await db.query(
  "insert into payment_method_components(id,company_id,payment_method_id,component_type,pay_schedule,is_active) values($1,$2,$3,'amount','per_day',true)",
  [id(10), company, method],
);
for (const [w, member] of [
  [worker, "BORROWER"],
  [owner, "OWNER"],
  [third, "THIRD"],
])
  await db.query(
    "insert into field_executive_provider_mappings(id,company_id,workforce_id,station_id,provider_id,provider_member_id,payment_method_id,effective_from,status) values($1,$2,$3,$4,$5,$6,$7,'2026-10-01','active')",
    [
      id(70 + Number(w.slice(-2))),
      company,
      w,
      station,
      provider,
      member,
      method,
    ],
  );
await db.query(
  "insert into cps_shipment_daily(id,company_id,station_code,client,work_date,provider_employee_id,total_delivery,amazon_delivery,delivery_assigned_count) values($1,$2,'TEST','Amazon',$3,'OWNER',100,100,120)",
  [source, company, date],
);
const counts = {
  total_delivery: 100,
  amazon_delivery: 100,
  swa_delivery: 0,
  c_return: 0,
  mfn: 0,
  mfn_return: 0,
  assigned_count: 0,
  delivery_assigned_count: 120,
  pickup_assigned_count: 0,
};
const share = (n, assigned, ownerWorked = true) => ({
  source_shipment_id: source,
  source_counts: counts,
  owner_worked: ownerWorked,
  quantities: {
    ...counts,
    total_delivery: n,
    amazon_delivery: n,
    delivery_assigned_count: assigned,
  },
});
const save = (who, decision, version, shares = [], location = station) =>
  db.query(
    "select save_workforce_worked_id_review($1,$2,$3,$4,$5,$6,$7,$8,$9) result",
    [
      company,
      actor,
      who,
      location,
      date,
      decision,
      "Confirmed with station",
      version,
      JSON.stringify(shares),
    ],
  );
await save(worker, "worked", 0, [share(40, 48)]);
await assert.rejects(
  db.query("update cps_shipment_daily set total_delivery=101 where id=$1", [
    source,
  ]),
  /Reopen/,
);
await assert.rejects(
  db.query(
    "update field_executive_provider_mappings set provider_member_id='CHANGED' where workforce_id=$1",
    [owner],
  ),
  /Reopen/,
);
await assert.rejects(
  db.query(
    "insert into workforce_custom_production_inputs(id,company_id,workforce_id,work_date) values($1,$2,$3,$4)",
    [id(120), company, owner, date],
  ),
  /conflicts/,
);
let facts = (
  await db.query(
    "select provider_employee_id,total_delivery,delivery_assigned_count from workforce_payout_shipment_facts order by provider_employee_id",
  )
).rows;
assert.deepEqual(
  facts.map((r) => [
    r.provider_employee_id,
    Number(r.total_delivery),
    Number(r.delivery_assigned_count),
  ]),
  [
    ["BORROWER", 40, 48],
    ["OWNER", 60, 72],
  ],
);
await assert.rejects(
  save(worker, "worked", 0, [share(40, 48)]),
  /Another reviewer/,
);
await assert.rejects(save(third, "worked", 0, [share(70, 72)]), /exceeds/);
await save(third, "worked", 0, [share(20, 24)]);
assert.equal(
  Number(
    (
      await db.query(
        "select sum(total_delivery) n from workforce_payout_shipment_facts",
      )
    ).rows[0].n,
  ),
  100,
);
await assert.rejects(
  save(worker, "worked", 1, [share(80, 96, false)]),
  /different owner/,
);
await save(third, "reopened", 1);
await save(worker, "worked", 1, [share(100, 120, false)]);
assert.equal(
  Number(
    (
      await db.query(
        "select total_delivery from workforce_payout_shipment_facts where provider_employee_id='OWNER'",
      )
    ).rows[0].total_delivery,
  ),
  0,
);
await save(worker, "not_worked", 2);
let attendance = (
  await db.query(
    "select status,work_minutes,in_time from workforce_payout_attendance_facts where workforce_id=$1",
    [worker],
  )
).rows[0];
assert.equal(attendance.status, "A");
assert.equal(attendance.work_minutes, 0);
assert.equal(attendance.in_time, null);
assert.equal(
  (
    await db.query(
      "select status from attendance_daily where workforce_id=$1",
      [worker],
    )
  ).rows[0].status,
  "P",
);
await assert.rejects(
  db.query(
    "insert into workforce_payout_attendance_overrides(id,company_id,workforce_id,work_date) values($1,$2,$3,$4)",
    [id(121), company, worker, date],
  ),
  /conflicts/,
);
await assert.rejects(
  db.query(
    "insert into workforce_payout_attendance_values(id,company_id,workforce_id,effective_from,effective_to) values($1,$2,$3,'2026-10-01','2026-10-31')",
    [id(122), company, worker],
  ),
  /conflicts/,
);
await save(worker, "reopened", 3);
await assert.rejects(save(owner, "not_worked", 0), /Deliveries already exist/);
await assert.rejects(
  save(worker, "worked", 4, [{ ...share(30, 36), owner_worked: null }]),
  /Confirm whether/,
);
await db.query(
  "insert into workforce_payout_payment_items(id,company_id,workforce_id,period_start,period_end,status) values($1,$2,$3,'2026-10-01','2026-10-31','processing')",
  [id(100), company, owner],
);
await assert.rejects(save(worker, "worked", 4, [share(30, 36)]), /bank-processing/);
await db.query("delete from workforce_payout_payment_items where id=$1", [
  id(100),
]);
// An early-day correction must also protect later paid sub-periods.
await db.query("insert into workforce_payout_payment_items(id,company_id,workforce_id,period_start,period_end,status) values($1,$2,$3,'2026-10-20','2026-10-31','processing')",[id(102),company,owner]);
await assert.rejects(save(worker,'worked',4,[share(30,36)]),/bank-processing/);
await db.query('delete from workforce_payout_payment_items where id=$1',[id(102)]);
for(const location of [station,id(103)])await db.query("insert into workforce_payout_publications(id,company_id,workforce_id,station_id,period_start,period_end,publication_kind) values(gen_random_uuid(),$1,$2,$3,'2026-10-20','2026-10-31','worksheet')",[company,worker,location]);
await db.query('select refresh_worked_id_month($1,$2,$3,$4)',[company,worker,date,actor]);
const queued=(await db.query('select period_start::text,period_end::text from queued_worked_refresh')).rows;
assert.equal(queued.length,2);assert.ok(queued.every(r=>r.period_start==='2026-10-01'&&r.period_end==='2026-10-31'));
await db.query(
  "insert into workforce_payout_attendance_values(id,company_id,workforce_id,effective_from,effective_to) values($1,$2,$3,'2026-10-01','2026-10-31')",
  [id(101), company, worker],
);
await assert.rejects(save(worker, "not_worked", 4), /imported attendance/);
assert.equal(
  (
    await db.query(
      "select has_function_privilege('authenticated','public.save_workforce_worked_id_review(uuid,uuid,uuid,uuid,date,text,text,integer,jsonb)','execute') ok",
    )
  ).rows[0].ok,
  false,
);
assert.equal(
  (await db.query("select count(*) n from workforce_worked_id_events")).rows[0]
    .n,
  6,
);
console.log(
  "Worked ID migration applied twice; conservation, shared work, version conflicts, reopen, attendance exclusion, paid locks and access checks passed.",
);
const {testExpandedWorkedReview}=await import('./test-worked-id-expanded.mjs');
await testExpandedWorkedReview(db,{id,company,station,worker,owner,third,actor,source,method,date,share});
const {testDailyIdUsage}=await import('./test-daily-id-usage.mjs');
await testDailyIdUsage(db,{id,company,station,actor,provider});
await db.close();
