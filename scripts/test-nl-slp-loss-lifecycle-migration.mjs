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

// Product lifecycle: every update needs independent approval; returns never erase debt.
await db.exec(`create table user_roles(id uuid primary key,company_id uuid,code text,is_active boolean default true);
create table app_pages(id uuid primary key,company_id uuid,code text);
create table role_page_permissions(company_id uuid,role_id uuid,page_id uuid,can_view boolean,can_add boolean,can_edit boolean,primary key(company_id,role_id,page_id));
insert into app_pages values('${SLP}','${C}','ops_losses');
insert into user_roles values('${CM}','${C}','OPERATIONS_CLM',true),('${E1}','${C}','OPERATIONS_FINMGR',true),('${W1}','${C}','OPERATIONS_MANAGING_PARTNER',true),('${S}','${C}','OPERATIONS_NATIONAL_HEAD',true);`);
const productSql=readFileSync("supabase/migrations/20261026203000_loss_recovery_product_lifecycle.sql","utf8");
await db.exec(productSql); await db.exec(productSql);
eq('Only the three authorised role aliases gain Losses access',(await db.query(`select code from user_roles r join role_page_permissions p on p.role_id=r.id where p.can_view and p.can_edit order by code`)).rows.map(r=>r.code),['OPERATIONS_FINMGR','OPERATIONS_MANAGING_PARTNER','OPERATIONS_NATIONAL_HEAD']);
await db.exec(`insert into nl_recovery_outcomes(company_id,code,label,allocation_required) values('${C}','already_recovered','Receipt received',false);
insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values('${C}','nl','2026-09','RECEIPT','BLR1',500,'Recoverable'),('${C}','nl','2026-09','PLAN3','BLR1',900,'Recoverable')`);
const receipt=(version,details)=>`select save_nl_recovery('${C}','2026-09','RECEIPT',${version},'already_recovered','none','[]','Payment received with reference','${CM}','Station','${JSON.stringify(details)}')`;
await mustReject('A receipt cannot close without amount and reference',receipt(0,{}));
await mustReject('A partial receipt cannot claim full recovery',receipt(0,{received_amount:'200',receipt_reference:'BANK123',received_date:'2026-10-01'}));
await db.query(receipt(0,{received_amount:'500',receipt_reference:'BANK123',received_date:'2026-10-01'}));
eq('Receipt is a proposal, never immediately recovered',(await one(`select approval_status s from nl_loss_recoveries where case_key='RECEIPT'`)).s,'proposed');
await mustReject('Receipt proposer cannot self approve',`select nl_loss_recovery_approve('${C}','2026-09','RECEIPT',1,'${CM}','Station')`);
await db.query(`select nl_loss_recovery_approve('${C}','2026-09','RECEIPT',1,'${SLP}','SLP')`);
eq('Independent receipt approval completes recovery',(await one(`select lifecycle_status s from nl_loss_month_cases where case_key='RECEIPT'`)).s,'recovered');
await db.query(`select save_nl_recovery('${C}','2026-09','LEFT1',1,'responsible_left','none','[]','Left on 20 October','${CM}','Station','{"employee_id":"D123","employee_name":"Departed Person","follow_up":"CM to collect by month end"}')`);
eq('Departed person update waits for approval',(await one(`select approval_status s from nl_loss_recoveries where case_key='LEFT1'`)).s,'proposed');
let state=await one(`select c.lifecycle_version lv,r.version from nl_loss_month_cases c join nl_loss_recoveries r using(company_id,month,case_key) where case_key='LEFT1'`);
await db.query(`select nl_loss_lifecycle_transition('${C}','2026-09','LEFT1','return_to_station',${state.lv},'${SLP}','SLP','Provide recovery owner and due date')`);
eq('Returned update remains unpaid',(await one(`select approval_status s from nl_loss_recoveries where case_key='LEFT1'`)).s,'returned');
await mustReject('Returned proposal cannot be approved before resubmission',`select nl_loss_recovery_approve('${C}','2026-09','LEFT1',3,'${SLP}','SLP')`);
await db.query(`select save_nl_recovery('${C}','2026-09','LEFT1',3,'responsible_left','none','[]','Left on 20 October','${CM}','Station','{"employee_id":"D123","employee_name":"Departed Person","follow_up":"CM to collect by 30 November"}')`);
await db.query(`select nl_loss_recovery_approve('${C}','2026-09','LEFT1',4,'${SLP}','SLP')`);
eq('Approved departure keeps exit balance',(await one(`select lifecycle_status s from nl_loss_month_cases where case_key='LEFT1'`)).s,'exit_balance');
const alloc3=JSON.stringify([{employee_ref:`employee:${E1}`,amount:'900'}]);
await db.query(`select save_nl_recovery('${C}','2026-09','PLAN3',0,'deduct','custom','${alloc3}','Recover over three paid cycles','${CM}','Station','{}','{"mode":"installments","basis":"months","value":"3"}')`);
await db.query(`select nl_loss_recovery_approve('${C}','2026-09','PLAN3',1,'${SLP}','SLP')`);
await db.exec(`update nl_loss_recoveries set deduction_month='2026-10' where case_key='PLAN3'`);
for(const month of ['2026-10','2026-11','2026-12','2027-01']) {
 const due=(await db.query(`select amount::text,recovery_key from nl_loss_recovery_due('${C}','${month}','hrms') where case_key='PLAN3'`)).rows;
 eq(`No salary for three months: ${month} still has only the first instalment`,due.map(x=>[x.amount,x.recovery_key]),[['300.00',`2026-09|PLAN3|employee:${E1}|1`]]);
}
await db.query(`select save_nl_recovery('${C}','2026-09','PLAN3',2,'deduct','custom','${alloc3}','Updated follow-up details','${CM}','Station','{}','{"mode":"installments","basis":"months","value":"3"}')`);
eq('Editing an approved plan requires approval again',(await one(`select approval_status s from nl_loss_recoveries where case_key='PLAN3'`)).s,'proposed');
eq('Revised proposal stops future deduction',(await db.query(`select * from nl_loss_recovery_due('${C}','2027-01','hrms') where case_key='PLAN3'`)).rows.length,0);
await mustReject('Unpaid loss cannot be rejected',`select nl_loss_lifecycle_transition('${C}','2026-09','PLAN3','reject',(select lifecycle_version from nl_loss_month_cases where case_key='PLAN3'),'${SLP}','SLP','No salary available')`);
await db.query(transition(4,'activate'));
const track=(version,status,ref='LSC-123',due="'2026-11-01'")=>`select nl_redispute_track('${C}','2026-09','LEFT1',${version},'${ref}','https://example.com/tt','${status}',${due},'Detailed vendor ticket follow-up','${SLP}','SLP')`;
await mustReject('Filed TT needs a reference',track(5,'filed',''));
await mustReject('Filed TT needs a follow-up date',track(5,'filed','LSC-123','null'));
await db.query(track(5,'filed'));
await mustReject('Stale TT update denied',track(5,'with_vendor'));
await db.query(track(6,'won','LSC-123','null'));
eq('Reported win waits for source verification',(await one(`select lifecycle_status s from nl_loss_month_cases where case_key='LEFT1'`)).s,'needs_review');
await throws('An unapproved exit plan cannot be written off',`select waive_nl_recovery_balance('${C}','2026-09','PLAN3','employee:${E1}','No salary was payable','${SLP}','SLP')`,/independently approved/);
await db.query(`select nl_case_response_transition('${C}','2026-09','RECEIPT',0,'activate','Review source after verified receipt','',false,'${SLP}','SLP')`);
await db.query(`select nl_redispute_track('${C}','2026-09','RECEIPT',1,'TT-PAID','','won',null,'Vendor confirmed the source decision','${SLP}','SLP')`);
eq('TT win never reopens a verified received payment',(await one(`select approval_status s from nl_loss_recoveries where case_key='RECEIPT'`)).s,'approved');
eq('TT history saved',(await one(`select count(*)::int n from nl_case_response_events where action='tracking' and case_key='LEFT1'`)).n,2);
eq('New migration does not rewrite actual payroll history',(await db.query(`select amount::numeric as amount,metadata->>'recovery_key' k from hr_payroll_run_items where run_person_id='${PERSON}'`)).rows,afterClarify);

// Exception-only routing: fresh eligibility and every existing money guard still apply.
const exceptionSql=readFileSync("supabase/migrations/20261027183000_loss_exception_approval.sql","utf8");
await db.exec(exceptionSql); await db.exec(exceptionSql);
await db.exec(`insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values
 ('${C}','nl','2026-09','AUTO-E','BLR1',100,'Recoverable'),('${C}','nl','2026-09','AUTO-W','BLR1',100,'Recoverable'),
 ('${C}','nl','2026-09','DEFER','BLR1',100,'Recoverable'),('${C}','nl','2026-09','REVIEW','BLR1',100,'Recoverable');
 insert into nl_recovery_outcomes(company_id,code,label,allocation_required,deduction_timing) values('${C}','next','Next payroll',true,'next_month');
 update nl_recovery_payables set checked_at=now();`);
const full=(key,ref,code='deduct',version=0)=>`select save_nl_recovery('${C}','2026-09','${key}',${version},'${code}','custom','[{"employee_ref":"${ref}","amount":"100"}]','Full loss allocated','${CM}','Station','{}','{"mode":"full"}')`;
await db.query(full('AUTO-E',`employee:${E1}`));
await db.query(full('AUTO-W',`workforce:${W1}`));
for(const [key,kind] of [['AUTO-E','hrms'],['AUTO-W','workforce']]) {
 const r=await one(`select * from nl_loss_recoveries where case_key='${key}'`);
 eq(`${kind} full recovery automatically eligible`,r.approval_status,'approved');
 eq(`${kind} does not forge a human approver`,r.approved_by,null);
 eq(`${kind} system decision labelled`,r.approved_by_name,'Automatic · full recovery');
 eq(`${kind} available to payroll`,(await db.query(`select * from nl_loss_recovery_due('${C}','${r.deduction_month}','${kind}') where case_key='${key}'`)).rows.length,1);
}
await db.query(full('DEFER',`employee:${E1}`,'next'));
eq('Next-month recovery needs approval',(await one(`select approval_status s from nl_loss_recoveries where case_key='DEFER'`)).s,'proposed');
await db.exec(`update nl_loss_month_cases set lifecycle_status='needs_review' where case_key='REVIEW'`);
await db.query(full('REVIEW',`employee:${E1}`));
await db.query(full('REVIEW',`employee:${E1}`,'deduct',1));
eq('Source review cannot bypass approval by choosing full',(await one(`select approval_status s from nl_loss_recoveries where case_key='REVIEW'`)).s,'proposed');
await db.query(`select save_nl_recovery('${C}','2026-09','PLAN3',3,'deduct','custom','${alloc3}','Still three instalments','${CM}','Station','{}','{"mode":"installments","basis":"months","value":"3"}')`);
eq('Instalments still need independent approval',(await one(`select approval_status s from nl_loss_recoveries where case_key='PLAN3'`)).s,'proposed');
await mustReject('Exception proposer cannot self approve',`select nl_loss_recovery_approve('${C}','2026-09','DEFER',1,'${CM}','Station')`);
await db.query(`select nl_loss_recovery_approve('${C}','2026-09','DEFER',1,'${SLP}','SLP')`);
eq('Independent exception approval works',(await one(`select approval_status s from nl_loss_recoveries where case_key='DEFER'`)).s,'approved');
await db.exec(`update nl_loss_month_cases set lifecycle_status='returned_to_station' where case_key='AUTO-E';update nl_loss_recoveries set approval_status='returned' where case_key='AUTO-E'`);
await db.query(full('AUTO-E',`employee:${E1}`,'deduct',1));
await db.query(full('AUTO-E',`employee:${E1}`,'deduct',2));
eq('Returned routine recovery requires independent confirmation',(await one(`select approval_status s from nl_loss_recoveries where case_key='AUTO-E'`)).s,'proposed');

await db.exec(`insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values
 ('${C}','nl','2026-09','EXIT-FULL','BLR1',100,'Recoverable'),('${C}','nl','2026-09','CAP-FULL','BLR1',100,'Recoverable');
 update workforce set last_working_date=(now() at time zone 'Asia/Kolkata')::date where id='${W1}';`);
await db.query(full('EXIT-FULL',`workforce:${W1}`));
eq('Full recovery for a departed person needs approval',(await one(`select approval_status s from nl_loss_recoveries where case_key='EXIT-FULL'`)).s,'proposed');
await db.query(`select save_nl_recovery('${C}','2026-09','CAP-FULL',0,'deduct','custom','[{"employee_ref":"employee:${E1}","amount":"100"}]','Full loss with override','${CM}','Station','{}','{"mode":"full","cap_override":true,"cap_override_reason":"Explicit salary cap exception"}')`);
eq('Full debit with cap override needs approval',(await one(`select approval_status s from nl_loss_recoveries where case_key='CAP-FULL'`)).s,'proposed');
await mustReject('Automatic routing never permits a partial allocation',full('CAP-FULL',`employee:${E1}`,'deduct',1).replace('"amount":"100"','"amount":"50"'));
eq('Actual past payroll remains unchanged',(await db.query(`select amount::numeric as amount,metadata->>'recovery_key' k from hr_payroll_run_items where run_person_id='${PERSON}'`)).rows,afterClarify);

// Current People directory + explicit payroll month.
await db.exec(`alter table employees add column deleted_at timestamptz;
alter table workforce add column source_profile_type text; alter table workforce add column source_profile_id uuid;
create table contractors(id uuid primary key,company_id uuid,dropx_id text,full_name text,designation text,is_active boolean default true,deleted_at timestamptz,location_id uuid,last_working_date date);
create table designations(id uuid primary key,company_id uuid,code text,name text);
create table hr_people(id uuid primary key,company_id uuid,display_name text,status text);
create table hr_engagements(id uuid primary key,company_id uuid,person_id uuid,employee_id uuid,contractor_id uuid,worker_code text,start_date date,end_date date,status text);
create table hr_work_assignments(id uuid primary key,company_id uuid,engagement_id uuid,location_id uuid,designation_id uuid,position_title text,is_primary boolean,effective_from date,effective_to date);
create table hr_reporting_relationships(company_id uuid,subject_assignment_id uuid,manager_assignment_id uuid,is_primary boolean,relationship_type text,effective_from date,effective_to date);
create table hr_user_person_links(company_id uuid,person_id uuid,user_id uuid,status text);
create table station_responsibility_assignments(company_id uuid,station_id uuid,assignment_id uuid,assignee_user_id uuid,effective_from timestamptz,effective_to timestamptz);
`);
// SQL Editor can normalize indentation in production function definitions.
// The migration must not depend on two-space indentation for its payroll guards.
const liveFormattedWriter=await one(`select pg_get_functiondef(oid) definition from pg_proc where proname='save_nl_recovery'`);
await db.exec(liveFormattedWriter.definition.replace(/^  /gm,' '));
const directorySql=readFileSync("supabase/migrations/20261027203000_loss_people_payroll_month.sql","utf8");
await db.exec(directorySql); await db.exec(directorySql);
eq('Inclusive fifth keeps October', (await one(`select nl_recovery_deduction_month('nl','2026-09','2026-11-05T17:00:00+05:30',null,'current_month',5) m`)).m,'2026-10');
eq('Sixth moves to November', (await one(`select nl_recovery_deduction_month('nl','2026-09','2026-11-06T00:00:00+05:30',null,'current_month',5) m`)).m,'2026-11');
eq('Old loss uses current payroll', (await one(`select nl_recovery_deduction_month('nl','2026-02','2026-10-27T00:00:00+05:30',null,'current_month',5) m`)).m,'2026-10');
eq('SLP uses final availability', (await one(`select nl_recovery_deduction_month('slp','2026-02','2026-10-27T00:00:00+05:30','2026-11-08','current_month',5) m`)).m,'2026-11');
const CT='00000000-0000-0000-0000-0000000000c1';
await db.exec(`insert into contractors(id,company_id,dropx_id,full_name,designation,location_id) values('${CT}','${C}','CT01','Contractor TL','TL','${S}');
insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values('${C}','nl','2026-09','CONTRACTOR','BLR1',100,'Recoverable'),('${C}','nl','2026-09','FUTURE','BLR1',100,'Recoverable');
insert into nl_recovery_payables(company_id,employee_ref,salary_month,eligible,payable,gross,source,policy_updated_at)
select '${C}',r,nl_recovery_deduction_month('nl','2026-09',now(),null,'current_month',5),true,50000,60000,'x',(select updated_at from nl_loss_sources)
from unnest(array['employee:${E1}','contractor:${CT}']) r on conflict(company_id,employee_ref,salary_month) do update set checked_at=now();`);
eq('Contractor is visible', (await db.query(`select ref from loss_recovery_people('${C}','${S}') where ref='contractor:${CT}'`)).rows.length,1);
await db.query(full('CONTRACTOR',`contractor:${CT}`));
const contractorPlan=await one(`select * from nl_loss_recoveries where case_key='CONTRACTOR'`);
eq('Contractor full plan routes automatically',contractorPlan.approval_status,'approved');
eq('Contractor eligible for People payroll',(await db.query(`select * from nl_loss_recovery_due('${C}','${contractorPlan.deduction_month}','hrms') where case_key='CONTRACTOR'`)).rows.length,1);
const future=(await one(`select to_char(to_date('${contractorPlan.deduction_month}','YYYY-MM')+interval '1 month','YYYY-MM') m`)).m;
await db.exec(`insert into nl_recovery_payables(company_id,employee_ref,salary_month,eligible,payable,gross,source,policy_updated_at) select '${C}','employee:${E1}','${future}',true,50000,60000,'x',updated_at from nl_loss_sources on conflict do nothing;`);
await db.query(full('FUTURE',`employee:${E1}`).replace('"mode":"full"',`"mode":"full","deduction_month":"${future}"`));
eq('Explicit future month persists',(await one(`select deduction_month m from nl_loss_recoveries where case_key='FUTURE'`)).m,future);
eq('Explicit future month requires approval',(await one(`select approval_status s from nl_loss_recoveries where case_key='FUTURE'`)).s,'proposed');
eq('Real debit records stay in actual payroll month',(await db.query(`select payroll_month,amount::text from nl_recovery_debits('${C}') where case_key='L1'`)).rows,[{payroll_month:'2026-10',amount:'1000.00'}]);

// Reporting chains include station staff and their CM/AOM, never the next senior role.
const uid=n=>`10000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
for(const [i,code,name] of [[1,'SSA','Station Associate'],[2,'CLM','Cluster Manager'],[3,'AOM','Area Operations Manager'],[4,'NH','National Head'],[5,'HLM','Head Operations- Last Mile']]){
 await db.exec(`insert into designations values('${uid(i)}','${C}','${code}','${name}');
 insert into employees(id,company_id,employee_code,full_name,location_id) values('${uid(10+i)}','${C}','P${i}','Person ${name}',${i===1||i===5?`'${S}'`:'null'});
 insert into hr_people values('${uid(20+i)}','${C}','Person ${name}','active');
 insert into hr_engagements values('${uid(30+i)}','${C}','${uid(20+i)}','${uid(10+i)}',null,'P${i}','2020-01-01',null,'active');
 insert into hr_work_assignments values('${uid(40+i)}','${C}','${uid(30+i)}',${i===1||i===5?`'${S}'`:'null'},'${uid(i)}',null,true,'2020-01-01',null);`);
 if(i>1)await db.exec(`insert into hr_reporting_relationships values('${C}','${uid(39+i)}','${uid(40+i)}',true,'solid_line','2020-01-01',null)`);
}
const names=(await db.query(`select designation from loss_recovery_people('${C}','${S}')`)).rows.map(r=>r.designation);
eq('Station People name is available',names.includes('Station Associate'),true);
eq('Mapped cluster manager is included',names.includes('Cluster Manager'),true);
eq('AOM ceiling is included',names.includes('Area Operations Manager'),true);
eq('National Head above ceiling excluded',names.includes('National Head'),false);
eq('Station-mapped operations head above ceiling excluded',names.includes('Head Operations- Last Mile'),false);
await db.exec(`insert into workforce(id,company_id,dropx_id,full_name,location_id,source_profile_type,source_profile_id) values('${uid(90)}','${C}','MIRROR','Duplicate person','${S}','employee','${uid(11)}')`);
eq('People workforce mirror deduplicated',(await db.query(`select ref from loss_recovery_people('${C}','${S}') where ref='workforce:${uid(90)}'`)).rows.length,0);
const redisputeSql=readFileSync("supabase/migrations/20261027210000_loss_redispute_review.sql","utf8");
await db.exec(redisputeSql);await db.exec(redisputeSql);
const rd=(version,action,details={},actor=SLP)=>`select nl_redispute_transition('${C}','2026-09','CONTRACTOR',${version},'${action}','${JSON.stringify(details)}','${actor}','Actor')`;
await db.query(rd(0,'activate'));
eq('Activation needs no station evidence',(await one(`select workflow_status s from nl_case_response_windows where case_key='CONTRACTOR'`)).s,'awaiting_station');
eq('Active redispute pauses payroll',(await db.query(`select * from nl_loss_recovery_due('${C}','${contractorPlan.deduction_month}','hrms') where case_key='CONTRACTOR'`)).rows.length,0);
eq('Ledger shows the active hold',(await one(`select status from nl_recovery_ledger('${C}',null,'contractor:${CT}') where case_key='CONTRACTOR'`)).status,'redispute_pending');
await mustReject('Active redispute cannot be bypassed by a plan edit',full('CONTRACTOR',`contractor:${CT}`,'deduct',contractorPlan.version));
await mustReject('Empty station evidence rejected',rd(1,'response',{note:'Please reconsider this loss'},CM));
await db.query(rd(1,'response',{note:'Delivery evidence attached for review',reason:'Delivered correctly',tt_reference:'TT-123',evidence_url:'https://example.com/cctv'},CM));
await mustReject('Self review rejected',rd(2,'approve',{note:'Evidence checked and accepted'},CM));
await mustReject('Outcome before approval rejected',rd(2,'lost',{note:'Vendor declined the dispute',tt_reference:'POST-1'}));
await db.query(rd(2,'approve',{note:'Evidence checked and accepted'}));
await db.query(rd(3,'tracking',{note:'Post dispute filed with vendor',tt_reference:'POST-1',followup_on:'2027-01-01'}));
await db.query(rd(4,'lost',{note:'Vendor declined after review',tt_reference:'POST-1',recovery_month:future}));
eq('Failed redispute stays out of earlier payroll',(await db.query(`select * from nl_loss_recovery_due('${C}','${contractorPlan.deduction_month}','hrms') where case_key='CONTRACTOR'`)).rows.length,0);
eq('Failed redispute joins selected latest payroll',(await db.query(`select * from nl_loss_recovery_due('${C}','${future}','hrms') where case_key='CONTRACTOR'`)).rows.length,1);
await mustReject('Earlier plan month cannot bypass failed redispute deferral',full('CONTRACTOR',`contractor:${CT}`,'deduct',contractorPlan.version));
eq('Original schedule/key unchanged',(await one(`select deduction_month m from nl_loss_recoveries where case_key='CONTRACTOR'`)).m,contractorPlan.deduction_month);
eq('Old mutation path disabled',(await one(`select has_function_privilege('service_role','nl_case_response_transition(uuid,text,text,integer,text,text,text,boolean,uuid,text)','execute') x`)).x,false);
await db.query(rd(5,'activate'));
await db.query(rd(6,'response',{note:'Additional delivery footage received',reason:'Delivered correctly',tt_reference:'TT-124',evidence_url:'https://example.com/cctv2'},CM));
await db.query(rd(7,'approve',{note:'Additional evidence has been checked'}));
await db.query(rd(8,'won',{note:'Vendor accepted the final evidence',tt_reference:'POST-2'}));
eq('Successful redispute stops future payroll',(await db.query(`select * from nl_loss_recovery_due('${C}','${future}','hrms') where case_key='CONTRACTOR'`)).rows.length,0);
await mustReject('Successful redispute cannot be restarted by a recovery edit',full('CONTRACTOR',`contractor:${CT}`,'deduct',contractorPlan.version));
eq('Winning stops outstanding without inventing a deduction',(await one(`select status,outstanding::text,deducted::text from nl_recovery_ledger('${C}',null,'contractor:${CT}') where case_key='CONTRACTOR'`)),{status:'redispute_won',outstanding:'0',deducted:'0'});

// PID timeline + editable plans retain all redispute payroll gates.
const pidMigration=readFileSync('supabase/migrations/20261028174523_loss_pid_history_controls.sql','utf8');
await db.exec(pidMigration); await db.exec(pidMigration);
eq('Baseline once per case',(await one(`select count(*)::int n from nl_loss_source_events where case_key='CONTRACTOR'`)).n,1);
await db.query(`update nl_loss_month_cases set last_seen_at=now(),source_updated_at=now() where case_key='CONTRACTOR'`);
eq('Refresh timestamps do not create fake changes',(await one(`select count(*)::int n from nl_loss_source_events where case_key='CONTRACTOR'`)).n,1);
await db.query(`update nl_loss_month_cases set details=details||'{"remarks":"Changed in source"}'::jsonb where case_key='CONTRACTOR'`);
eq('Source update retained',(await one(`select count(*)::int n from nl_loss_source_events where case_key='CONTRACTOR'`)).n,2);
await mustReject('Source audit immutable',`delete from nl_loss_source_events where case_key='CONTRACTOR'`);
eq('No browser role access',(await one(`select has_table_privilege('authenticated','nl_loss_source_events','select') x`)).x,false);
await mustReject('Won remains protected after migration',full('CONTRACTOR',`contractor:${CT}`,'deduct',contractorPlan.version));
await db.query(rd(9,'activate'));
const livePlan=(await one(`select version from nl_loss_recoveries where case_key='CONTRACTOR'`));
const editable=full('CONTRACTOR',`contractor:${CT}`,'deduct',livePlan.version);
// This case previously lost with a future recovery month; reset test fixture to a fresh active case.
await db.query(`update nl_case_response_windows set recovery_month=null where case_key='CONTRACTOR'`);
await db.query(editable);
eq('Edited active plan still cannot reach payroll',(await db.query(`select * from nl_loss_recovery_due('${C}','${future}','hrms') where case_key='CONTRACTOR'`)).rows.length,0);
await mustReject('Stale removal rejected',rd(9,'revoke',{note:'Enabled by mistake'}));
await db.query(`update nl_loss_month_cases set source_status='Non-recoverable',source_present=false where case_key='CONTRACTOR'`);
await db.query(rd(10,'revoke',{note:'No longer required'}));
eq('Can remove after source change',(await one(`select enabled,workflow_status from nl_case_response_windows where case_key='CONTRACTOR'`)),{enabled:false,workflow_status:'cancelled'});
eq('Removal retained in history',(await one(`select count(*)::int n from nl_case_response_events where case_key='CONTRACTOR' and action='revoke'`)).n,1);
await mustReject('Cannot erase source history',`update nl_loss_source_events set actor_name='Changed'`);
// Proactive exceptions: grants gate new schedules atomically; ordinary plans and past payroll stay unchanged.
const optionSql=readFileSync('supabase/migrations/20261028220000_loss_exception_options.sql','utf8');
await db.exec(optionSql); await db.exec(optionSql);
const grant=(key,kind,enabled=true,version=0)=>
  "select nl_loss_exception_set('"+C+"','2026-09','"+key+"','"+kind+"',"+enabled+","+version+",'Verified exception for this shipment','"+SLP+"','SLP Manager')";
await db.exec("insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values ('"+C+"','nl','2026-09','OPT','BLR1',100,'Recoverable'),('"+C+"','nl','2026-09','OPT-NEXT','BLR1',100,'Recoverable'),('"+C+"','nl','2026-09','OPT-INITIAL','BLR1',100,'Recoverable'); update nl_loss_month_cases set details='{\"extra\":{\"current_sla_stage\":\"NL2\"},\"case_status\":\"pending\"}' where case_key='OPT-INITIAL'; update nl_recovery_payables set checked_at=now();");
const recurring=(version=0,value='2')=>full('OPT','employee:'+E1,'deduct',version).replace('"mode":"full"','"mode":"installments","basis":"months","value":"'+value+'"');
await mustReject('Recurring save without enabled option is denied',recurring());
await mustReject('Deferral without enabled option is denied',full('OPT-NEXT','employee:'+E1,'next'));
await mustReject('Initial case cannot receive an exception',grant('OPT-INITIAL','installments'));
await db.query(grant('OPT','installments'));
await mustReject('Stale grant version cannot overwrite',grant('OPT','installments',false));
await db.query(recurring());
eq('Enabled recurring needs no second approval',(await one("select approval_status s from nl_loss_recoveries where case_key='OPT'")).s,'approved');
await db.query(grant('OPT','installments',false,1));
await db.query(recurring(1));
eq('Revocation preserves an existing approved schedule',(await one("select approval_status s from nl_loss_recoveries where case_key='OPT'")).s,'approved');
await mustReject('Revocation prevents changing the schedule',recurring(2,'3'));
await db.query(grant('OPT-NEXT','next_month'));
await db.query(full('OPT-NEXT','employee:'+E1,'next'));
eq('Enabled next month needs no second approval',(await one("select approval_status s from nl_loss_recoveries where case_key='OPT-NEXT'")).s,'approved');
eq('Grant pins the next applicable payroll',(await one("select deduction_month m from nl_loss_exception_options where case_key='OPT-NEXT'")).m,future);
await db.exec("update nl_loss_month_cases set amount=101 where case_key='OPT-NEXT'");
eq('Source amount changes invalidate the grant',(await one("select nl_loss_exception_allowed('"+C+"','2026-09','OPT-NEXT','next_month','"+future+"') allowed")).allowed,false);
eq('Grant events retain every successful change',(await one("select count(*)::int n from nl_loss_exception_events")).n,3);
eq('Authenticated client cannot call grant writer',(await one("select has_function_privilege('authenticated','nl_loss_exception_set(uuid,text,text,text,boolean,integer,text,uuid,text)','execute') allowed")).allowed,false);
eq('Actual payroll lines are unchanged by exception grants',(await db.query("select amount::numeric as amount,metadata->>'recovery_key' k from hr_payroll_run_items where run_person_id='"+PERSON+"'")).rows,afterClarify);

// Available-pay policy: migration is idempotent and legacy percentages cannot return.
const availablePaySql=readFileSync('supabase/migrations/20261028233017_loss_available_pay.sql','utf8');
const priorPlans=(await db.query(`select case_key,cap_override,cap_override_reason from nl_loss_recoveries order by case_key`)).rows;
await db.exec(availablePaySql); await db.exec(availablePaySql);
eq('Migration preserves historical override records',(await db.query(`select case_key,cap_override,cap_override_reason from nl_loss_recoveries order by case_key`)).rows,priorPlans);
await db.exec(`update nl_loss_sources set recovery_policy=recovery_policy||'{"salary_cap_enabled":false,"salary_cap_percent":50,"reserve_other_recoveries":true}'::jsonb;
update nl_recovery_payables set policy_updated_at=(select updated_at from nl_loss_sources),checked_at=now(),payable=1000,gross=1200;
insert into employees(id,company_id,employee_code,full_name,location_id) values('00000000-0000-0000-0000-0000000000e9','${C}','PAY9','Available Pay','${S}');
insert into nl_recovery_payables(company_id,employee_ref,salary_month,eligible,payable,gross,source,policy_updated_at)
select '${C}','employee:00000000-0000-0000-0000-0000000000e9',salary_month,true,1000,1200,'test',(select updated_at from nl_loss_sources) from nl_recovery_payables limit 1;
insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values
('${C}','nl','2026-09','PAY-80','BLR1',800,'Recoverable'),('${C}','nl','2026-09','PAY-REST','BLR1',201,'Recoverable');`);
eq('Old settings cannot restore percentage limits',(await one(`select recovery_policy->>'salary_cap_enabled' enabled,recovery_policy->>'salary_cap_percent' percent from nl_loss_sources`)),{enabled:'true',percent:'100'});
const paySave=key=>full(key,'employee:00000000-0000-0000-0000-0000000000e9').replace('"amount":"100"',`"amount":"${key==='PAY-80'?800:201}"`).replace('"mode":"full"','"mode":"full","cap_override":true,"cap_override_reason":"x"');
await db.query(paySave('PAY-80'));
eq('80 percent saves without override approval',(await one(`select approval_status,cap_override from nl_loss_recoveries where case_key='PAY-80'`)),{approval_status:'approved',cap_override:false});
await mustReject('Other plans reserve available pay',paySave('PAY-REST'));
eq('Due RPC sends 100 percent to older payroll clients',String((await one(`select cap_percent from nl_loss_recovery_due('${C}',(select deduction_month from nl_loss_recoveries where case_key='PAY-80'),'hrms') where case_key='PAY-80'`)).cap_percent),'100');
eq('Migration never changes paid history',(await db.query(`select amount::numeric as amount,metadata->>'recovery_key' k from hr_payroll_run_items where run_person_id='${PERSON}'`)).rows,afterClarify);


// People assignment is independent of salary readiness; Workforce retains save-time checks.
await db.exec(`update nl_loss_sources set recovery_policy=recovery_policy||'{"directory_ceiling_designations":["STM"],"directory_excluded_designations":["CM","CLM","AOM","NH","MP"]}'::jsonb`);
const peopleAssignmentSql=readFileSync('supabase/migrations/20261029143000_loss_people_assignment_and_managers.sql','utf8');
await db.exec(peopleAssignmentSql); await db.exec(peopleAssignmentSql);
eq('Mapped managers included, higher roles excluded',(await one(`select recovery_policy->'directory_ceiling_designations' ceiling,recovery_policy->'directory_excluded_designations' excluded from nl_loss_sources`)),{ceiling:['AOM'],excluded:['MP','NH']});
await db.exec(`update nl_recovery_payables set payable=null,gross=null,policy_updated_at=(select updated_at from nl_loss_sources),checked_at=now();
insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values
('${C}','nl','2026-09','PEOPLE-NO-PAY','BLR1',100,'Recoverable'),
('${C}','nl','2026-09','WF-NO-PAY','BLR1',100,'Recoverable'),
('${C}','nl','2026-09','PEOPLE-INACTIVE','BLR1',100,'Recoverable');`);
await db.query(full('PEOPLE-NO-PAY',`employee:${E1}`));
eq('People plan without salary is approved for payroll',(await one(`select approval_status from nl_loss_recoveries where case_key='PEOPLE-NO-PAY'`)).approval_status,'approved');
await mustReject('Workforce still needs payout eligibility',full('WF-NO-PAY',`workforce:${W1}`));
await db.exec(`update nl_recovery_payables set eligible=false where employee_ref='employee:${E1}'`);
await mustReject('People employment check remains enforced',full('PEOPLE-INACTIVE',`employee:${E1}`));

// Linked EDSP/XPT recipients must pass the same save-time scope validation.
await db.exec(`create table location_models(id uuid primary key,code text);
alter table stations add column parent_station_id uuid;
alter table stations add column location_model_id uuid;
alter table stations add column provider_id uuid;
alter table stations add column is_active boolean default true;
insert into location_models values('${uid(201)}','EDSP'),('${uid(202)}','XPT'),('${uid(203)}','AMXL');
update stations set location_model_id='${uid(201)}',provider_id='${uid(204)}' where id='${S}';
insert into stations(id,company_id,station_code,parent_station_id,location_model_id,provider_id,is_active) values
('${uid(205)}','${C}','XPT1','${S}','${uid(202)}','${uid(204)}',true),
('${uid(206)}','${C}','SIBLING','${S}','${uid(202)}','${uid(204)}',true),
('${uid(207)}','${C}','AMXL1','${S}','${uid(203)}','${uid(204)}',true),
('${uid(208)}','${C}','OTHER-PROVIDER','${S}','${uid(202)}','${uid(209)}',true),
('${uid(210)}','${C}','INACTIVE','${S}','${uid(202)}','${uid(204)}',false),
('${uid(211)}','${uid(212)}','OTHER-COMPANY','${S}','${uid(202)}','${uid(204)}',true);
insert into employees(id,company_id,employee_code,full_name,location_id) values('${uid(213)}','${C}','XPT-STAFF','Child station staff','${uid(205)}');
update nl_recovery_payables set eligible=true,checked_at=now() where employee_ref='employee:${E1}';
insert into nl_recovery_payables(company_id,employee_ref,salary_month,eligible,payable,gross,source,policy_updated_at)
select '${C}','employee:${uid(213)}',salary_month,true,null,null,'People',(select updated_at from nl_loss_sources) from nl_recovery_payables limit 1;
insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values
('${C}','nl','2026-09','PARENT-TO-CHILD','BLR1',100,'Recoverable'),
('${C}','nl','2026-09','CHILD-TO-PARENT','XPT1',100,'Recoverable');`);
const linkedDirectorySql=readFileSync('supabase/migrations/20261029160000_loss_parent_child_recipients.sql','utf8');
await db.exec(linkedDirectorySql); await db.exec(linkedDirectorySql);
eq('EDSP scope includes only active same-provider XPT children',(await db.query(`select station_code from loss_recovery_station_scope('${C}','${S}') order by station_code`)).rows.map(r=>r.station_code),['BLR1','SIBLING','XPT1']);
eq('XPT scope includes its parent but no siblings',(await db.query(`select station_code from loss_recovery_station_scope('${C}','${uid(205)}') order by station_code`)).rows.map(r=>r.station_code),['BLR1','XPT1']);
eq('Foreign company cannot resolve station',(await db.query(`select * from loss_recovery_station_scope('${uid(212)}','${S}')`)).rows.length,0);
eq('Child recipient has station label',(await one(`select station_codes from loss_recovery_people_with_locations('${C}','${S}') where ref='employee:${uid(213)}'`)).station_codes,['XPT1']);
eq('Directory returns unique recipient refs',(await one(`select count(*)=count(distinct ref) ok from loss_recovery_people_with_locations('${C}','${S}')`)).ok,true);
await db.query(full('PARENT-TO-CHILD',`employee:${uid(213)}`));
await db.query(full('CHILD-TO-PARENT',`employee:${E1}`));
eq('Parent and child staff allocations pass save validation',(await one(`select count(*)::int n from nl_loss_recoveries where case_key in ('PARENT-TO-CHILD','CHILD-TO-PARENT') and approval_status='approved'`)).n,2);

// Former staff can use a real unpaid month, without opening historical payroll globally.
await db.exec(`alter table hr_payroll_runs add column if not exists updated_at timestamptz default now();
alter table hr_payroll_run_people add column if not exists net_pay numeric default 0;
alter table hr_payroll_run_people add column if not exists adjusted_net_pay numeric;
alter table workforce add column if not exists deleted_at timestamptz;
alter table workforce add column if not exists date_of_join date;
create table if not exists hr_payroll_bank_lines(id uuid primary key default gen_random_uuid(),company_id uuid,run_id uuid,worker_id uuid,status text,amount numeric);
create table if not exists workforce_payroll_runs(id uuid primary key default gen_random_uuid(),company_id uuid,period_start date,period_end date,status text);
create table if not exists workforce_payout_payment_items(id uuid primary key default gen_random_uuid(),company_id uuid,workforce_id uuid,period_start date,period_end date,status text,instruction_amount numeric);`);
const departedSql=readFileSync('supabase/migrations/20261029183000_loss_departed_open_payroll.sql','utf8');
await db.exec(departedSql); await db.exec(departedSql);
await db.exec(`insert into hr_payroll_runs(id,company_id,period_start,period_end,status) values('${uid(501)}','${C}','2026-09-01','2026-09-30','calculated');
insert into hr_payroll_run_people(id,company_id,run_id,worker_type,worker_id,net_pay) values('${uid(502)}','${C}','${uid(501)}','employee','${uid(11)}',3000);
update hr_engagements set status='ended',end_date='2026-09-25' where employee_id='${uid(11)}';
update hr_work_assignments set effective_to='2026-09-25' where engagement_id='${uid(31)}';
update employees set is_active=false,last_working_date='2026-09-25' where id='${uid(11)}';
insert into hr_payroll_bank_lines(company_id,run_id,worker_id,status,amount) values('${C}','${uid(501)}','${uid(11)}','paid',1000);
insert into nl_recovery_payables(company_id,employee_ref,salary_month,eligible,payable,gross,source,policy_updated_at)
select '${C}','employee:${uid(11)}','2026-09',true,2000,3000,'unpaid payroll',updated_at from nl_loss_sources;
insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values('${C}','nl','2026-09','DEPARTED-OPEN','BLR1',100,'Recoverable');`);
eq('Ended People engagement reappears at its historical station',(await db.query(`select ref from loss_recovery_people('${C}','${S}') where ref='employee:${uid(11)}'`)).rows.length,1);
eq('Paid portion excluded from available pay',Number((await one(`select payable from loss_recovery_payroll_windows('${C}',array['employee:${uid(11)}']) where salary_month='2026-09'`)).payable),2000);
const departedSave=full('DEPARTED-OPEN',`employee:${uid(11)}`).replace('"mode":"full"','"mode":"full","deduction_month":"2026-09"');
await db.query(departedSave);
eq('Prior unpaid month is persisted',(await one(`select deduction_month m,approval_status s from nl_loss_recoveries where case_key='DEPARTED-OPEN'`)),{m:'2026-09',s:'proposed'});
eq('Former employee plan is not deducted before approval',(await db.query(`select * from nl_loss_recovery_due('${C}','2026-09','hrms','${uid(501)}') where case_key='DEPARTED-OPEN'`)).rows.length,0);
await db.exec(`insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values('${C}','nl','2026-09','DEPARTED-OVER','BLR1',2500,'Recoverable');`);
try { await db.query(full('DEPARTED-OVER',`employee:${uid(11)}`).replace('"amount":"100"','"amount":"2500"').replace('"mode":"full"','"mode":"full","deduction_month":"2026-09"'));eq('Over-allocation must reject',true,false); }
catch(e){eq('Over-allocation explains the available limit',/maximum available recovery/.test(e.message),true);}
await db.exec(`update nl_loss_recoveries set approval_status='approved' where case_key='DEPARTED-OPEN';update nl_loss_month_cases set lifecycle_status='recovery_approved_scheduled' where case_key='DEPARTED-OPEN'`);
eq('Explicit approved prior-month assignment is due in that payroll',(await db.query(`select * from nl_loss_recovery_due('${C}','2026-09','hrms','${uid(501)}') where case_key='DEPARTED-OPEN'`)).rows.length,1);
eq('No other old plans become September deductions',(await db.query(`select * from nl_loss_recovery_due('${C}','2026-09','hrms','${uid(501)}') where case_key<>'DEPARTED-OPEN'`)).rows.length,0);
await db.exec(`insert into hr_payroll_bank_lines(company_id,run_id,worker_id,status,amount) values('${C}','${uid(501)}','${uid(11)}','issued',50)`);
eq('Issued bank file removes open eligibility',(await one(`select loss_recovery_open_payroll('${C}','employee:${uid(11)}','2026-09') ok`)).ok,false);
await db.exec(`delete from hr_payroll_bank_lines where status='issued';update hr_payroll_runs set status='approved' where id='${uid(501)}'`);
eq('Closed payroll removes eligibility',(await one(`select loss_recovery_open_payroll('${C}','employee:${uid(11)}','2026-09') ok`)).ok,false);
await mustReject('Closed payroll cannot be reused',departedSave.replace(',0,',',1,'));
eq('Public callers cannot inspect payroll balances',(await one(`select has_function_privilege('authenticated','loss_recovery_payroll_windows(uuid,text[])','execute') allowed`)).allowed,false);

// October is the configured lower boundary, including otherwise-open unpaid salary.
const boundarySql=readFileSync('supabase/migrations/20261029190100_loss_payroll_start_boundary.sql','utf8');
const oldSnapshot=(await one(`select row_to_json(p) snapshot from hr_payroll_run_people p where id='${uid(502)}'`)).snapshot;
await db.exec(`update hr_payroll_runs set status='calculated' where id='${uid(501)}';
insert into workforce_payout_publications(company_id,workforce_id,station_id,revision,snapshot,period_start,period_end)
values('${C}','${W1}','${S}',1,'{"item":{"net_amount":1200}}','2026-09-01','2026-09-30');`);
await db.exec(boundarySql);await db.exec(boundarySql);
eq('No People or Workforce window predates configured October boundary',(await db.query(`select * from loss_recovery_payroll_windows('${C}') where salary_month<'2026-10'`)).rows.length,0);
eq('Earlier unpaid salary alone cannot re-add former People',(await db.query(`select * from loss_recovery_people_station('${C}','${S}') where ref='employee:${uid(11)}'`)).rows.length,0);
eq('Earlier approved unpaid flag cannot bypass payroll start',(await db.query(`select * from nl_loss_recovery_due('${C}','2026-09','hrms','${uid(501)}')`)).rows.length,0);
try {await db.query(departedSave.replace(',0,',',1,'));eq('September save must reject',true,false);}
catch(e){eq('September save states configured cutoff',/from 2026-10 onward only/.test(e.message),true);}
await db.exec(`insert into hr_payroll_runs(id,company_id,period_start,period_end,status) values('${uid(503)}','${C}','2026-10-01','2026-10-31','calculated');
insert into hr_payroll_run_people(id,company_id,run_id,worker_type,worker_id,net_pay) values('${uid(504)}','${C}','${uid(503)}','employee','${uid(11)}',3000);
update hr_engagements set end_date='2026-10-05' where employee_id='${uid(11)}';
update hr_work_assignments set effective_to='2026-10-05' where engagement_id='${uid(31)}';
update employees set last_working_date='2026-10-05' where id='${uid(11)}';
insert into hr_payroll_bank_lines(company_id,run_id,worker_id,status,amount) values('${C}','${uid(503)}','${uid(11)}','paid',1000);`);
eq('Former staff with October unpaid payroll remain in directory',(await db.query(`select * from loss_recovery_people_station('${C}','${S}') where ref='employee:${uid(11)}'`)).rows.length,1);
eq('October unpaid amount still excludes paid money',Number((await one(`select payable from loss_recovery_payroll_windows('${C}',array['employee:${uid(11)}']) where salary_month='2026-10'`)).payable),2000);
eq('October open payroll still selectable',(await one(`select loss_recovery_open_payroll('${C}','employee:${uid(11)}','2026-10') ok`)).ok,true);
eq('Existing payroll snapshot remains unchanged',(await one(`select row_to_json(p) snapshot from hr_payroll_run_people p where id='${uid(502)}'`)).snapshot,oldSnapshot);
eq('Boundary patch preserves private RPC permissions',(await one(`select has_function_privilege('authenticated','loss_recovery_payroll_windows(uuid,text[])','execute') allowed`)).allowed,false);

// September becomes available only after its manual-bank reconciliation.
await db.exec(`alter table workforce_payout_payment_items add column settled_amount numeric;
alter table workforce_payout_payment_items add column credited_workforce_id uuid;
create view workforce_payout_effective_paid_allocations as select company_id,
 coalesce(credited_workforce_id,workforce_id) credited_workforce_id,period_start,period_end,
 settled_amount settled_amount_snapshot from workforce_payout_payment_items where status='paid';
update nl_loss_sources set recovery_policy=jsonb_set(recovery_policy,'{payroll_start_month}','"2026-09"');
insert into workforce_payout_payment_items(company_id,workforce_id,period_start,period_end,status,instruction_amount,settled_amount)
values('${C}','${W1}','2026-09-01','2026-09-30','paid',1200,400);`);
const settlementSql=readFileSync('supabase/migrations/20261029203000_loss_payroll_settled_balance.sql','utf8');
await db.exec(settlementSql);await db.exec(settlementSql);
eq('September configured window includes unpaid People',Number((await one(`select payable from loss_recovery_payroll_windows('${C}',array['employee:${uid(11)}']) where salary_month='2026-09'`)).payable),2000);
eq('Partial settlement leaves actual unpaid salary',Number((await one(`select payable from loss_recovery_payroll_windows('${C}',array['workforce:${W1}']) where salary_month='2026-09'`)).payable),800);
await db.exec(`update workforce_payout_payment_items set credited_workforce_id='${uid(700)}'`);
eq('Transferred bank credit no longer reduces original worker balance',Number((await one(`select payable from loss_recovery_payroll_windows('${C}',array['workforce:${W1}']) where salary_month='2026-09'`)).payable),1200);
eq('August remains outside the configured boundary',(await db.query(`select * from loss_recovery_payroll_windows('${C}') where salary_month<'2026-09'`)).rows.length,0);
eq('Settlement fix preserves private RPC permissions',(await one(`select has_function_privilege('authenticated','loss_recovery_payroll_windows(uuid,text[])','execute') allowed`)).allowed,false);

// Recent leavers are independent of payroll readiness, but funding is verified atomically.
await db.exec(`alter table workforce add column if not exists designation text;
alter table workforce add column if not exists designation_id uuid;`);
const recentSql=readFileSync('supabase/migrations/20261030131516_loss_recent_departed_recovery.sql','utf8');
await db.exec(recentSql);await db.exec(recentSql);
const currentExitSql=readFileSync('supabase/migrations/20261030134028_loss_writeoff_current_exit_gate.sql','utf8');
await db.exec(currentExitSql);await db.exec(currentExitSql);
const previous=(await one("select (date_trunc('month',now() at time zone 'Asia/Kolkata')-interval '1 day')::date::text d")).d;
await db.exec(`update hr_engagements set status='ended',end_date='${previous}' where employee_id in ('${uid(11)}','${uid(12)}','${uid(13)}','${uid(14)}');
update hr_work_assignments set effective_to='${previous}' where engagement_id in ('${uid(31)}','${uid(32)}','${uid(33)}','${uid(34)}');
update employees set is_active=false,last_working_date='${previous}' where id in ('${uid(11)}','${uid(12)}','${uid(13)}','${uid(14)}');
update workforce set is_active=false,last_working_date='${previous}' where id in ('${W1}','${uid(90)}');`);
const leavers=()=>db.query(`select employee_code,designation from loss_recovery_recent_leavers('${C}','${S}')`);
const departedNames=(await leavers()).rows.map(p=>p.designation);
eq('Recent former station staff included without payroll',departedNames.includes('Station Associate'),true);
eq('Former cluster manager from historical reporting included',departedNames.includes('Cluster Manager'),true);
eq('Former AOM included',departedNames.includes('Area Operations Manager'),true);
eq('Higher roles excluded even when departed',departedNames.includes('National Head'),false);
eq('Workforce mirror not duplicated',(await leavers()).rows.some(p=>p.employee_code==='MIRROR'),false);
eq('Foreign company cannot read leavers',(await db.query(`select * from loss_recovery_recent_leavers('${uid(212)}','${S}')`)).rows.length,0);
eq('Public cannot read leavers',(await one("select has_function_privilege('authenticated','loss_recovery_recent_leavers(uuid,uuid)','execute') ok")).ok,false);
await db.exec(`insert into hr_engagements(id,company_id,person_id,employee_id,worker_code,start_date,status)
 values('${uid(850)}','${C}','${uid(22)}','${uid(12)}','REHIRE',(now() at time zone 'Asia/Kolkata')::date,'active')`);
eq('Rehired person excluded',(await leavers()).rows.some(p=>p.employee_code==='P2'),false);
await db.exec(`delete from hr_engagements where id='${uid(850)}';
update hr_engagements set end_date=(date_trunc('month',now())-interval '2 months 1 day')::date where employee_id='${uid(12)}'`);
eq('Older departures excluded',(await leavers()).rows.some(p=>p.employee_code==='P2'),false);
await db.exec(`update hr_engagements set end_date='${previous}' where employee_id='${uid(12)}';
update hr_engagements set end_date=(now() at time zone 'Asia/Kolkata')::date where employee_id='${uid(13)}'`);
eq('Current month not in previous two completed months',(await leavers()).rows.some(p=>p.employee_code==='P3'),false);
await db.exec(`update hr_engagements set end_date='${previous}' where employee_id='${uid(13)}';
insert into workforce(id,company_id,dropx_id,full_name,is_active,last_working_date,location_id)
values('${uid(851)}','${C}','XPT-LEFT','Former XPT',false,'${previous}','${uid(205)}'),
('${uid(852)}','${C}','SIB-LEFT','Former sibling',false,'${previous}','${uid(206)}')`);
eq('Parent includes former XPT staff',(await leavers()).rows.some(p=>p.employee_code==='XPT-LEFT'),true);
eq('XPT does not include sibling former staff',(await db.query(`select * from loss_recovery_recent_leavers('${C}','${uid(205)}') where employee_code='SIB-LEFT'`)).rows.length,0);
eq('XPT includes former parent staff',(await db.query(`select * from loss_recovery_recent_leavers('${C}','${uid(205)}') where employee_code='P1'`)).rows.length,1);

// Use a separate person so existing reservations from earlier tests cannot affect the example.
await db.exec(`update hr_payroll_run_people set net_pay=850 where id='${uid(502)}';
delete from hr_payroll_bank_lines where run_id='${uid(501)}';
update nl_loss_recoveries set is_deleted=true where case_key='DEPARTED-OPEN';
update nl_recovery_payables set payable=850,eligible=true,checked_at=now(),policy_updated_at=(select updated_at from nl_loss_sources)
 where employee_ref='employee:${uid(11)}' and salary_month='2026-09';
insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status)
 values('${C}','nl','2026-09','LEFT-PARTIAL','BLR1',1000,'Recoverable'),
 ('${C}','nl','2026-09','LEFT-NO-PAY','BLR1',1000,'Recoverable'),
 ('${C}','nl','2026-09','LEFT-CHANGED','BLR1',1000,'Recoverable');`);
const leftSave=(key,ref,funding=850,version=0)=>`select save_nl_recovery('${C}','2026-09','${key}',${version},'responsible_left','${funding>0?'custom':'none'}','${JSON.stringify(funding>0?[{employee_ref:ref,amount:1000}]:[])}','Departure verified; CM follows up next week','${CM}','Station','${JSON.stringify({employee_ref:ref,employee_id:'forged',employee_name:'forged',follow_up:'Cluster manager follows up next week',payroll_amount:funding})}','{"mode":"full","deduction_month":"2026-09"}')`;
await db.exec(`update hr_payroll_run_people set net_pay=750 where id='${uid(502)}'`);
await throws('Paid balance change requires fresh review',leftSave('LEFT-PARTIAL',`employee:${uid(11)}`),/salary changed/);
await db.exec(`update hr_payroll_run_people set net_pay=850 where id='${uid(502)}'`);
await db.query(leftSave('LEFT-PARTIAL',`employee:${uid(11)}`));
const partial=(await one("select allocations,recovery_details,approval_status from nl_loss_recoveries where case_key='LEFT-PARTIAL'"));
eq('Full assigned loss preserved',Number(partial.allocations[0].amount),1000);
eq('Only available salary funded',Number(partial.allocations[0].payroll_amount),850);
eq('Remaining 150 preserved for follow-up',Number(partial.recovery_details.remaining_amount),150);
eq('Saved identity is canonical',partial.recovery_details.employee_id,'P1');
eq('Former salary adjustment requires independent approval',partial.approval_status,'proposed');
eq('Funded recovery key amount is 850',Number((await one(`select amount from nl_recovery_alloc_keys('2026-09','LEFT-PARTIAL','${JSON.stringify(partial.allocations[0])}')`)).amount),850);
eq('No deduction before approval',(await db.query(`select * from nl_loss_recovery_due('${C}','2026-09','hrms') where case_key='LEFT-PARTIAL'`)).rows.length,0);
await throws('Another case cannot reuse reserved salary',leftSave('LEFT-CHANGED',`employee:${uid(11)}`),/No unpaid salary/);
await db.query(leftSave('LEFT-NO-PAY',`employee:${uid(12)}`,0));
eq('Leaver without pay retains full outstanding',Number((await one("select recovery_details->>'remaining_amount' amount from nl_loss_recoveries where case_key='LEFT-NO-PAY'")).amount),1000);
await throws('Free-text identity cannot bypass directory',leftSave('LEFT-CHANGED',`employee:${E1}`,0),/verified person/);
await db.query(`select nl_loss_recovery_approve('${C}','2026-09','LEFT-PARTIAL',1,'${SLP}','Approver','Verified unpaid balance',null)`);
eq('Approved payroll due is only 850',Number((await one(`select amount from nl_loss_recovery_due('${C}','2026-09','hrms') where case_key='LEFT-PARTIAL'`)).amount),850);
const waiveLeft=(key,ref)=>`select waive_nl_recovery_balance('${C}','2026-09','${key}','${ref}','Verified unrecoverable exit balance','${SLP}','Approver')`;
const grantLeft=(key,enabled,version)=>`select nl_loss_exception_set('${C}','2026-09','${key}','write_off',${enabled},${version},'Enable reviewed exit balance write-off','${SLP}','Approver')`;
await throws('Write-off is disabled by default',waiveLeft('LEFT-PARTIAL',`employee:${uid(11)}`),/Enable Write-off/);
await db.query(grantLeft('LEFT-PARTIAL',true,0));
await throws('Exception cannot erase funded salary before collection',waiveLeft('LEFT-PARTIAL',`employee:${uid(11)}`),/Complete the approved salary adjustment/);
await db.exec(`insert into hr_payroll_run_items(company_id,run_person_id,code,item_type,amount,metadata)
values('${C}','${uid(502)}','OPS_LOSS_RECOVERY','deduction',850,jsonb_build_object('recovery_key',nl_recovery_key('2026-09','LEFT-PARTIAL','employee:${uid(11)}')));
update hr_payroll_runs set status='approved' where id='${uid(501)}'`);
eq('Applied 850 leaves 150 in ledger',Number((await one(`select outstanding from nl_recovery_ledger('${C}',null,'employee:${uid(11)}') where case_key='LEFT-PARTIAL'`)).outstanding),150);
eq('No duplicate debit after payroll applies key',(await db.query(`select * from nl_loss_recovery_due('${C}','2026-09','hrms') where case_key='LEFT-PARTIAL'`)).rows.length,0);
await db.query(grantLeft('LEFT-PARTIAL',false,1));
await throws('Revoking exception blocks write-off',waiveLeft('LEFT-PARTIAL',`employee:${uid(11)}`),/Enable Write-off/);
await db.query(grantLeft('LEFT-PARTIAL',true,2));
await db.exec("update nl_loss_month_cases set amount=1001 where case_key='LEFT-PARTIAL'");
await throws('Source changes invalidate write-off exception',waiveLeft('LEFT-PARTIAL',`employee:${uid(11)}`),/Enable Write-off/);
await db.exec("update nl_loss_month_cases set amount=1000 where case_key='LEFT-PARTIAL'");
await db.exec("update nl_loss_month_cases set source_present=false where case_key='LEFT-PARTIAL'");
await throws('Missing source blocks enabled write-off',waiveLeft('LEFT-PARTIAL',`employee:${uid(11)}`),/current exit balance/);
await db.exec("update nl_loss_month_cases set source_present=true where case_key='LEFT-PARTIAL'");
await db.exec(`insert into nl_case_response_windows(company_id,month,case_key,enabled,workflow_status) values('${C}','2026-09','LEFT-PARTIAL',true,'awaiting_station')`);
await throws('Active redispute blocks enabled write-off',waiveLeft('LEFT-PARTIAL',`employee:${uid(11)}`),/current exit balance/);
await db.exec("delete from nl_case_response_windows where case_key='LEFT-PARTIAL'");
await db.query(waiveLeft('LEFT-PARTIAL',`employee:${uid(11)}`));
eq('Only remaining 150 written off',Number((await one("select amount from nl_recovery_waivers where case_key='LEFT-PARTIAL'")).amount),150);
eq('Recovered 850 is preserved after residual write-off',Number((await one(`select deducted from nl_recovery_ledger('${C}',null,'employee:${uid(11)}') where case_key='LEFT-PARTIAL'`)).deducted),850);
eq('No-pay departure appears in ledger',(await db.query(`select * from nl_recovery_ledger('${C}',null,'employee:${uid(12)}') where case_key='LEFT-NO-PAY'`)).rows.length,1);
await db.query(`select nl_loss_recovery_approve('${C}','2026-09','LEFT-NO-PAY',1,'${SLP}','Approver','Verified departure',null)`);
await db.query(grantLeft('LEFT-NO-PAY',true,0));
await db.query(waiveLeft('LEFT-NO-PAY',`employee:${uid(12)}`));
eq('No-pay balance write-off uses explicit exception',Number((await one("select amount from nl_recovery_waivers where case_key='LEFT-NO-PAY'")).amount),1000);
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);

