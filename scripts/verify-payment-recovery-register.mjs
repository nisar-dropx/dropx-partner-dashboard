import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "20261008143605_payment_recovery_register.sql"
);
const indexMigrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "20261008160000_payment_recovery_fk_indexes.sql"
);

const db = new PGlite();
const ids = {
  company: "00000000-0000-4000-8000-000000000001",
  provider: "00000000-0000-4000-8000-000000000002",
  otherProvider: "00000000-0000-4000-8000-000000000010",
  station: "00000000-0000-4000-8000-000000000003",
  actor: "00000000-0000-4000-8000-000000000004",
  owner: "00000000-0000-4000-8000-000000000005",
  employee: "00000000-0000-4000-8000-000000000006",
  contractor: "00000000-0000-4000-8000-000000000007",
  workforce: "00000000-0000-4000-8000-000000000008",
  pendingEmployee: "00000000-0000-4000-8000-000000000009",
  canonicalMirror: "00000000-0000-4000-8000-000000000011",
  inactiveDuplicate: "00000000-0000-4000-8000-000000000012",
  deletedDuplicate: "00000000-0000-4000-8000-000000000013",
  reclassifiedDuplicate: "00000000-0000-4000-8000-000000000014",
  movedDuplicate: "00000000-0000-4000-8000-000000000015",
  inactiveStation: "00000000-0000-4000-8000-000000000016",
  inactiveStationEmployee: "00000000-0000-4000-8000-000000000017",
  pendingInactiveStationEmployee: "00000000-0000-4000-8000-000000000018"
};

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create table auth.users(id uuid primary key);

  create table public.companies(id uuid primary key);
  create table public.providers(
    id uuid primary key,
    company_id uuid references public.companies(id),
    code text not null unique,
    name text not null,
    is_active boolean not null default true
  );
  create table public.stations(
    id uuid primary key,
    company_id uuid references public.companies(id),
    provider_id uuid references public.providers(id),
    station_code text not null unique,
    station_name text,
    is_active boolean not null default true
  );
  create unique index stations_company_id_id_uidx on public.stations(company_id, id);

  create table public.employees(
    id uuid primary key,
    company_id uuid,
    employee_code text,
    full_name text not null,
    location_id uuid,
    is_active boolean not null default true,
    deleted_at timestamptz
  );
  create table public.contractors(
    id uuid primary key,
    company_id uuid,
    dropx_id text,
    full_name text not null,
    location_id uuid,
    is_active boolean not null default true,
    deleted_at timestamptz
  );
  create table public.workforce(
    id uuid primary key,
    company_id uuid not null,
    dropx_id text,
    full_name text not null,
    location_id uuid not null,
    source_profile_type text not null default 'workforce',
    source_profile_id uuid not null,
    is_active boolean not null default true,
    migration_state text not null default 'canonical',
    deleted_at timestamptz
  );
  create unique index workforce_company_id_id_uidx on public.workforce(company_id, id);
  create table public.helpers(id uuid primary key, company_id uuid, dropx_id text, full_name text);
  create table public.vendors(id uuid primary key, company_id uuid, dropx_id text, full_name text);
  create table public.workforce_helpers(id uuid primary key, company_id uuid, dropx_id text, full_name text);
  create table public.workforce_pickers(id uuid primary key, company_id uuid, dropx_id text, full_name text);

  create or replace function public.normalize_people_dropx_id(p_value text)
  returns text language sql immutable parallel safe returns null on null input set search_path = '' as $$
    select nullif(
      pg_catalog.regexp_replace(pg_catalog.upper(pg_catalog.btrim(p_value)), '[[:space:]]+', '', 'g'),
      ''
    )
  $$;

  create table public.app_pages(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    code text not null,
    name text not null,
    sort_order integer not null,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(company_id, code)
  );
  create table public.user_roles(
    id uuid primary key,
    company_id uuid not null,
    code text not null,
    is_active boolean not null default true
  );
  create table public.role_page_permissions(
    company_id uuid not null,
    role_id uuid not null,
    page_id uuid not null,
    can_view boolean not null default false,
    can_add boolean not null default false,
    can_edit boolean not null default false,
    unique(company_id, role_id, page_id)
  );
`);

await db.query(`insert into public.companies(id) values ($1)`, [ids.company]);
await db.query(`insert into auth.users(id) values ($1)`, [ids.actor]);
await db.query(`insert into public.user_roles(id,company_id,code) values ($1,$2,'OWNER')`, [ids.owner, ids.company]);

const [migration, indexMigration] = await Promise.all([
  readFile(migrationPath, "utf8"),
  readFile(indexMigrationPath, "utf8")
]);
await db.exec(migration);
await db.exec(indexMigration);

await db.query(
  `insert into public.providers(id,company_id,code,name) values ($1,$2,'P1','Provider One')`,
  [ids.provider, ids.company]
);
await db.query(
  `insert into public.providers(id,company_id,code,name) values ($1,$2,'P2','Provider Two')`,
  [ids.otherProvider, ids.company]
);
await db.query(
  `insert into public.stations(id,company_id,provider_id,station_code,station_name)
   values ($1,$2,$3,'LOC1','Location One')`,
  [ids.station, ids.company, ids.provider]
);
await db.query(
  `insert into public.stations(id,company_id,provider_id,station_code,station_name,is_active)
   values ($1,$2,$3,'OLDLOC','Historical location',false)`,
  [ids.inactiveStation, ids.company, ids.provider]
);
await db.query(
  `insert into public.employees(id,company_id,employee_code,full_name,location_id)
   values ($1,$2,'EMP1','Employee One',$3)`,
  [ids.employee, ids.company, ids.station]
);
await db.query(
  `insert into public.employees(id,company_id,employee_code,full_name,location_id)
   values ($1,$2,'INACTIVELOC','Inactive-station employee',$3)`,
  [ids.inactiveStationEmployee, ids.company, ids.inactiveStation]
);
await db.query(
  `insert into public.contractors(id,company_id,dropx_id,full_name,location_id)
   values ($1,$2,'CON1','Contractor One',$3)`,
  [ids.contractor, ids.company, ids.station]
);
await db.query(
  `insert into public.workforce(id,company_id,dropx_id,full_name,location_id,source_profile_id)
   values ($1,$2,'WF1','Workforce One',$3,$1)`,
  [ids.workforce, ids.company, ids.station]
);
await db.query(
  `insert into public.workforce(
     id,company_id,dropx_id,full_name,location_id,source_profile_type,source_profile_id,migration_state
   ) values ($1,$2,'EMP1','Employee One mirror',$3,'employee',$4,'mirrored')`,
  [ids.canonicalMirror, ids.company, ids.station, ids.employee]
);
await db.query(
  `insert into public.contractors(
     id,company_id,dropx_id,full_name,location_id,is_active
   ) values ($1,$2,'EMP1','Inactive duplicate',$3,false)`,
  [ids.inactiveDuplicate, ids.company, ids.station]
);
await db.query(
  `insert into public.employees(
     id,company_id,employee_code,full_name,location_id,deleted_at
   ) values ($1,$2,'EMP1','Deleted duplicate',$3,now())`,
  [ids.deletedDuplicate, ids.company, ids.station]
);
await db.query(
  `insert into public.workforce(
     id,company_id,dropx_id,full_name,location_id,source_profile_id,migration_state
   ) values ($1,$2,'EMP1','Reclassified duplicate',$3,$1,'reclassified')`,
  [ids.reclassifiedDuplicate, ids.company, ids.station]
);
await db.query(
  `insert into public.workforce(
     id,company_id,dropx_id,full_name,location_id,source_profile_id,migration_state
   ) values ($1,$2,'EMP1','Moved duplicate',$3,$1,'moved_to_vendor')`,
  [ids.movedDuplicate, ids.company, ids.station]
);

const rows = [
  {
    row_number: 2,
    tid: "TID-001",
    provider_code: "P1",
    location: "LOC1",
    debit_date: "2026-10-08",
    debit_amount: 100.01,
    recovery_method: "payout_deduction",
    provider_reference: "REF-1",
    reason: "Test debit",
    remark: "Equal split",
    targets: [{ dropx_id: "WF1" }, { dropx_id: "EMP1" }, { dropx_id: "CON1" }]
  },
  {
    row_number: 3,
    tid: "TID-002",
    provider_code: "P1",
    location: "LOC1",
    debit_date: "2026-10-08",
    debit_amount: 25,
    recovery_method: "post_invoice_dispute",
    targets: []
  }
];

const firstImport = await db.query(
  `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null) result`,
  [ids.company, "recoveries.xlsx", "a".repeat(64), JSON.stringify(rows), ids.actor]
);
assert.equal(firstImport.rows[0].result.replayed, false);
assert.equal(firstImport.rows[0].result.cases, 2);
assert.equal(firstImport.rows[0].result.allocations, 3);

const totals = await db.query(`
  select recovery.tid,
         recovery.status,
         recovery.debit_amount::text debit_amount,
         coalesce(sum(allocation.allocation_amount), 0)::text allocated
  from public.payment_recovery_cases recovery
  left join public.payment_recovery_allocations allocation
    on allocation.company_id = recovery.company_id
   and allocation.recovery_case_id = recovery.id
  group by recovery.id
  order by recovery.tid
`);
assert.deepEqual(totals.rows, [
  { tid: "TID-001", status: "ready_for_deduction", debit_amount: "100.01", allocated: "100.01" },
  { tid: "TID-002", status: "planned_provider_dispute", debit_amount: "25.00", allocated: "0" }
]);

const allocations = await db.query(`
  select imported_dropx_id, allocation_amount::text allocation_amount, target_type,
         workforce_id::text workforce_id
  from public.payment_recovery_allocations
  order by allocation_order
`);
assert.deepEqual(allocations.rows, [
  { imported_dropx_id: "CON1", allocation_amount: "33.34", target_type: "contractor", workforce_id: null },
  { imported_dropx_id: "EMP1", allocation_amount: "33.34", target_type: "employee", workforce_id: ids.canonicalMirror },
  { imported_dropx_id: "WF1", allocation_amount: "33.33", target_type: "workforce", workforce_id: ids.workforce }
]);

const replay = await db.query(
  `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null) result`,
  [ids.company, "recoveries.xlsx", "a".repeat(64), JSON.stringify(rows), ids.actor]
);
assert.equal(replay.rows[0].result.replayed, true);

const providerMismatchRows = [{
  ...rows[1],
  row_number: 2,
  tid: "TID-PROVIDER-MISMATCH",
  provider_code: "P2"
}];
await assert.rejects(
  db.query(
    `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
    [ids.company, "provider-mismatch.xlsx", "f".repeat(64), JSON.stringify(providerMismatchRows), ids.actor]
  ),
  /does not belong to provider/
);

const historicalDebitStationRows = [{
  ...rows[1],
  row_number: 2,
  tid: "TID-HISTORICAL-DEBIT-STATION",
  location: "OLDLOC"
}];
const historicalDebitStation = await db.query(
  `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null) result`,
  [ids.company, "historical-station.xlsx", "0".repeat(64), JSON.stringify(historicalDebitStationRows), ids.actor]
);
assert.equal(historicalDebitStation.rows[0].result.cases, 1);
const historicalDebitStatus = await db.query(`
  select status
  from public.payment_recovery_cases
  where tid = 'TID-HISTORICAL-DEBIT-STATION'
`);
assert.equal(historicalDebitStatus.rows[0].status, "planned_provider_dispute");

const inactiveTargetStationRows = [{
  ...rows[0],
  row_number: 2,
  tid: "TID-INACTIVE-TARGET-STATION",
  debit_amount: 10,
  targets: [{ dropx_id: "INACTIVELOC" }]
}];
await assert.rejects(
  db.query(
    `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
    [ids.company, "inactive-target-station.xlsx", "1".repeat(64), JSON.stringify(inactiveTargetStationRows), ids.actor]
  ),
  /not assigned to an active payment location/
);

const pendingInactiveStationRows = [{
  ...rows[0],
  row_number: 2,
  tid: "TID-PENDING-INACTIVE-STATION",
  debit_amount: 10,
  targets: [{ dropx_id: "PENDING-OLDLOC" }]
}];
await db.query(
  `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
  [ids.company, "pending-inactive-station.xlsx", "2".repeat(64), JSON.stringify(pendingInactiveStationRows), ids.actor]
);
await db.query(
  `insert into public.employees(id,company_id,employee_code,full_name,location_id)
   values ($1,$2,'PENDING-OLDLOC','Pending historical employee',$3)`,
  [ids.pendingInactiveStationEmployee, ids.company, ids.inactiveStation]
);
const pendingAtInactiveStation = await db.query(`
  select recovery.status, allocation.link_status
  from public.payment_recovery_cases recovery
  join public.payment_recovery_allocations allocation
    on allocation.recovery_case_id = recovery.id
  where recovery.tid = 'TID-PENDING-INACTIVE-STATION'
`);
assert.deepEqual(pendingAtInactiveStation.rows[0], {
  status: "awaiting_registration",
  link_status: "pending"
});

await db.query(`update public.stations set is_active = true where id = $1`, [ids.inactiveStation]);
await db.query(
  `update public.employees set location_id = location_id where id = $1`,
  [ids.pendingInactiveStationEmployee]
);
const linkedAfterStationActivation = await db.query(`
  select recovery.status, allocation.link_status, allocation.target_id::text target_id
  from public.payment_recovery_cases recovery
  join public.payment_recovery_allocations allocation
    on allocation.recovery_case_id = recovery.id
  where recovery.tid = 'TID-PENDING-INACTIVE-STATION'
`);
assert.deepEqual(linkedAfterStationActivation.rows[0], {
  status: "ready_for_deduction",
  link_status: "linked",
  target_id: ids.pendingInactiveStationEmployee
});

const importedReferences = await db.query(`
  select recovery.tid, recovery.id::text recovery_case_id,
         allocation.id::text allocation_id
  from public.payment_recovery_cases recovery
  left join public.payment_recovery_allocations allocation
    on allocation.company_id = recovery.company_id
   and allocation.recovery_case_id = recovery.id
  where recovery.tid in ('TID-001', 'TID-002')
  order by recovery.tid, allocation.allocation_order
`);
const payoutReference = importedReferences.rows.find((row) => row.tid === "TID-001");
const disputeReference = importedReferences.rows.find((row) => row.tid === "TID-002");
assert.ok(payoutReference?.allocation_id);
assert.ok(disputeReference?.recovery_case_id);
await db.query(
  `insert into public.payment_recovery_events(
     company_id,recovery_case_id,allocation_id,event_type,amount
   ) values ($1,$2,$3,'payout_deduction',1)`,
  [ids.company, payoutReference.recovery_case_id, payoutReference.allocation_id]
);
await assert.rejects(
  db.query(
    `insert into public.payment_recovery_events(
       company_id,recovery_case_id,allocation_id,event_type,amount
     ) values ($1,$2,$3,'payout_deduction',1)`,
    [ids.company, disputeReference.recovery_case_id, payoutReference.allocation_id]
  ),
  /payment_recovery_events_allocation_case_company_fk|foreign key/i
);

const pendingRows = [{
  row_number: 2,
  tid: "TID-003",
  provider_code: "P1",
  location: "LOC1",
  debit_date: "2026-10-08",
  debit_amount: 10,
  recovery_method: "payout_deduction",
  targets: [{ dropx_id: "NEW1" }]
}];
await db.query(
  `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
  [ids.company, "pending.xlsx", "c".repeat(64), JSON.stringify(pendingRows), ids.actor]
);
const pendingBeforeLink = await db.query(`
  select recovery.status, allocation.link_status
  from public.payment_recovery_cases recovery
  join public.payment_recovery_allocations allocation on allocation.recovery_case_id = recovery.id
  where recovery.tid = 'TID-003'
`);
assert.deepEqual(pendingBeforeLink.rows[0], { status: "awaiting_registration", link_status: "pending" });

await db.query(
  `insert into public.employees(id,company_id,employee_code,full_name,location_id,is_active)
   values ($1,$2,'NEW1','New Employee',$3,false)`,
  [ids.pendingEmployee, ids.company, ids.station]
);
const pendingWhileInactive = await db.query(`
  select recovery.status, allocation.link_status
  from public.payment_recovery_cases recovery
  join public.payment_recovery_allocations allocation on allocation.recovery_case_id = recovery.id
  where recovery.tid = 'TID-003'
`);
assert.deepEqual(pendingWhileInactive.rows[0], { status: "awaiting_registration", link_status: "pending" });

await db.query(`update public.employees set is_active = true where id = $1`, [ids.pendingEmployee]);
const pendingAfterLink = await db.query(`
  select recovery.status, allocation.link_status, allocation.target_type,
         allocation.target_id::text target_id
  from public.payment_recovery_cases recovery
  join public.payment_recovery_allocations allocation on allocation.recovery_case_id = recovery.id
  where recovery.tid = 'TID-003'
`);
assert.deepEqual(pendingAfterLink.rows[0], {
  status: "ready_for_deduction",
  link_status: "linked",
  target_type: "employee",
  target_id: ids.pendingEmployee
});

const tooSmall = [{
  ...pendingRows[0],
  tid: "TID-004",
  debit_amount: 0.01,
  targets: [{ dropx_id: "EMP1" }, { dropx_id: "CON1" }]
}];
await assert.rejects(
  db.query(
    `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
    [ids.company, "too-small.xlsx", "d".repeat(64), JSON.stringify(tooSmall), ids.actor]
  ),
  /too small to split/
);

const restrictedUnknown = [{ ...pendingRows[0], tid: "TID-005", targets: [{ dropx_id: "UNKNOWN2" }] }];
await assert.rejects(
  db.query(
    `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,array[$6]::uuid[])`,
    [ids.company, "restricted.xlsx", "e".repeat(64), JSON.stringify(restrictedUnknown), ids.actor, ids.station]
  ),
  /Company-wide access is required/
);

await assert.rejects(
  db.query(
    `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
    [ids.company, "other.xlsx", "b".repeat(64), JSON.stringify([rows[0]]), ids.actor]
  ),
  /already in the Recovery register/
);

const ownerPermission = await db.query(`
  select permission.can_view, permission.can_add, permission.can_edit
  from public.role_page_permissions permission
  join public.app_pages page on page.id = permission.page_id
  where page.code = 'payment_recoveries' and permission.role_id = $1
`, [ids.owner]);
assert.deepEqual(ownerPermission.rows[0], { can_view: true, can_add: true, can_edit: true });

const identityMutexTriggers = await db.query(`
  select count(*)::integer count
  from pg_catalog.pg_trigger trigger
  join pg_catalog.pg_class relation on relation.oid = trigger.tgrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where not trigger.tgisinternal
    and trigger.tgname = 'a00_payment_recovery_identity_mutex'
    and namespace.nspname = 'public'
    and relation.relname in ('employees', 'contractors', 'workforce')
`);
assert.equal(identityMutexTriggers.rows[0].count, 3);

const lockFunctions = await db.query(`
  select routine.proname, routine.prosrc
  from pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
  where namespace.nspname = 'public'
    and routine.proname in (
      'lock_payment_recovery_people_transition',
      'payment_recovery_apply_import'
    )
`);
const lockSourceByName = new Map(lockFunctions.rows.map((row) => [row.proname, row.prosrc]));
assert.match(lockSourceByName.get("lock_payment_recovery_people_transition") ?? "", /:dropx:/);
assert.match(lockSourceByName.get("lock_payment_recovery_people_transition") ?? "", /pg_advisory_xact_lock/);
assert.match(lockSourceByName.get("payment_recovery_apply_import") ?? "", /:dropx:/);
assert.match(lockSourceByName.get("payment_recovery_apply_import") ?? "", /pg_advisory_xact_lock/);

await db.close();
console.log("Payment Recovery register migration verified.");
