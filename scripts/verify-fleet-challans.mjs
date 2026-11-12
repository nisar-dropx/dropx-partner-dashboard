import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const company = "11111111-1111-1111-1111-111111111111";
const user = "22222222-2222-2222-2222-222222222222";
const ownVehicle = "33333333-3333-3333-3333-333333333333";
const rentedVehicle = "44444444-4444-4444-4444-444444444444";

const db = new PGlite();
await db.exec(`
create role anon;
create role authenticated;
create role service_role;
create table companies(id uuid primary key);
create table profiles(id uuid primary key);
create table fleet_vehicles(
  id uuid primary key,
  company_id uuid not null references companies(id),
  vehicle_no text not null,
  station_code text not null,
  ownership_type text
);
create table nl_loss_month_cases(
  company_id uuid not null,
  report text not null,
  month text not null,
  case_key text not null,
  station_code text,
  amount numeric,
  source_status text,
  details jsonb,
  source_present boolean,
  source_file text,
  last_seen_at timestamptz default now(),
  unique(company_id, month, case_key)
);
insert into companies(id) values('${company}');
insert into profiles(id) values('${user}');
insert into fleet_vehicles(id,company_id,vehicle_no,station_code,ownership_type) values
 ('${ownVehicle}','${company}','KL11BZ0701','CLT01','own'),
 ('${rentedVehicle}','${company}','KL11RENTED1','CLT01','rented');
create or replace function gen_random_uuid() returns uuid language sql as $$ select md5(random()::text || clock_timestamp()::text)::uuid $$;
`);

const sql = fs
  .readFileSync("supabase/migrations/20261112140000_fleet_challans.sql", "utf8")
  .replace(/notify pgrst,\s*'reload schema';/gi, "select 1;");
await db.exec(sql);
await db.exec(sql);

const created = await db.query(`select * from fleet_challan_upsert_v1($1::uuid,$2::uuid,$3::jsonb)`, [
  company,
  user,
  {
    vehicleNo: "KL11BZ0701",
    challanNumber: "KL-TEST-1001",
    amount: 500,
    offenseDate: "2026-11-10",
    offenseDescription: "Signal jump",
    issuingAuthority: "mvd",
    actorName: "Verifier"
  }
]);
assert.equal(created.rows[0].status, "pending_review");
assert.equal(Number(created.rows[0].amount), 500);

await assert.rejects(
  () =>
    db.query(`select * from fleet_challan_upsert_v1($1::uuid,$2::uuid,$3::jsonb)`, [
      company,
      user,
      { vehicleNo: "KL11RENTED1", challanNumber: "KL-TEST-1002", amount: 100 }
    ]),
  /DropX-owned/
);

const refreshed = await db.query(`select * from fleet_challan_upsert_v1($1::uuid,$2::uuid,$3::jsonb)`, [
  company,
  user,
  {
    vehicleNo: "KL11BZ0701",
    challanNumber: "KL-TEST-1001",
    amount: 750,
    portalStatus: "paid",
    actorName: "Verifier"
  }
]);
assert.equal(Number(refreshed.rows[0].amount), 750);
assert.equal(refreshed.rows[0].status, "disposed");

const reopen = await db.query(`select * from fleet_challan_upsert_v1($1::uuid,$2::uuid,$3::jsonb)`, [
  company,
  user,
  {
    vehicleNo: "KL11BZ0701",
    challanNumber: "KL-TEST-2002",
    amount: 1200,
    offenseDate: "2026-11-11",
    offenseDescription: "Over speed",
    actorName: "Verifier"
  }
]);
const recovery = await db.query(`select * from fleet_challan_open_recovery_v1($1::uuid,$2::uuid,$3::uuid,$4,$5)`, [
  company,
  reopen.rows[0].id,
  user,
  "Verifier",
  "Recover from station UTR"
]);
assert.equal(recovery.rows[0].status, "approved_for_recovery");
assert.equal(recovery.rows[0].recovery_case_key, "challan:KL-TEST-2002");
const loss = await db.query(`select amount,report,source_status,details->>'vehicle_no' as vehicle from nl_loss_month_cases where case_key=$1`, [
  "challan:KL-TEST-2002"
]);
assert.equal(loss.rows[0].report, "station");
assert.equal(loss.rows[0].source_status, "Approved");
assert.equal(Number(loss.rows[0].amount), 1200);
assert.equal(loss.rows[0].vehicle, "KL11BZ0701");

await assert.rejects(
  () =>
    db.query(`select * from fleet_challan_open_recovery_v1($1::uuid,$2::uuid,$3::uuid,$4,$5)`, [
      company,
      refreshed.rows[0].id,
      user,
      "Verifier",
      null
    ]),
  /disposed|recovery cannot/
);

const source = fs.readFileSync("src/components/fleet-control-dashboard.tsx", "utf8");
assert.match(source, /challans/);
assert.match(source, /FleetChallansWorkspace/);
assert.match(fs.readFileSync("vercel.json", "utf8"), /fleet-challans/);
assert.match(fs.readFileSync("src/app/api/cron/fleet-challans/route.ts", "utf8"), /FLEET_CHALLAN_PORTAL_SYNC_ENABLED/);
assert.match(fs.readFileSync("src/lib/fleet/challan-drive.ts", "utf8"), /FLEET_CHALLAN_DRIVE_FOLDER_ID/);

await db.close();
console.log("Fleet challans verified: schema idempotent, owned-only upsert, status dispose, NL recovery bridge, UI/cron wiring.");
