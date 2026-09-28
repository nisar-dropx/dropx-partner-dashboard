import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const migrationPath = new URL("../supabase/migrations/20260928105000_workforce_payment_policy_history.sql", import.meta.url);
const scriptPath = new URL("./workforce_payment_policy_history_v1.sql", import.meta.url);
const migration = await readFile(migrationPath, "utf8");
const script = await readFile(scriptPath, "utf8");
const digest = (value) => createHash("sha256").update(value.replace(/\r\n/g, "\n")).digest("hex");
assert.equal(digest(script), digest(migration), "deploy script must exactly match the migration");

const db = new PGlite({ extensions: { btree_gist } });
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.companies(id uuid primary key);
  create table public.stations(id uuid primary key,company_id uuid not null,station_code text not null);
  create table public.designations(
    id uuid primary key,company_id uuid not null,code text not null,name text not null,
    is_active boolean not null,is_field_operations boolean not null,provider_mapping_required boolean not null
  );
  create table public.workforce(
    id uuid primary key,company_id uuid not null,location_id uuid,designation_id uuid,designation text
  );
  create unique index workforce_company_id_id_uidx on public.workforce(company_id,id);
  create unique index stations_company_id_id_uidx on public.stations(company_id,id);
  create unique index designations_company_id_id_uidx on public.designations(company_id,id);
`);

const company = "00000000-0000-0000-0000-000000000001";
const worker = "00000000-0000-0000-0000-000000000010";
const secondWorker = "00000000-0000-0000-0000-000000000011";
const optional = "00000000-0000-0000-0000-000000000020";
const required = "00000000-0000-0000-0000-000000000021";
const nonField = "00000000-0000-0000-0000-000000000022";
const stationA = "00000000-0000-0000-0000-000000000030";
const stationB = "00000000-0000-0000-0000-000000000031";
await db.exec(`
  insert into public.companies values ('${company}');
  insert into public.stations values
    ('${stationA}','${company}','A'),
    ('${stationB}','${company}','B');
  insert into public.designations values
    ('${optional}','${company}','VAN','Van driver',true,true,false),
    ('${required}','${company}','DA','Delivery associate',true,true,true),
    ('${nonField}','${company}','OFFICE','Office',true,false,false);
  insert into public.workforce values ('${worker}','${company}','${stationA}','${optional}',null);
`);

await db.exec(migration.replace("create extension if not exists pgcrypto;", ""));
const captureFunction = migration.slice(
  migration.indexOf("create or replace function public.capture_workforce_payment_policy("),
  migration.indexOf("revoke all on function public.capture_workforce_payment_policy(")
);
assert.ok(
  captureFunction.indexOf("for update;") < captureFunction.indexOf("perform pg_advisory_xact_lock"),
  "policy capture must lock the Workforce row before taking its advisory lock"
);
const todayResult = await db.query("select (now() at time zone 'Asia/Kolkata')::date::text today");
const today = todayResult.rows[0].today;
const plusDays = async (days) => (await db.query(`select ('${today}'::date+${days})::text calculated_day`)).rows[0].calculated_day;
const tomorrow = await plusDays(1);
const dayAfter = await plusDays(2);
const dateText = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value);

let history = (await db.query(`select * from public.workforce_payment_policy_history where workforce_id='${worker}' order by effective_from`)).rows;
assert.equal(history.length, 1);
assert.equal(dateText(history[0].effective_from), today);
assert.equal(history[0].effective_to, null);
assert.equal(history[0].station_id, stationA);
assert.equal(history[0].station_code_snapshot, "A");
assert.equal(history[0].designation_is_active, true);
assert.equal(history[0].is_field_operations, true);
assert.equal(history[0].provider_mapping_required, false);
assert.equal(history[0].change_source, "migration_backfill");

await db.query(`select public.capture_workforce_payment_policy('${worker}','${tomorrow}','${required}','test_required')`);
await db.query(`select public.capture_workforce_payment_policy('${worker}','${dayAfter}','${nonField}','test_non_field')`);
history = (await db.query(`select effective_from::text,effective_to::text,is_field_operations,provider_mapping_required from public.workforce_payment_policy_history where workforce_id='${worker}' order by effective_from`)).rows;
assert.deepEqual(history, [
  { effective_from: today, effective_to: today, is_field_operations: true, provider_mapping_required: false },
  { effective_from: tomorrow, effective_to: tomorrow, is_field_operations: true, provider_mapping_required: true },
  { effective_from: dayAfter, effective_to: null, is_field_operations: false, provider_mapping_required: false },
]);

await db.exec(`insert into public.workforce values ('${secondWorker}','${company}','${stationA}','${optional}',null)`);
history = (await db.query(`select * from public.workforce_payment_policy_history where workforce_id='${secondWorker}'`)).rows;
assert.equal(history.length, 1, "new Workforce rows must get a same-day truthful policy snapshot");
assert.equal(history[0].provider_mapping_required, false);

await db.exec(`update public.workforce set location_id='${stationB}' where id='${secondWorker}'`);
history = (await db.query(`select * from public.workforce_payment_policy_history where workforce_id='${secondWorker}'`)).rows;
assert.equal(history.length, 1, "same-day location changes must replace, not overlap, the day's snapshot");
assert.equal(history[0].station_id, stationB);
assert.equal(history[0].station_code_snapshot, "B");
assert.equal(history[0].change_source, "workforce_assignment_change");

await db.exec(`update public.workforce set designation_id='${required}' where id='${secondWorker}'`);
history = (await db.query(`select * from public.workforce_payment_policy_history where workforce_id='${secondWorker}'`)).rows;
assert.equal(history.length, 1, "same-day designation changes must replace, not overlap, the day's snapshot");
assert.equal(history[0].provider_mapping_required, true);

await db.exec(`update public.designations set provider_mapping_required=false where id='${required}'`);
history = (await db.query(`select * from public.workforce_payment_policy_history where workforce_id='${secondWorker}'`)).rows;
assert.equal(history.length, 1, "same-day master changes must replace, not overlap, the day's snapshot");
assert.equal(history[0].provider_mapping_required, false);
assert.equal(history[0].change_source, "designation_master_change");

await db.exec(`update public.designations set is_active=false where id='${required}'`);
history = (await db.query(`select * from public.workforce_payment_policy_history where workforce_id='${secondWorker}'`)).rows;
assert.equal(history.length, 1, "same-day deactivation must replace, not overlap, the day's snapshot");
assert.equal(history[0].designation_is_active, false);
assert.equal(history[0].is_field_operations, false, "inactive designations are not applicable Field Operations policy");
assert.equal(history[0].provider_mapping_required, false, "inactive designations cannot require provider mapping");

const beforeRerun = (await db.query("select count(*)::int count from public.workforce_payment_policy_history")).rows[0].count;
await db.exec(script.replace("create extension if not exists pgcrypto;", ""));
const afterRerun = (await db.query("select count(*)::int count from public.workforce_payment_policy_history")).rows[0].count;
assert.equal(afterRerun, beforeRerun, "rerunning the deploy script must not invent another same-day snapshot");

console.log(`workforce payment-policy history: PASS (${digest(migration)})`);
await db.close();
