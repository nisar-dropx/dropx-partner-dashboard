import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
const uid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [company, station, physical, cod, manager, auditor, other, bh, slp, exec] =
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(uid);
await db.exec(`create role anon;create role authenticated;create role service_role;
 create table stations(id uuid primary key);
 create table profiles(id uuid primary key,company_id uuid,full_name text,email text,is_active boolean,is_master_owner boolean);
 create table user_roles(id uuid primary key,company_id uuid,code text,name text,product_code text,is_active boolean,location_access_mode text);
 create table company_product_memberships(company_id uuid,user_id uuid,role_id uuid,is_active boolean,product_code text,has_all_location_access boolean,location_scope_ids uuid[]);
 insert into stations values('${station}');
 insert into profiles values('${manager}','${company}','Leader','lead@example.test',true,false),('${auditor}','${company}','Auditor','auditor@example.test',true,false),('${other}','${company}','Visitor','visitor@example.test',true,false);
 insert into user_roles values('${bh}','${company}','OPERATIONS_BH','Business Head','operations',true,'role_based'),('${slp}','${company}','OPERATIONS_SLPM','SLP Manager','operations',true,'role_based'),('${exec}','${company}','OPERATIONS_EXEC','Executive','operations',true,'role_based');`);
const initial = fs.readFileSync(
  "supabase/migrations/20261001010000_ops_station_audits.sql",
  "utf8",
);
await db.exec(initial.slice(0, initial.indexOf("create index")));
await db.exec(`insert into ops_audit_types(id,company_id,code,name,cadence_unit,required_count,default_response_hours,scheduling_config) values
 ('${physical}','${company}','physical_station','Physical audit','monthly',2,48,'{"period_slots":[{"code":"first_half","start_day":1,"end_day":15},{"code":"second_half","start_day":16,"end_day":31}]}'),
 ('${cod}','${company}','virtual_cod','COD audit','monthly',3,24,'{"period_slots":[{"code":"cod_1","start_day":1,"end_day":10},{"code":"cod_2","start_day":11,"end_day":20},{"code":"cod_3","start_day":21,"end_day":31}]}');`);
for (const name of [
  "20261005144751_station_audit_rescheduling.sql",
  "20261005155255_station_audit_personal_tracker.sql",
])
  await db.exec(fs.readFileSync(`supabase/migrations/${name}`, "utf8"));
await db.exec(`alter table ops_station_audit_evidence add column if not exists checklist_item_id uuid;
 create table ops_audit_programme_settings(company_id uuid primary key); insert into ops_audit_programme_settings values('${company}');`);
const migration = fs.readFileSync(
  "supabase/migrations/20261013090000_station_audit_unscheduled_cross.sql",
  "utf8",
);
await db.exec(migration);
// Applying it twice must be harmless.
await db.exec(migration);

const settings = (
  await db.query("select cross_audit_role_ids from ops_audit_programme_settings")
).rows[0];
assert.deepEqual(
  [...settings.cross_audit_role_ids].sort(),
  [bh, slp].sort(),
  "Business Head and SLP Manager are seeded as cross-audit roles; other roles are not",
);

let next = 100;
const insert = (date, slot, { type = physical, source = "manual" } = {}) => {
  const id = uid(next++);
  return db
    .query(
      `insert into ops_station_audits(id,company_id,audit_number,audit_type_id,location_id,scheduled_for,cycle_key,period_slot,schedule_source,assigned_to,assigned_name,assignment_verified) values($1::uuid,$2,$1::text,$3,$4,$5,'2099-10',$6,$7,$8,'Auditor',true)`,
      [id, company, type, station, date, slot, source, auditor],
    )
    .then(() => id);
};
const row = async (id) =>
  (await db.query("select * from ops_station_audits where id=$1", [id])).rows[0];

// Planned audits keep every window rule.
const planned = await insert("2099-10-05T04:00Z", "first_half");
await assert.rejects(insert("2099-10-08T04:00Z", "first_half"), /already has an audit/);
await assert.rejects(insert("2099-10-20T04:00Z", "first_half"), /within its configured window/);
await assert.rejects(insert("2099-10-20T04:00Z", "nonsense"), /valid audit window/);

// An unscheduled audit needs no window and does not collide with the planned one.
const surprise = await insert("2099-10-06T04:00Z", "unscheduled-aaaa1111", { source: "unscheduled" });
await insert("2099-10-06T05:00Z", "unscheduled-bbbb2222", { source: "unscheduled" });
// It never blocks a planned slot either.
await insert("2099-10-22T04:00Z", "unscheduled-cccc3333", { source: "unscheduled" });
const secondHalf = await insert("2099-10-25T04:00Z", "second_half");
assert.equal((await row(secondHalf)).period_slot, "second_half");
// Moving an unscheduled audit to another month is allowed; a planned one is not.
await db.query("update ops_station_audits set scheduled_for='2099-11-03T04:00Z',cycle_key='2099-11' where id=$1", [surprise]);
await assert.rejects(
  db.query("update ops_station_audits set scheduled_for='2099-11-03T04:00Z' where id=$1", [planned]),
  /same month|configured window/,
);

const change = async (id, changes = {}) => {
  const v = await row(id);
  const p = {
    stamp: v.updated_at,
    type: v.audit_type_id,
    cycle: v.cycle_key,
    slot: v.period_slot,
    source: v.schedule_source,
    to: v.assigned_to,
    cross: false,
    reason: "Did a different audit on site",
    ...changes,
  };
  return db.query(
    "select public.change_station_audit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Leader','lead@example.test','Business Head')",
    [company, id, p.stamp, p.type, p.cycle, p.slot, p.source, p.to, p.cross, p.reason, manager],
  );
};
await assert.rejects(change(planned), /different audit type or auditor/);
await assert.rejects(change(planned, { type: cod, slot: "cod_1", reason: " " }), /Enter a reason/);
await assert.rejects(change(planned, { type: cod, slot: "cod_1", stamp: "2000-01-01T00:00Z" }), /changed\. Refresh/);
await assert.rejects(change(planned, { type: uid(999), slot: "cod_1" }), /active audit type/);
await assert.rejects(change(planned, { type: cod, slot: "cod_1", source: "weird" }), /Invalid audit plan/);
await assert.rejects(change(planned, { to: uid(998) }), /active auditor/);

// A photo taken for the old checklist stays on the audit as general proof.
await db.query(
  `insert into ops_station_audit_evidence(company_id,audit_id,media_url,evidence_kind_code,checklist_item_id) values($1,$2,'storage://x','checklist_photo',$3)`,
  [company, planned, uid(500)],
);
// Planned Physical on 5 Oct becomes the planned COD for 1-10 Oct, which is free.
await change(planned, { type: cod, slot: "cod_1" });
let changed = await row(planned);
assert.equal(changed.audit_type_id, cod);
assert.equal(changed.period_slot, "cod_1");
assert.equal(changed.schedule_source, "manual");
assert.equal(
  new Date(changed.response_due_at).toISOString(),
  "2099-10-06T04:00:00.000Z",
  "the response deadline follows the new type",
);
const proof = (await db.query("select * from ops_station_audit_evidence where audit_id=$1", [planned])).rows[0];
assert.equal(proof.checklist_item_id, null);
assert.equal(proof.evidence_kind_code, "document");
let events = (await db.query("select event_type,before_data,after_data from ops_station_audit_events where audit_id=$1 order by created_at", [planned])).rows;
assert.deepEqual(events.map((e) => e.event_type), ["type_changed"]);
assert.equal(events[0].before_data.type_name, "Physical audit");
assert.equal(events[0].after_data.type_name, "COD audit");
// The Physical first-half window is free again.
const refill = await insert("2099-10-07T04:00Z", "first_half");

// Changing into a window that is already booked is refused as planned and allowed as unscheduled.
await assert.rejects(change(refill, { type: cod, slot: "cod_1" }), /already has an audit/);
assert.equal((await row(refill)).audit_type_id, physical, "a refused change leaves the audit untouched");
await change(refill, { type: cod, slot: "unscheduled-dddd4444", source: "unscheduled" });
assert.equal((await row(refill)).schedule_source, "unscheduled");
// An unscheduled audit stays unscheduled whatever plan the caller sends.
await change(surprise, { type: cod, source: "manual" });
assert.equal((await row(surprise)).schedule_source, "unscheduled");

// Type and auditor together write both history entries and mark the cross-station auditor.
await change(secondHalf, { type: cod, slot: "cod_3", to: other, cross: true });
changed = await row(secondHalf);
assert.equal(changed.assigned_to, other);
assert.equal(changed.assigned_name, "Visitor");
assert.equal(changed.cross_station, true);
events = (await db.query("select event_type from ops_station_audit_events where audit_id=$1 order by event_type", [secondHalf])).rows;
assert.deepEqual(events.map((e) => e.event_type), ["reassigned", "type_changed"]);
// Reassigning back inside the station clears the cross-station mark.
await change(secondHalf, { to: auditor, cross: false });
assert.equal((await row(secondHalf)).cross_station, false);

// Once started, the type can still change but the auditor cannot; once submitted, nothing can.
await db.query("update ops_station_audits set status_code='in_progress',started_at=now() where id=$1", [secondHalf]);
await assert.rejects(change(secondHalf, { to: other }), /unstarted audit can be reassigned/);
await change(secondHalf, { type: physical, slot: "second_half" });
assert.equal((await row(secondHalf)).audit_type_id, physical);
await db.query("update ops_station_audits set status_code='under_review',completed_at=now() where id=$1", [secondHalf]);
await assert.rejects(change(secondHalf, { type: cod, slot: "cod_3" }), /has not been submitted/);
await assert.rejects(
  db.query(
    "select public.change_station_audit($1,$2,now(),$3,'x','x','manual',$4,false,'Reason',$5,'Leader','lead@example.test','Business Head')",
    [company, uid(997), cod, auditor, manager],
  ),
  /Audit unavailable/,
);

// Requests: one open request per person, station and type; a decided one frees the slot.
const request = () =>
  db.query(
    "insert into ops_station_audit_requests(company_id,location_id,audit_type_id,requested_by,reason) values($1,$2,$3,$4,'Cross audit')",
    [company, station, cod, other],
  );
await request();
await assert.rejects(request(), /unique/);
await assert.rejects(
  db.query("update ops_station_audit_requests set status='maybe'"),
  /check constraint/,
);
await db.query("update ops_station_audit_requests set status='declined'");
await request();
await assert.rejects(
  db.query("insert into ops_station_audit_requests(company_id,location_id,audit_type_id,requested_by,reason) values($1,$2,$3,$4,'  ')", [company, station, cod, manager]),
  /check constraint/,
);

// Browser roles reach neither the table nor the function.
await db.exec("set role authenticated");
await assert.rejects(db.query("select * from ops_station_audit_requests"), /permission denied/);
await assert.rejects(change(refill, { type: physical, slot: "first_half" }), /permission denied/);
await db.exec("reset role");
console.log(
  "Unscheduled audit database tests passed: window rules kept for planned audits, unscheduled audits outside the programme, type change with history and proof, booked-window refusal, cross-station marking, lifecycle guards, request uniqueness and browser-role denial.",
);
await db.close();
