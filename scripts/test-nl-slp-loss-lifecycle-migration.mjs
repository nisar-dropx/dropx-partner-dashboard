// Live NL/SLP loss lifecycle: propose → approve gate, no self-approve, clarification, command summary.
// Run from the repo root: node scripts/test-nl-slp-loss-lifecycle-migration.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role service_role; create role anon; create role authenticated;
create table companies(id uuid primary key, code text);
create table stations(id uuid primary key, company_id uuid, station_code text);
create table cod_station_settings(location_id uuid, company_id uuid, portal_station_code text);
create table employees(id uuid primary key, company_id uuid, employee_code text, full_name text, is_active boolean default true, location_id uuid, last_working_date date);
create table workforce(id uuid primary key, company_id uuid, dropx_id text, full_name text, is_active boolean default true, location_id uuid, last_working_date date);
create function station_audit_employee_directory(p_company uuid,p_station uuid)
returns table(ref text,employee_code text,full_name text,designation text,is_active boolean) language sql stable as $$
 select 'employee:'||e.id,e.employee_code,e.full_name,'People',e.is_active from employees e where e.company_id=p_company and e.location_id=p_station
 union all select 'workforce:'||w.id,w.dropx_id,w.full_name,'DA',w.is_active from workforce w where w.company_id=p_company and w.location_id=p_station $$;
create table loss_report_runs(id uuid primary key default gen_random_uuid(), report text, started_at timestamptz default now());
create table nl_loss_sources(account_key text primary key, company_id uuid, recoverable_statuses text[] default array['Recoverable'], allow_equal_split boolean default true, allow_custom_split boolean default true, include_inactive_people boolean default false,
 recovery_policy jsonb not null default '{"salary_cap_enabled":false,"salary_month_offset":1,"salary_cap_percent":50,"reserve_other_recoveries":true,"attachment_max_count":5,"cctv_public_confirmation":true,"payroll_start_month":"2026-10","max_installments":24}', updated_at timestamptz default now());
create table nl_loss_month_cases(company_id uuid, report text not null default 'nl', month text, case_key text, station_code text, amount numeric(14,2), source_status text, details jsonb not null default '{}', source_present boolean default true, source_file text, source_run_id uuid, source_updated_at timestamptz default now(), last_seen_at timestamptz default now(), data_source text, primary key(company_id,month,case_key));
create table nl_recovery_outcomes(company_id uuid, code text, label text, allocation_required boolean, remarks_required boolean default true, is_active boolean default true, sort_order int default 0, deduction_timing text default 'none', dispute_fields_enabled boolean default false, reason_required boolean default false, details_required boolean default false, attachments_enabled boolean default false, cctv_enabled boolean default false, restricted boolean default false, primary key(company_id,code));
create table nl_loss_recoveries(company_id uuid, month text, case_key text, outcome_code text, outcome_label text, split_mode text, allocations jsonb not null default '[]', remarks text default '', source_amount numeric(14,2), source_status text, is_deleted boolean not null default false, version int default 1, updated_by uuid, updated_by_name text, updated_at timestamptz default now(), deduction_timing text not null default 'none', deduction_month text, recovery_details jsonb default '{}', primary key(company_id,month,case_key));
create table nl_loss_recovery_events(id uuid primary key default gen_random_uuid(), company_id uuid, month text, case_key text, before_value jsonb, after_value jsonb, actor_id uuid, actor_name text, created_at timestamptz default now());
create table nl_recovery_payables(company_id uuid, employee_ref text, salary_month text, eligible boolean, payable numeric, source text, checked_at timestamptz default now(), policy_updated_at timestamptz, primary key(company_id,employee_ref,salary_month));
create table nl_recovery_attachments(id uuid primary key, company_id uuid, month text, case_key text);
create function nl_is_recoverable(co uuid,status text) returns boolean language sql stable as $$ select exists(select 1 from nl_loss_sources s,unnest(s.recoverable_statuses) l where s.company_id=co and lower(trim(l))=lower(trim(status))) $$;
create function nl_case_recoverable(co uuid,p_report text,status text) returns boolean language sql stable as $$ select p_report='slp' or (p_report='station' and status='Approved') or nl_is_recoverable(co,status) $$;
create table hr_payroll_runs(id uuid primary key, company_id uuid, period_start date, period_end date, status text);
create table hr_payroll_run_people(id uuid primary key, company_id uuid, run_id uuid, worker_type text, worker_id uuid, unique(company_id,id));
create table hr_payroll_run_items(id uuid primary key default gen_random_uuid(), company_id uuid, run_person_id uuid, code text, name text, item_type text, amount numeric, source text, metadata jsonb not null default '{}');
create table workforce_payout_publications(id uuid primary key default gen_random_uuid(), company_id uuid, workforce_id uuid, station_id uuid, revision int, snapshot jsonb, period_start date, period_end date);
create table bumps(company_id uuid, period_month date, at timestamptz default clock_timestamp());
create function workforce_bump_payout_period_dependency_revision(p_company_id uuid,p_period_month date) returns void language sql as $$ insert into public.bumps values(p_company_id,date_trunc('month',p_period_month)::date) $$;
create table portal_notification_controls(
  company_id uuid not null references companies(id), portal text not null, event_key text not null,
  state text not null default 'disabled', paused_until timestamptz, subject_template text, body_template text,
  config jsonb not null default '{}', updated_by uuid, updated_at timestamptz not null default now(),
  primary key(company_id,portal,event_key)
);
`);

const C = "00000000-0000-0000-0000-000000000001", S = "00000000-0000-0000-0000-0000000000a1";
const E1 = "00000000-0000-0000-0000-0000000000e1", W1 = "00000000-0000-0000-0000-0000000000f1";
const CM = "00000000-0000-0000-0000-0000000000aa", SLP = "00000000-0000-0000-0000-0000000000bb";

await db.exec(`insert into companies values('${C}','X'); insert into stations values('${S}','${C}','BLR1');
 insert into employees(id,company_id,employee_code,full_name,location_id) values('${E1}','${C}','D0001','IC One','${S}');
 insert into workforce(id,company_id,dropx_id,full_name,location_id) values('${W1}','${C}','W0001','DA One','${S}');
 insert into nl_loss_sources(account_key,company_id) values('default','${C}');
 insert into nl_recovery_outcomes(company_id,code,label,allocation_required,deduction_timing) values('${C}','deduct','Deduct',true,'current_month');
 insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status,data_source) values
  ('${C}','nl','2026-09','L1','BLR1',1000,'Recoverable','historic'),
  ('${C}','nl','2026-09','L2','BLR1',500,'Recoverable','live'),
  ('${C}','slp','2026-09','slp:S1','BLR1',300,'SLP Initial','historic');`);

for (const file of [
  "20261015130000_loss_recovery_payroll_deductions.sql",
  "20261016161000_loss_recovery_installments.sql",
  "20261022120000_nl_slp_loss_lifecycle.sql",
  "20261022121000_loss_recovery_action_digest.sql",
  "20261022200000_loss_recovery_digest_deep_links.sql",
]) {
  const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
  await db.exec(sql);
  await db.exec(sql);
}

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const one = async (sql) => (await db.query(sql)).rows[0];
const throws = async (name, sql, re) => {
  try {
    await db.query(sql);
    fails++;
    console.log("FAIL", name, "did not raise");
  } catch (e) {
    const ok = re.test(e.message);
    if (!ok) fails++;
    console.log(ok ? "PASS" : "FAIL", name, ok ? "" : e.message);
  }
};

eq(
  "Historic recoverable NL backfills to cluster validation",
  (await one(`select lifecycle_status s from nl_loss_month_cases where case_key='L1'`)).s,
  "cluster_validation_pending",
);
eq(
  "Live NL backfills to station dispute window",
  (await one(`select lifecycle_status s from nl_loss_month_cases where case_key='L2'`)).s,
  "station_dispute_or_clarification_window",
);
eq(
  "SLP Initial stays imported / non-allocatable",
  (await one(`select lifecycle_status s from nl_loss_month_cases where case_key='slp:S1'`)).s,
  "imported",
);
eq(
  "Digest control seeded disabled",
  (await one(`select state, config->>'delivery_ready' r from portal_notification_controls where event_key='loss_recovery_action_digest'`)),
  { state: "disabled", r: "false" },
);

await db.exec(`insert into nl_recovery_payables(company_id,employee_ref,salary_month,eligible,payable,gross,source,policy_updated_at)
 select '${C}',r,to_char(date_trunc('month',now() at time zone 'Asia/Kolkata')-interval '1 month','YYYY-MM'),true,50000,60000,'x',(select updated_at from nl_loss_sources)
 from unnest(array['employee:${E1}','workforce:${W1}']) r`);

const save = (cs, ver, alloc, actor = CM) =>
  `select save_nl_recovery('${C}','2026-09','${cs}',${ver},'deduct','custom','${JSON.stringify(alloc)}','Recover loss','${actor}','Cluster','{}','{"mode":"full"}')`;

await db.query(save("L1", 0, [{ employee_ref: `employee:${E1}`, amount: "1000" }]));
eq(
  "Propose moves case to SLP final confirmation",
  (await one(`select lifecycle_status s, approval_status a from nl_loss_month_cases c join nl_loss_recoveries r using(company_id,month,case_key) where case_key='L1'`)),
  { s: "slp_final_confirmation_pending", a: "proposed" },
);
eq("Proposed plan is not due", (await db.query(`select * from nl_loss_recovery_due('${C}','2026-10','hrms')`)).rows.length, 0);

await throws(
  "Proposer cannot approve own proposal",
  `select nl_loss_recovery_approve('${C}','2026-09','L1',1,'${CM}','Cluster',null,(select lifecycle_version from nl_loss_month_cases where case_key='L1'))`,
  /another authorised person must approve/,
);

const lv = (await one(`select lifecycle_version v from nl_loss_month_cases where case_key='L1'`)).v;
await db.query(`select nl_loss_recovery_approve('${C}','2026-09','L1',1,'${SLP}','SLP Mgr','Confirmed',${lv})`);
eq(
  "SLP approve schedules recovery",
  (await one(`select lifecycle_status s, approval_status a from nl_loss_month_cases c join nl_loss_recoveries r using(company_id,month,case_key) where case_key='L1'`)),
  { s: "recovery_approved_scheduled", a: "approved" },
);
await db.exec(`update nl_loss_recoveries set deduction_month='2026-10' where case_key='L1'`);
eq("Approved plan is due", (await db.query(`select amount::text from nl_loss_recovery_due('${C}','2026-10','hrms')`)).rows.map((r) => r.amount), ["1000.00"]);

const holdLv = (await one(`select lifecycle_version v from nl_loss_month_cases where case_key='L1'`)).v;
await db.query(`select nl_loss_lifecycle_transition('${C}','2026-09','L1','hold',${holdLv},'${SLP}','SLP Mgr','Paused for review')`);
eq("Hold parks approved recovery", (await one(`select lifecycle_status s from nl_loss_month_cases where case_key='L1'`)).s, "on_hold");
eq("Held plan is not due", (await db.query(`select * from nl_loss_recovery_due('${C}','2026-10','hrms') where case_key='L1'`)).rows.length, 0);
const resumeLv = (await one(`select lifecycle_version v from nl_loss_month_cases where case_key='L1'`)).v;
await db.query(`select nl_loss_lifecycle_transition('${C}','2026-09','L1','resume',${resumeLv},'${SLP}','SLP Mgr',null)`);
eq(
  "Resume restores approved scheduled (not cluster validation)",
  (await one(`select lifecycle_status s, approval_status a from nl_loss_month_cases c join nl_loss_recoveries r using(company_id,month,case_key) where case_key='L1'`)),
  { s: "recovery_approved_scheduled", a: "approved" },
);
eq("Resumed approved plan is due again", (await db.query(`select amount::text from nl_loss_recovery_due('${C}','2026-10','hrms') where case_key='L1'`)).rows.map((r) => r.amount), ["1000.00"]);

const lv2 = (await one(`select lifecycle_version v from nl_loss_month_cases where case_key='L2'`)).v;
await db.query(`select nl_loss_lifecycle_transition('${C}','2026-09','L2','ready_for_cluster',${lv2},'${CM}','Cluster',null)`);
await db.query(save("L2", 0, [{ employee_ref: `workforce:${W1}`, amount: "500" }]));
const l2 = await one(`select r.version, c.lifecycle_version lv from nl_loss_recoveries r join nl_loss_month_cases c using(company_id,month,case_key) where case_key='L2'`);
await db.query(`select nl_loss_recovery_approve('${C}','2026-09','L2',${l2.version},'${SLP}','SLP Mgr',null,${l2.lv})`);
await db.exec(`update nl_loss_recoveries set deduction_month='2026-10' where case_key='L2'`);

await db.query(`select nl_loss_clarification_submit('${C}','2026-09','L2','${W1}','DA One','Shipment was delivered with proof of delivery on file','Delivered','clarification','workforce:${W1}','https://example.com/pod','[]'::jsonb,'associate')`);
eq(
  "Associate clarification pauses future recovery",
  (await one(`select lifecycle_status s, approval_status a from nl_loss_month_cases c join nl_loss_recoveries r using(company_id,month,case_key) where case_key='L2'`)),
  { s: "needs_review", a: "needs_review" },
);
eq("Needs-review plan is not due", (await db.query(`select * from nl_loss_recovery_due('${C}','2026-10','workforce') where case_key='L2'`)).rows.length, 0);
await throws(
  "Clarification history immutable",
  `update nl_loss_clarification_events set note='x'`,
  /cannot be changed/,
);

const summary = await one(`select nl_loss_recovery_command_summary('${C}', array['BLR1'], '2026-10') s`);
eq("Command summary has recoverable total", Number(summary.s.total_recoverable) >= 1000, true);
eq("Command summary counts SLP queue or needs_review", Number(summary.s.blocked_needs_review) >= 1, true);

const actions = (await db.query(`select action_key from nl_loss_recovery_action_items('${C}') order by case_key`)).rows.map((r) => r.action_key);
eq("Action items include open work", actions.includes("recovery_due") || actions.includes("recovery_review"), true);

await throws(
  "SLP Initial still cannot be assigned",
  save("slp:S1", 0, [{ employee_ref: `employee:${E1}`, amount: "300" }]),
  /still in SLP Initial/,
);

eq("Lifecycle events recorded", Number((await one(`select count(*)::int n from nl_loss_lifecycle_events where case_key='L1'`)).n) >= 2, true);

// Clarification after a reviewed payroll deduction: past key stays; future due pauses.
const RUN = "00000000-0000-0000-0000-0000000000d1";
const PERSON = "00000000-0000-0000-0000-0000000000d2";
await db.exec(`insert into hr_payroll_runs(id,company_id,period_start,period_end,status) values('${RUN}','${C}','2026-10-01','2026-10-31','approved');
 insert into hr_payroll_run_people(id,company_id,run_id,worker_type,worker_id) values('${PERSON}','${C}','${RUN}','employee','${E1}');
 insert into hr_payroll_run_items(company_id,run_person_id,code,name,item_type,amount,source,metadata)
 values('${C}','${PERSON}','OPS_LOSS_RECOVERY','Loss','deduction',1000,'ops_loss_recovery','{"recovery_key":"2026-09|L1|employee:${E1}","month":"2026-09","case_key":"L1"}')`);
const beforeClarify = (await db.query(`select amount::numeric as amount, metadata->>'recovery_key' k from hr_payroll_run_items where run_person_id='${PERSON}'`)).rows;
eq("Reviewed payroll key before clarification", beforeClarify.map((r) => [Number(r.amount), r.k]), [[1000, `2026-09|L1|employee:${E1}`]]);
await db.query(`select nl_loss_clarification_submit('${C}','2026-09','L1','${E1}','IC One','POD uploaded after first payroll deduction for this TID','Delivered','clarification','employee:${E1}',null,'[]'::jsonb,'associate')`);
eq(
  "Clarification after deduction pauses plan",
  (await one(`select lifecycle_status s, approval_status a from nl_loss_month_cases c join nl_loss_recoveries r using(company_id,month,case_key) where case_key='L1'`)),
  { s: "needs_review", a: "needs_review" },
);
eq("Future due paused after clarification", (await db.query(`select * from nl_loss_recovery_due('${C}','2026-11','hrms') where case_key='L1'`)).rows.length, 0);
const afterClarify = (await db.query(`select amount::numeric as amount, metadata->>'recovery_key' k from hr_payroll_run_items where run_person_id='${PERSON}'`)).rows;
eq("Past reviewed deduction unchanged", afterClarify.map((r) => [Number(r.amount), r.k]), beforeClarify.map((r) => [Number(r.amount), r.k]));

const otherStation = await one(`select nl_loss_recovery_command_summary('${C}', array['HYD9'], '2026-10') s`);
eq("Command summary for other station is empty scope", Number(otherStation.s.total_recoverable || 0), 0);
eq("Empty action day yields no rows", (await db.query(`select * from nl_loss_recovery_action_items('${C}') where station_code='HYD9'`)).rows.length, 0);

// New recovery controls are idempotent and cannot close a departed-person balance.
const controlSql = readFileSync("supabase/migrations/20261026153000_loss_recovery_case_controls.sql", "utf8");
// Production function definitions may retain CRLF and different indentation.
await db.exec(`do $$ declare f record; begin for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname='save_nl_recovery' loop execute replace(pg_get_functiondef(f.oid),E'else\\n    p_details',E'else\\r\\n      p_details'); end loop; end $$;`);
await db.exec(controlSql);
await db.exec(controlSql);
await db.exec(`insert into nl_recovery_outcomes(company_id,code,label,allocation_required) values('${C}','da_left','DA left',false)`);
await db.exec(`insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values('${C}','nl','2026-09','LEFT1','BLR1',500,'Recoverable')`);
async function mustReject(label, sql) { try { await db.query(sql); eq(label, 'accepted', 'rejected'); } catch { eq(label, 'rejected', 'rejected'); } }
await mustReject('Legacy shortcut refused', `select save_nl_recovery('${C}','2026-09','LEFT1',0,'da_left','none','[]','Person has left','${CM}','CM','{}')`);
await mustReject('Missing departed identity refused', `select save_nl_recovery('${C}','2026-09','LEFT1',0,'responsible_left','none','[]','Person has left','${CM}','CM','{}')`);
await db.query(`select save_nl_recovery('${C}','2026-09','LEFT1',0,'responsible_left','none','[]','Left on 20 October','${CM}','CM','{"employee_id":"D123","employee_name":"Departed Person","follow_up":"CM to collect by month end"}')`);
eq('Departed balance stays outstanding', (await one(`select lifecycle_status from nl_loss_month_cases where case_key='LEFT1'`)).lifecycle_status, 'exit_balance');
const transition = (version,action,note='Detailed reason for this case',url='',publicLink=false) => `select nl_case_response_transition('${C}','2026-09','LEFT1',${version},'${action}','${note}','${url}',${publicLink},'${SLP}','SLP')`;
await mustReject('Response before activation denied', transition(0,'response'));
await db.query(transition(0,'activate'));
await mustReject('Stale response rejected', transition(0,'response'));
await mustReject('Private link not accepted', transition(1,'response','Clear details','https://drive.google.com/file/test',false));
await db.query(transition(1,'response','Clear details','https://drive.google.com/file/test',true));
await db.query(transition(2,'vendor_response'));
await db.query(transition(3,'revoke'));
await mustReject('Revoked response denied', transition(4,'response'));
eq('Every response transition has immutable history', Number((await one(`select count(*) n from nl_case_response_events`)).n),4);
eq('Redispute does not close recovery', (await one(`select lifecycle_status from nl_loss_month_cases where case_key='LEFT1'`)).lifecycle_status,'exit_balance');

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
