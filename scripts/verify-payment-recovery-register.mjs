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
const debitMonthMigrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "20261008162946_payment_recovery_debit_month_provider_inference.sql"
);
const configurationMigrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "20261008173113_payment_recovery_post_upload_configuration.sql"
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
  pendingInactiveStationEmployee: "00000000-0000-4000-8000-000000000018",
  unmappedProviderStation: "00000000-0000-4000-8000-000000000019",
  payrollRun: "00000000-0000-4000-8000-000000000020",
  payrollEmployeePerson: "00000000-0000-4000-8000-000000000021",
  payrollContractorPerson: "00000000-0000-4000-8000-000000000022",
  workforcePaymentMethod: "00000000-0000-4000-8000-000000000023",
  workforcePaymentAllocation: "00000000-0000-4000-8000-000000000024",
  payrollInactiveStationPerson: "00000000-0000-4000-8000-000000000025",
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

const [migration, indexMigration, debitMonthMigration, configurationMigration] = await Promise.all([
  readFile(migrationPath, "utf8"),
  readFile(indexMigrationPath, "utf8"),
  readFile(debitMonthMigrationPath, "utf8"),
  readFile(configurationMigrationPath, "utf8")
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
  `insert into public.stations(id,company_id,provider_id,station_code,station_name)
   values ($1,$2,null,'NOPROV','Location without provider')`,
  [ids.unmappedProviderStation, ids.company]
);
await db.query(
  `insert into public.payment_recovery_cases(
     company_id,tid,provider_id,station_id,debit_date,debit_amount,
     recovery_method,status,provider_code_snapshot,provider_name_snapshot,
     station_code_snapshot,source_type,created_by,updated_by
   ) values ($1,'TID-HISTORICAL-MONTH',$2,$3,'2026-09-18',5,
     'post_invoice_dispute','planned_provider_dispute','P1','Provider One',
     'LOC1','manual',$4,$4)`,
  [ids.company, ids.provider, ids.station, ids.actor]
);
await db.exec(debitMonthMigration);
const migratedHistoricalMonth = await db.query(`
  select debit_month::text debit_month
  from public.payment_recovery_cases
  where tid = 'TID-HISTORICAL-MONTH'
`);
assert.equal(migratedHistoricalMonth.rows[0].debit_month, "2026-09-01");

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
    location: "LOC1",
    debit_month: "2026-10-01",
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
    location: "LOC1",
    debit_month: "2026-10-01",
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
         recovery.debit_month::text debit_month,
         recovery.provider_code_snapshot,
         recovery.provider_reference,
         recovery.debit_amount::text debit_amount,
         coalesce(sum(allocation.allocation_amount), 0)::text allocated
  from public.payment_recovery_cases recovery
  left join public.payment_recovery_allocations allocation
    on allocation.company_id = recovery.company_id
   and allocation.recovery_case_id = recovery.id
  where recovery.tid in ('TID-001', 'TID-002')
  group by recovery.id
  order by recovery.tid
`);
assert.deepEqual(totals.rows, [
  { tid: "TID-001", status: "ready_for_deduction", debit_month: "2026-10-01", provider_code_snapshot: "P1", provider_reference: "REF-1", debit_amount: "100.01", allocated: "100.01" },
  { tid: "TID-002", status: "planned_provider_dispute", debit_month: "2026-10-01", provider_code_snapshot: "P1", provider_reference: null, debit_amount: "25.00", allocated: "0" }
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

const providerInputIgnoredRows = [{
  ...rows[1],
  row_number: 2,
  tid: "TID-PROVIDER-INFERRED",
  provider_code: "P2"
}];
await db.query(
  `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
  [ids.company, "provider-inferred.xlsx", "f".repeat(64), JSON.stringify(providerInputIgnoredRows), ids.actor]
);
const inferredProvider = await db.query(`
  select provider_code_snapshot
  from public.payment_recovery_cases
  where tid = 'TID-PROVIDER-INFERRED'
`);
assert.equal(inferredProvider.rows[0].provider_code_snapshot, "P1");

// Keep the database rollout compatible with the previously deployed API until
// the matching application release is live. The legacy date is normalized to
// its month and the provider input remains ignored in favor of LOCATION.
const legacyDateRows = [{
  row_number: 2,
  tid: "TID-LEGACY-DATE",
  provider_code: "P2",
  location: "LOC1",
  debit_date: "2026-08-19",
  debit_amount: 12,
  recovery_method: "post_invoice_dispute",
  targets: []
}];
await db.query(
  `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
  [ids.company, "legacy-date.xlsx", "5".repeat(64), JSON.stringify(legacyDateRows), ids.actor]
);
const legacyDateImport = await db.query(`
  select debit_date::text debit_date,
         debit_month::text debit_month,
         provider_code_snapshot
  from public.payment_recovery_cases
  where tid = 'TID-LEGACY-DATE'
`);
assert.deepEqual(legacyDateImport.rows[0], {
  debit_date: "2026-08-01",
  debit_month: "2026-08-01",
  provider_code_snapshot: "P1"
});

const unmappedProviderRows = [{
  ...rows[1],
  row_number: 2,
  tid: "TID-NO-PROVIDER",
  location: "NOPROV"
}];
await assert.rejects(
  db.query(
    `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
    [ids.company, "no-provider.xlsx", "3".repeat(64), JSON.stringify(unmappedProviderRows), ids.actor]
  ),
  /is not linked to a provider/
);

const nonCanonicalMonthRows = [{
  ...rows[1],
  row_number: 2,
  tid: "TID-BAD-MONTH",
  debit_month: "2026-10-08"
}];
await assert.rejects(
  db.query(
    `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
    [ids.company, "bad-month.xlsx", "4".repeat(64), JSON.stringify(nonCanonicalMonthRows), ids.actor]
  ),
  /must be the first day of its month/
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
  location: "LOC1",
  debit_month: "2026-10-01",
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

// Minimal canonical payout schemas used by the post-upload configuration
// migration. The register tests above intentionally exercise the legacy state
// first so this also verifies a forward migration with existing cases.
await db.exec(`
  create table public.workforce_deduction_heads(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id),
    code text not null,
    name text not null,
    description text,
    calculation_type text not null,
    default_value numeric not null default 0,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    applies_to_all boolean not null default false,
    is_system boolean not null default false,
    percentage_without_pan numeric not null default 0,
    workforce_category_codes text[] not null default '{}',
    unique(company_id, code)
  );

  create table public.workforce_payout_deduction_values(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id),
    deduction_head_id uuid not null references public.workforce_deduction_heads(id),
    workforce_id uuid not null,
    station_id uuid not null,
    head_code_snapshot text not null,
    head_name_snapshot text not null,
    effective_from date not null,
    effective_to date not null,
    amount numeric(18,2) not null,
    source_type text not null,
    source_batch_id uuid,
    source_row_id uuid,
    import_metadata jsonb not null default '{}',
    created_by uuid,
    updated_by uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint workforce_payout_deduction_values_exact_period_unique
      unique(company_id,deduction_head_id,workforce_id,effective_from,effective_to),
    constraint workforce_payout_deduction_values_source_check
      check(source_type in ('bulk_import','advance_register')),
    constraint workforce_payout_deduction_values_source_shape_check
      check(
        (source_type='bulk_import' and source_batch_id is not null and source_row_id is not null)
        or (source_type='advance_register' and source_batch_id is null and source_row_id is null)
      )
  );

  create table public.workforce_payment_allocations(
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid not null,
    station_id uuid,
    payment_method_id uuid not null,
    effective_from date not null,
    effective_to date,
    status text not null
  );
  create table public.field_executive_provider_mappings(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    workforce_id uuid,
    employee_id uuid,
    contractor_id uuid,
    field_executive_id uuid,
    station_id uuid,
    payment_method_id uuid,
    effective_from date not null,
    effective_to date,
    status text not null
  );
  create table public.workforce_payroll_runs(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    period_start date not null,
    period_end date not null,
    station_id uuid,
    status text not null
  );
  create table public.workforce_payout_review_submissions(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    subject_type text not null,
    subject_id uuid not null,
    location_id uuid not null,
    period_start date not null,
    period_end date not null,
    status text not null
  );
  create table public.workforce_payout_publications(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    payroll_run_id uuid,
    workforce_id uuid not null,
    station_id uuid not null,
    period_start date,
    period_end date
  );

  create table public.hr_payroll_runs(
    id uuid primary key,
    company_id uuid not null,
    period_start date not null,
    period_end date not null,
    status text not null,
    published_at timestamptz,
    deduction_total numeric not null default 0,
    net_total numeric not null default 0,
    calculated_by uuid,
    calculated_at timestamptz,
    updated_at timestamptz not null default now(),
    unique(company_id,id)
  );
  create table public.hr_payroll_run_people(
    id uuid primary key,
    company_id uuid not null,
    run_id uuid not null,
    worker_type text not null,
    worker_id uuid not null,
    worker_code text,
    worker_name text not null,
    location_id uuid,
    statutory_deductions numeric not null default 0,
    attendance_deductions numeric not null default 0,
    other_deductions numeric not null default 0,
    net_pay numeric not null default 0,
    adjusted_net_pay numeric,
    is_adjusted boolean not null default false,
    calculation_status text not null default 'ready',
    calculation_snapshot jsonb not null default '{}',
    unique(company_id,id),
    unique(run_id,worker_type,worker_id)
  );
  create table public.hr_payroll_run_manual_entries(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    run_id uuid not null,
    worker_type text not null,
    worker_id uuid not null,
    worker_code text,
    exception_debit numeric,
    exception_debit_reason text,
    source_file_name text,
    applied_by uuid,
    applied_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(company_id,run_id,worker_type,worker_id)
  );
  create table public.hr_payroll_run_items(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    run_person_id uuid not null,
    code text not null,
    name text not null,
    item_type text not null,
    amount numeric not null,
    source text not null,
    display_order integer not null,
    metadata jsonb not null default '{}'
  );

  create or replace function public.workforce_additional_payment_location_is_authorized(
    p_company_id uuid,p_workforce_id uuid,p_station_id uuid,p_from date,p_to date
  ) returns boolean language sql stable set search_path='' as $$ select true $$;
  create or replace function public.lock_workforce_payment_allocation_company(p_company_id uuid)
  returns void language plpgsql set search_path='' as $$ begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_company_id::text || ':allocation',0));
  end $$;
  create or replace function public.workforce_advance_recovery_snapshot_hash(
    p_company_id uuid,p_period_start date,p_period_end date
  ) returns text language sql stable security definer set search_path='' as $$
    select 'recovery-test-snapshot'::text
  $$;
  create or replace function public.prepare_workforce_payout_deduction_value()
  returns trigger language plpgsql set search_path='' as $$ begin return new; end $$;
  create trigger workforce_payout_deduction_values_00_prepare
    before insert or update on public.workforce_payout_deduction_values
    for each row execute function public.prepare_workforce_payout_deduction_value();
`);

await db.exec(configurationMigration);

const migratedLegacyCases = await db.query(`
  select tid,recovery_method,status,payout_month::text payout_month,configured_at is not null configured
  from public.payment_recovery_cases
  where tid in ('TID-001','TID-002')
  order by tid
`);
assert.deepEqual(migratedLegacyCases.rows, [
  { tid: "TID-001", recovery_method: "payout_deduction", status: "ready_for_deduction", payout_month: "2026-10-01", configured: true },
  { tid: "TID-002", recovery_method: "post_invoice_dispute", status: "planned_provider_dispute", payout_month: null, configured: true }
]);

await db.query(
  `insert into public.workforce_payment_allocations(
     id,company_id,workforce_id,station_id,payment_method_id,effective_from,effective_to,status
   ) values ($1,$2,$3,$4,$5,'2026-10-01','2026-10-31','active')`,
  [ids.workforcePaymentAllocation, ids.company, ids.workforce, ids.station, ids.workforcePaymentMethod]
);
// Historical month payout rows remain eligible after the profile itself is
// inactive; the exact-month payment allocation is the source of truth.
await db.query(`update public.workforce set is_active=false where id=$1`, [ids.workforce]);
await db.query(
  `insert into public.hr_payroll_runs(
     id,company_id,period_start,period_end,status,deduction_total,net_total
   ) values ($1,$2,'2026-10-01','2026-10-31','calculated',0,2000)`,
  [ids.payrollRun, ids.company]
);
await db.query(
  `insert into public.hr_payroll_run_people(
     id,company_id,run_id,worker_type,worker_id,worker_code,worker_name,location_id,
     net_pay,adjusted_net_pay,is_adjusted
   ) values
   ($1,$3,$4,'employee',$5,'EMP1','Employee One',$7,1000,2500,false),
   ($2,$3,$4,'contractor',$6,'CON1','Contractor One',$7,1000,1200,true)`,
  [ids.payrollEmployeePerson, ids.payrollContractorPerson, ids.company, ids.payrollRun, ids.employee, ids.contractor, ids.station]
);

const targetRows = await db.query(`
  select dropx_id,target_type,payout_engine,is_editable,lock_reason
  from public.payment_recovery_eligible_payout_targets($1,'2026-10-01',null)
  where dropx_id in ('EMP1','CON1','WF1')
  order by dropx_id
`, [ids.company]);
assert.deepEqual(targetRows.rows, [
  { dropx_id: "CON1", target_type: "contractor", payout_engine: "people_payroll", is_editable: true, lock_reason: null },
  { dropx_id: "EMP1", target_type: "employee", payout_engine: "people_payroll", is_editable: true, lock_reason: null },
  { dropx_id: "WF1", target_type: "workforce", payout_engine: "workforce", is_editable: true, lock_reason: null }
]);

const peopleAvailableAmounts = await db.query(`
  select dropx_id,available_amount::text available_amount
  from public.payment_recovery_eligible_payout_targets($1,'2026-10-01',null)
  where dropx_id in ('EMP1','CON1')
  order by dropx_id
`, [ids.company]);
assert.deepEqual(peopleAvailableAmounts.rows, [
  { dropx_id: "CON1", available_amount: "1200" },
  { dropx_id: "EMP1", available_amount: "1000" }
]);

const availableMonths = await db.query(`
  select payout_month::text payout_month,target_count::integer target_count
  from public.payment_recovery_available_payout_months($1,null)
`, [ids.company]);
assert.deepEqual(availableMonths.rows, [{ payout_month: "2026-10-01", target_count: 3 }]);

const scopedOutTargets = await db.query(`
  select dropx_id
  from public.payment_recovery_eligible_payout_targets($1,'2026-10-01',array[$2]::uuid[])
`, [ids.company, ids.inactiveStation]);
assert.deepEqual(scopedOutTargets.rows, []);

const configurableRows = [{
  row_number: 2,
  tid: "TID-CONFIGURE",
  location: "LOC1",
  debit_month: "2026-10-01",
  value: 100.01,
  provider_reference: ""
}];
const configurableImport = await db.query(
  `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null) result`,
  [ids.company, "configure.xlsx", "6".repeat(64), JSON.stringify(configurableRows), ids.actor]
);
assert.deepEqual(configurableImport.rows[0].result, {
  batch_id: configurableImport.rows[0].result.batch_id,
  replayed: false,
  cases: 1,
  allocations: 0
});

const configurableCase = await db.query(`
  select id::text id,recovery_method,status,payout_month
  from public.payment_recovery_cases where tid='TID-CONFIGURE'
`);
assert.equal(configurableCase.rows[0].recovery_method, null);
assert.equal(configurableCase.rows[0].status, "awaiting_configuration");
assert.equal(configurableCase.rows[0].payout_month, null);

const configured = await db.query(
  `select public.payment_recovery_configure_case(
     $1,$2,'PAYOUT_DEDUCTION','2026-10-01',array['WF1','EMP1','CON1'],$3::jsonb,$4,null
   ) result`,
  [ids.company, configurableCase.rows[0].id, JSON.stringify([{
    dropx_id: 'WF1', workforce_id: ids.workforce, station_id: ids.station,
    max_amount: 1000, snapshot_hash: 'recovery-test-snapshot'
  }]), ids.actor]
);
assert.equal(configured.rows[0].result.status, "recovered");
assert.equal(configured.rows[0].result.allocation_count, 3);
assert.equal(String(configured.rows[0].result.deduction_total), "100.01");

const configuredAllocations = await db.query(`
  select imported_dropx_id,payout_engine,allocation_amount::text allocation_amount,
         deduction_value_id is not null has_workforce_input,
         payroll_manual_entry_id is not null has_people_input
  from public.payment_recovery_allocations
  where recovery_case_id=$1
  order by allocation_order
`, [configurableCase.rows[0].id]);
assert.deepEqual(configuredAllocations.rows, [
  { imported_dropx_id: "CON1", payout_engine: "people_payroll", allocation_amount: "33.34", has_workforce_input: false, has_people_input: true },
  { imported_dropx_id: "EMP1", payout_engine: "people_payroll", allocation_amount: "33.34", has_workforce_input: false, has_people_input: true },
  { imported_dropx_id: "WF1", payout_engine: "workforce", allocation_amount: "33.33", has_workforce_input: true, has_people_input: false }
]);

const workforceRecoveryInput = await db.query(`
  select value.amount::text amount,value.source_type,head.code
  from public.workforce_payout_deduction_values value
  join public.workforce_deduction_heads head on head.id=value.deduction_head_id
  where value.company_id=$1 and value.workforce_id=$2
`, [ids.company, ids.workforce]);
assert.deepEqual(workforceRecoveryInput.rows[0], {
  amount: "33.33", source_type: "payment_recovery", code: "RECOVERY"
});

const peopleRecoveryInputs = await db.query(`
  select worker_type,payment_recovery_amount::text payment_recovery_amount,
         exception_debit::text exception_debit
  from public.hr_payroll_run_manual_entries
  order by worker_type
`);
assert.deepEqual(peopleRecoveryInputs.rows, [
  { worker_type: "contractor", payment_recovery_amount: "33.34", exception_debit: "33.34" },
  { worker_type: "employee", payment_recovery_amount: "33.34", exception_debit: "33.34" }
]);

const peoplePayrollAfterRecovery = await db.query(`
  select worker_type,other_deductions::text other_deductions,
         net_pay::text net_pay,
         adjusted_net_pay::text adjusted_net_pay,is_adjusted,
         calculation_snapshot->>'payment_recovery_amount' recovery_amount
  from public.hr_payroll_run_people
  order by worker_type
`);
assert.deepEqual(peoplePayrollAfterRecovery.rows, [
  { worker_type: "contractor", other_deductions: "33.34", net_pay: "966.66", adjusted_net_pay: "1166.66", is_adjusted: true, recovery_amount: "33.34" },
  { worker_type: "employee", other_deductions: "33.34", net_pay: "966.66", adjusted_net_pay: "2500", is_adjusted: false, recovery_amount: "33.34" }
]);

const peopleRecoveryItems = await db.query(`
  select count(*)::integer count,sum(amount)::text amount
  from public.hr_payroll_run_items
  where code='RECOVERY' and source='payment_recovery'
`);
assert.deepEqual(peopleRecoveryItems.rows[0], { count: 2, amount: "66.68" });

const payrollTotalsAfterRecovery = await db.query(`
  select deduction_total::text deduction_total,net_total::text net_total
  from public.hr_payroll_runs where id=$1
`, [ids.payrollRun]);
assert.deepEqual(payrollTotalsAfterRecovery.rows[0], { deduction_total: "66.68", net_total: "2133.32" });

// Exact-month payroll remains visible when its historical station later closes;
// authorization follows the stored location, but only ready calculations are editable.
await db.query(`update public.stations set is_active=false where id=$1`, [ids.inactiveStation]);
await db.query(
  `insert into public.hr_payroll_run_people(
     id,company_id,run_id,worker_type,worker_id,worker_code,worker_name,
     location_id,net_pay,calculation_status
   ) values ($1,$2,$3,'employee',$4,'INACTIVELOC','Inactive-station employee',$5,500,'ready')`,
  [ids.payrollInactiveStationPerson, ids.company, ids.payrollRun, ids.inactiveStationEmployee, ids.inactiveStation]
);
const inactiveStationTarget = await db.query(`
  select is_editable,lock_reason,available_amount::text available_amount
  from public.payment_recovery_eligible_payout_targets($1,'2026-10-01',array[$2]::uuid[])
  where dropx_id='INACTIVELOC'
`, [ids.company, ids.inactiveStation]);
assert.deepEqual(inactiveStationTarget.rows[0], {
  is_editable: true,
  lock_reason: null,
  available_amount: "500"
});
await db.query(`
  update public.hr_payroll_run_people set calculation_status='review'
  where id=$1
`, [ids.payrollInactiveStationPerson]);
const blockedTarget = await db.query(`
  select is_editable,lock_reason
  from public.payment_recovery_eligible_payout_targets($1,'2026-10-01',array[$2]::uuid[])
  where dropx_id='INACTIVELOC'
`, [ids.company, ids.inactiveStation]);
assert.equal(blockedTarget.rows[0].is_editable, false);
assert.match(blockedTarget.rows[0].lock_reason, /calculation is not ready/);

// A later general manual-entry replacement may clear its own exception debit,
// but it must not erase the protected Recovery component or its explanation.
await db.query(`
  update public.hr_payroll_run_manual_entries
  set exception_debit=null, exception_debit_reason=null
  where worker_type='employee'
`);
const preservedPeopleRecovery = await db.query(`
  select exception_debit::text exception_debit,exception_debit_reason
  from public.hr_payroll_run_manual_entries
  where worker_type='employee'
`);
assert.equal(preservedPeopleRecovery.rows[0].exception_debit, "33.34");
assert.match(preservedPeopleRecovery.rows[0].exception_debit_reason, /Payment Recovery TID TID-CONFIGURE/);

const replayedConfiguration = await db.query(
  `select public.payment_recovery_configure_case(
     $1,$2,'payout_deduction','2026-10-01',array['CON1','EMP1','WF1'],'[]'::jsonb,$3,null
   ) result`,
  [ids.company, configurableCase.rows[0].id, ids.actor]
);
assert.equal(replayedConfiguration.rows[0].result.replayed, true);
const eventCount = await db.query(`
  select count(*)::integer count,sum(amount)::text amount
  from public.payment_recovery_events
  where recovery_case_id=$1 and event_type='payout_deduction' and status='applied'
`, [configurableCase.rows[0].id]);
assert.deepEqual(eventCount.rows[0], { count: 3, amount: "100.01" });

const aggregateRows = [{
  row_number: 2, tid: "TID-CONFIGURE-WF-AGGREGATE", location: "LOC1",
  debit_month: "2026-10-01", value: 10
}];
await db.query(
  `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
  [ids.company, "configure-workforce-aggregate.xlsx", "8".repeat(64), JSON.stringify(aggregateRows), ids.actor]
);
const aggregateCase = await db.query(`
  select id::text id from public.payment_recovery_cases where tid='TID-CONFIGURE-WF-AGGREGATE'
`);
await db.query(
  `select public.payment_recovery_configure_case(
     $1,$2,'payout_deduction','2026-10-01',array['WF1'],$3::jsonb,$4,null
   )`,
  [ids.company, aggregateCase.rows[0].id, JSON.stringify([{
    dropx_id: 'WF1', workforce_id: ids.workforce, station_id: ids.station,
    max_amount: 100, snapshot_hash: 'recovery-test-snapshot'
  }]), ids.actor]
);
const aggregatedWorkforceRecovery = await db.query(`
  select amount::text amount,station_id::text station_id
  from public.workforce_payout_deduction_values value
  join public.workforce_deduction_heads head on head.id=value.deduction_head_id
  where value.company_id=$1 and value.workforce_id=$2 and head.code='RECOVERY'
`, [ids.company, ids.workforce]);
assert.deepEqual(aggregatedWorkforceRecovery.rows[0], { amount: "43.33", station_id: ids.station });

const insufficientRows = [{
  row_number: 2, tid: "TID-CONFIGURE-WF-INSUFFICIENT", location: "LOC1",
  debit_month: "2026-10-01", value: 10
}];
await db.query(
  `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
  [ids.company, "configure-workforce-insufficient.xlsx", "9".repeat(64), JSON.stringify(insufficientRows), ids.actor]
);
const insufficientCase = await db.query(`
  select id::text id from public.payment_recovery_cases where tid='TID-CONFIGURE-WF-INSUFFICIENT'
`);
await assert.rejects(
  db.query(
    `select public.payment_recovery_configure_case(
       $1,$2,'payout_deduction','2026-10-01',array['WF1'],$3::jsonb,$4,null
     )`,
    [ids.company, insufficientCase.rows[0].id, JSON.stringify([{
      dropx_id: 'WF1', workforce_id: ids.workforce, station_id: ids.station,
      max_amount: 5, snapshot_hash: 'recovery-test-snapshot'
    }]), ids.actor]
  ),
  /does not have enough available Workforce payout/
);
const insufficientRollback = await db.query(`
  select recovery.status,count(allocation.id)::integer allocation_count
  from public.payment_recovery_cases recovery
  left join public.payment_recovery_allocations allocation on allocation.recovery_case_id=recovery.id
  where recovery.id=$1 group by recovery.id,recovery.status
`, [insufficientCase.rows[0].id]);
assert.deepEqual(insufficientRollback.rows[0], { status: "awaiting_configuration", allocation_count: 0 });

await db.query(`
  update public.workforce_payment_allocations set station_id=$1 where id=$2
`, [ids.inactiveStation, ids.workforcePaymentAllocation]);
const movedRows = [{
  row_number: 2, tid: "TID-CONFIGURE-WF-MOVED", location: "LOC1",
  debit_month: "2026-10-01", value: 10
}];
await db.query(
  `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
  [ids.company, "configure-workforce-moved.xlsx", "ab".repeat(32), JSON.stringify(movedRows), ids.actor]
);
const movedCase = await db.query(`
  select id::text id from public.payment_recovery_cases where tid='TID-CONFIGURE-WF-MOVED'
`);
await assert.rejects(
  db.query(
    `select public.payment_recovery_configure_case(
       $1,$2,'payout_deduction','2026-10-01',array['WF1'],$3::jsonb,$4,null
     )`,
    [ids.company, movedCase.rows[0].id, JSON.stringify([{
      dropx_id: 'WF1', workforce_id: ids.workforce, station_id: ids.inactiveStation,
      max_amount: 100, snapshot_hash: 'recovery-test-snapshot'
    }]), ids.actor]
  ),
  /another payout location or source/
);
await db.query(`
  update public.workforce_payment_allocations set station_id=$1 where id=$2
`, [ids.station, ids.workforcePaymentAllocation]);
const aggregateAfterRejectedMove = await db.query(`
  select amount::text amount,station_id::text station_id
  from public.workforce_payout_deduction_values value
  join public.workforce_deduction_heads head on head.id=value.deduction_head_id
  where value.company_id=$1 and value.workforce_id=$2 and head.code='RECOVERY'
`, [ids.company, ids.workforce]);
assert.deepEqual(aggregateAfterRejectedMove.rows[0], { amount: "43.33", station_id: ids.station });

const disputeRows = [{
  row_number: 2, tid: "TID-CONFIGURE-DISPUTE", location: "LOC1",
  debit_month: "2026-10-01", value: 15
}];
await db.query(
  `select public.payment_recovery_apply_import($1,$2,$3,$4::jsonb,$5,null)`,
  [ids.company, "dispute-configure.xlsx", "7".repeat(64), JSON.stringify(disputeRows), ids.actor]
);
const disputeCase = await db.query(`select id::text id from public.payment_recovery_cases where tid='TID-CONFIGURE-DISPUTE'`);
const configuredDispute = await db.query(
  `select public.payment_recovery_configure_case($1,$2,'POST_INVOICE_DISPUTE',null,null,'[]'::jsonb,$3,null) result`,
  [ids.company, disputeCase.rows[0].id, ids.actor]
);
assert.equal(configuredDispute.rows[0].result.status, "planned_provider_dispute");
assert.equal(configuredDispute.rows[0].result.allocation_count, 0);

await db.query(`update public.hr_payroll_runs set status='reviewed' where id=$1`, [ids.payrollRun]);
const lockedTarget = await db.query(`
  select is_editable,lock_reason
  from public.payment_recovery_eligible_payout_targets($1,'2026-10-01',null)
  where dropx_id='EMP1'
`, [ids.company]);
assert.equal(lockedTarget.rows[0].is_editable, false);
assert.match(lockedTarget.rows[0].lock_reason, /reviewed, approved or locked/);

await db.close();
console.log("Payment Recovery register and post-upload configuration migrations verified.");
