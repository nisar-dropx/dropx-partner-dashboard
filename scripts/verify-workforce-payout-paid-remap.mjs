import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users(id uuid primary key);
  create table public.companies(id uuid primary key);
  create table public.providers(id uuid primary key);
  create table public.stations(id uuid primary key, company_id uuid not null, unique(company_id,id));
  create table public.workforce(
    id uuid primary key, company_id uuid not null, dropx_id text,
    full_name text, bank_account_no text, ifsc_code text, deleted_at timestamptz,
    is_active boolean, lifecycle_status text, onboarding_status text,
    unique(company_id,id)
  );
  create table public.field_executive_provider_mappings(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    workforce_id uuid, field_executive_id uuid, employee_id uuid,
    contractor_id uuid, provider_id uuid, station_id uuid,
    provider_member_id text, effective_from date, effective_to date,
    status text, created_at timestamptz default now()
  );
  create table public.workforce_payout_payment_batches(
    id uuid primary key, company_id uuid not null, unique(company_id,id)
  );
  create table public.workforce_payout_payment_items(
    id uuid primary key, company_id uuid not null, batch_id uuid,
    workforce_id uuid, period_start date, period_end date,
    payment_version integer, reference_no text, instruction_amount numeric,
    status text, utr_cin text, bank_account_no_snapshot text,
    location_id_snapshot uuid, location_code_snapshot text,
    bank_processing_remarks text, created_at timestamptz,
    finalized_at timestamptz, unique(company_id,id)
  );
  create table public.workforce_payout_publications(
    id uuid primary key, company_id uuid not null, workforce_id uuid,
    station_id uuid, period_start date, period_end date, snapshot jsonb,
    unique(company_id,id)
  );
  create table public.workforce_payout_payment_allocations(
    id uuid primary key, company_id uuid not null, payment_item_id uuid,
    publication_id uuid, station_id uuid, instruction_amount_snapshot numeric
  );
  create table public.workforce_payout_mapping_unlocks(
    id uuid primary key, company_id uuid, base_mapping_snapshot jsonb
  );
  create table public.workforce_payout_mapping_relocks(
    id uuid primary key, company_id uuid, unlock_ids uuid[],
    period_start date, period_end date
  );
  create table public.workforce_joining_events(
    company_id uuid, workforce_id uuid, event_code text, actor_id uuid,
    actor_name text, details jsonb
  );
  create function public.workforce_provider_mapping_person(uuid,uuid,uuid,uuid,uuid)
  returns uuid language sql immutable as $$ select coalesce($2,$3,$4,$5) $$;
  create function public.lock_workforce_payment_allocation_company(uuid)
  returns void language sql as $$ select null::void $$;
  create function public.workforce_replace_joining_mapping(
    p_company uuid,p_actor uuid,p_workforce uuid,p_expected uuid,p_dropx text,
    p_payload jsonb,p_locations uuid[],p_actor_name text
  ) returns void language plpgsql as $$
  begin
    update public.field_executive_provider_mappings
    set status='closed', effective_to=(p_payload->>'effective_from')::date - 1
    where company_id=p_company and id=p_expected;
    insert into public.field_executive_provider_mappings(
      company_id,workforce_id,provider_id,station_id,provider_member_id,
      effective_from,status
    ) values (
      p_company,p_workforce,(p_payload->>'provider_id')::uuid,
      (p_payload->>'station_id')::uuid,p_payload->>'provider_member_id',
      (p_payload->>'effective_from')::date,'active'
    );
  end $$;
`);
const baseSource = await readFile(new URL("../supabase/migrations/20261010130000_workforce_payout_location_row_bank_selection.sql", import.meta.url), "utf8");
const candidateStart = baseSource.indexOf("create or replace function public.workforce_payout_payment_row_candidates(");
const candidateEnd = baseSource.indexOf("create or replace function public.workforce_preview_payout_payment_rows(", candidateStart);
await db.exec(baseSource.slice(candidateStart, candidateEnd));

// Reproduce both definition patches that precede the paid-remap migration in
// production. This verifies that its exact-body rewrite matches the final
// 20261012160000 source-hold version, not merely the older base function.
const oldPartialStatus = `    payment_status := case
      when v_paid > 0 and balance_payable = 0 then 'Paid'
      when v_latest_attempt_status = 'failed' then 'Payment Failed'
      when v_latest_attempt_status = 'cancelled' then 'Payment Cancelled'
      when v_paid > 0 then 'Partially paid'
      else null
    end;`;
const newPartialStatus = `    payment_status := case
      when v_paid > 0 and balance_payable = 0 then 'Paid'
      when v_paid > 0 and balance_payable > 0 then 'Partially Paid'
      when v_latest_attempt_status = 'failed' then 'Payment Failed'
      when v_latest_attempt_status = 'cancelled' then 'Payment Cancelled'
      else null
    end;`;
const beforePartial = (await db.query(`select pg_get_functiondef(
  'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure
) as definition`)).rows[0].definition.replaceAll("\r\n", "\n");
if (!beforePartial.includes(oldPartialStatus)) throw new Error("partial-payment fixture marker missing");
await db.exec(beforePartial.replace(oldPartialStatus, newPartialStatus));
await db.exec(`create function public.workforce_payout_source_payment_is_on_hold(
  uuid,uuid,uuid,date,date
) returns boolean language sql stable as $$ select false $$`);
const sourceHold = await readFile(new URL("../supabase/migrations/20261012160000_workforce_payout_source_identity_holds.sql", import.meta.url), "utf8");
const sourceHoldPatchStart = sourceHold.indexOf("do $patch$");
const sourceHoldPatchEnd = sourceHold.indexOf("$patch$;", sourceHoldPatchStart) + "$patch$;".length;
await db.exec(sourceHold.slice(sourceHoldPatchStart, sourceHoldPatchEnd));

const source = await readFile(new URL("../supabase/migrations/20261012190000_workforce_payout_paid_mapping_transfer.sql", import.meta.url), "utf8");
const prefix = source.slice(0, source.indexOf("-- Teach the canonical bank candidate calculator"));
await db.exec(`${prefix}\ncommit;`);
const patchStart = source.indexOf("do $patch$");
const patchEnd = source.indexOf("$patch$;", patchStart) + "$patch$;".length;
await db.exec(source.slice(patchStart, patchEnd));
const patchedCandidate = (await db.query(`select pg_get_functiondef(
  'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure
) as definition`)).rows[0].definition;
if (!patchedCandidate.includes("workforce_payout_source_payment_is_on_hold")) {
  throw new Error("source-hold candidate gate was lost");
}
if (!patchedCandidate.includes("workforce_payout_effective_paid_allocations")) {
  throw new Error("paid-credit candidate patch was not installed");
}

async function previewPaidHistory(mappingId, destinationWorkforceId, effectiveFrom) {
  const result = await db.query(`select public.workforce_mapping_paid_history_preview(
    '10000000-0000-4000-8000-000000000002',
    '${mappingId}', '${destinationWorkforceId}', '${effectiveFrom}'
  ) as result`);
  return result.rows[0].result;
}

async function replaceMapping({
  sourceMappingId,
  destinationWorkforceId,
  destinationDropxId,
  stationId,
  providerMemberId,
  effectiveFrom,
  action,
  fingerprint,
  operationId
}) {
  const result = await db.query(`select public.workforce_replace_joining_mapping_with_payment_decision(
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '${destinationWorkforceId}', '${sourceMappingId}', '${destinationDropxId}',
    jsonb_build_object(
      'provider_id','10000000-0000-4000-8000-000000000003',
      'station_id','${stationId}',
      'provider_member_id','${providerMemberId}',
      'effective_from','${effectiveFrom}',
      'status','active'
    ), null, 'Verifier', '${action}', '${fingerprint}', '${operationId}'
  ) as result`);
  return result.rows[0].result;
}

async function expectDatabaseError(operation, expectedMessage) {
  try {
    await operation();
  } catch (error) {
    if (!expectedMessage.test(String(error?.message ?? error))) throw error;
    return;
  }
  throw new Error(`expected database rejection matching ${expectedMessage}`);
}

await db.exec(`
  insert into auth.users values ('10000000-0000-4000-8000-000000000001');
  insert into public.companies values ('10000000-0000-4000-8000-000000000002');
  insert into public.providers values ('10000000-0000-4000-8000-000000000003');
  insert into public.stations values (
    '10000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000002'
  );
  insert into public.workforce(id,company_id,dropx_id) values
    ('10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000002','OLD1'),
    ('10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000002','NEW1');
  insert into public.field_executive_provider_mappings(
    id,company_id,workforce_id,provider_id,station_id,provider_member_id,
    effective_from,status
  ) values
    ('10000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004','2000074247130','2026-09-01','active');
  insert into public.workforce_payout_payment_batches values (
    '10000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000002'
  );
  insert into public.workforce_payout_publications values (
    '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000004',
    '2026-09-01','2026-09-30',
    '{"item":{"provider_member_ids":["2000074247130"]},"lines":[]}'::jsonb
  );
  insert into public.workforce_payout_payment_items(
    id,company_id,batch_id,workforce_id,period_start,period_end,payment_version,
    reference_no,instruction_amount,status,utr_cin,bank_account_no_snapshot,
    location_id_snapshot,location_code_snapshot,created_at,finalized_at
  ) values (
    '10000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000005',
    '2026-09-01','2026-09-30',1,'WFOLD1092026V1',100,'paid','UTR100','1234',
    '10000000-0000-4000-8000-000000000004','LOC',now(),now()
  );
  insert into public.workforce_payout_payment_allocations values (
    '10000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000010',
    '10000000-0000-4000-8000-000000000004',100
  );
`);
const primaryPreview = await previewPaidHistory(
  "10000000-0000-4000-8000-000000000007",
  "10000000-0000-4000-8000-000000000006",
  "2026-09-01"
);
const primaryRequest = {
  sourceMappingId: "10000000-0000-4000-8000-000000000007",
  destinationWorkforceId: "10000000-0000-4000-8000-000000000006",
  destinationDropxId: "NEW1",
  stationId: "10000000-0000-4000-8000-000000000004",
  providerMemberId: "2000074247130",
  effectiveFrom: "2026-09-01",
  action: "transfer",
  fingerprint: primaryPreview.payment_fingerprint,
  operationId: "10000000-0000-4000-8000-000000000014"
};
const applied = await replaceMapping(primaryRequest);
if (Number(applied.transferred_amount) !== 100) {
  throw new Error(`unexpected transfer result ${JSON.stringify(applied)}`);
}
const replay = await replaceMapping(primaryRequest);
if (replay.replayed !== true) throw new Error(`operation did not replay: ${JSON.stringify(replay)}`);
const firstDecisionCount = await db.query(`select count(*)::integer as count
  from public.workforce_payout_mapping_payment_decisions
  where operation_id = '10000000-0000-4000-8000-000000000014'`);
if (firstDecisionCount.rows[0].count !== 1) throw new Error("idempotent replay duplicated decision");

const owner = await db.query(`select public.workforce_payout_payment_allocation_credit_owner(
  '10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000012'
) as id`);
if (owner.rows[0].id !== "10000000-0000-4000-8000-000000000006") {
  throw new Error(`unexpected paid-credit owner ${owner.rows[0].id}`);
}
const effective = await db.query(`select original_workforce_id, credited_workforce_id,
  instruction_amount_snapshot, was_transferred
  from public.workforce_payout_effective_paid_allocations`);
if (effective.rows.length !== 1
  || effective.rows[0].original_workforce_id !== "10000000-0000-4000-8000-000000000005"
  || effective.rows[0].credited_workforce_id !== "10000000-0000-4000-8000-000000000006"
  || Number(effective.rows[0].instruction_amount_snapshot) !== 100
  || effective.rows[0].was_transferred !== true) {
  throw new Error(`unexpected effective paid allocation ${JSON.stringify(effective.rows)}`);
}

// A second owner move appends sequence 2 and never rewrites the original bank
// item, beneficiary, reference or UTR/CIN.
await db.exec(`insert into public.workforce(id,company_id,dropx_id) values
  ('10000000-0000-4000-8000-000000000013','10000000-0000-4000-8000-000000000002','NEW2')`);
const chainPreview = await previewPaidHistory(
  applied.new_mapping_id,
  "10000000-0000-4000-8000-000000000013",
  "2026-09-01"
);
const chained = await replaceMapping({
  sourceMappingId: applied.new_mapping_id,
  destinationWorkforceId: "10000000-0000-4000-8000-000000000013",
  destinationDropxId: "NEW2",
  stationId: "10000000-0000-4000-8000-000000000004",
  providerMemberId: "2000074247130",
  effectiveFrom: "2026-09-01",
  action: "transfer",
  fingerprint: chainPreview.payment_fingerprint,
  operationId: "10000000-0000-4000-8000-000000000015"
});
if (Number(chained.transferred_amount) !== 100) throw new Error("chained credit did not transfer");
const chainEvidence = await db.query(`
  select transfer.sequence_no, transfer.source_workforce_id,
    transfer.destination_workforce_id, transfer.original_reference_snapshot,
    transfer.original_utr_cin_snapshot
  from public.workforce_payout_payment_credit_transfers transfer
  where transfer.payment_allocation_id = '10000000-0000-4000-8000-000000000012'
  order by transfer.sequence_no`);
if (chainEvidence.rows.length !== 2
  || chainEvidence.rows[1].sequence_no !== 2
  || chainEvidence.rows[1].source_workforce_id !== "10000000-0000-4000-8000-000000000006"
  || chainEvidence.rows[1].destination_workforce_id !== "10000000-0000-4000-8000-000000000013"
  || chainEvidence.rows[1].original_reference_snapshot !== "WFOLD1092026V1"
  || chainEvidence.rows[1].original_utr_cin_snapshot !== "UTR100") {
  throw new Error(`unexpected transfer chain ${JSON.stringify(chainEvidence.rows)}`);
}
const immutableItem = await db.query(`select workforce_id, reference_no, utr_cin
  from public.workforce_payout_payment_items
  where id = '10000000-0000-4000-8000-000000000011'`);
if (immutableItem.rows[0].workforce_id !== "10000000-0000-4000-8000-000000000005"
  || immutableItem.rows[0].reference_no !== "WFOLD1092026V1"
  || immutableItem.rows[0].utr_cin !== "UTR100") {
  throw new Error(`original bank evidence changed ${JSON.stringify(immutableItem.rows[0])}`);
}

// A payment finalized after browser preflight changes the exact allocation-set
// fingerprint. The stale request must abort before replacing the mapping.
await db.exec(`
  insert into public.stations values (
    '10000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000002'
  );
  insert into public.workforce(id,company_id,dropx_id) values
    ('10000000-0000-4000-8000-000000000020','10000000-0000-4000-8000-000000000002','STALE1'),
    ('10000000-0000-4000-8000-000000000021','10000000-0000-4000-8000-000000000002','STALE2');
  insert into public.field_executive_provider_mappings(
    id,company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from,status
  ) values (
    '10000000-0000-4000-8000-000000000022','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000020','10000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000004','STALE-MEMBER','2026-09-01','active'
  );
  insert into public.workforce_payout_publications values (
    '10000000-0000-4000-8000-000000000023','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000020','10000000-0000-4000-8000-000000000004',
    '2026-09-01','2026-09-30','{"item":{"provider_member_ids":["STALE-MEMBER"]}}'::jsonb
  );
  insert into public.workforce_payout_payment_items(
    id,company_id,batch_id,workforce_id,period_start,period_end,payment_version,
    reference_no,instruction_amount,status,utr_cin,created_at,finalized_at
  ) values (
    '10000000-0000-4000-8000-000000000024','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000020',
    '2026-09-01','2026-09-30',1,'WFSTALE1',100,'paid','UTR-STALE-1',now(),now()
  );
  insert into public.workforce_payout_payment_allocations values (
    '10000000-0000-4000-8000-000000000025','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000024','10000000-0000-4000-8000-000000000023',
    '10000000-0000-4000-8000-000000000004',100
  );
`);
const stalePreview = await previewPaidHistory(
  "10000000-0000-4000-8000-000000000022",
  "10000000-0000-4000-8000-000000000021",
  "2026-09-01"
);
await db.exec(`
  insert into public.workforce_payout_publications values (
    '10000000-0000-4000-8000-000000000026','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000020','10000000-0000-4000-8000-000000000004',
    '2026-09-01','2026-09-30','{"item":{"provider_member_ids":["STALE-MEMBER"]}}'::jsonb
  );
  insert into public.workforce_payout_payment_items(
    id,company_id,batch_id,workforce_id,period_start,period_end,payment_version,
    reference_no,instruction_amount,status,utr_cin,created_at,finalized_at
  ) values (
    '10000000-0000-4000-8000-000000000027','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000020',
    '2026-09-01','2026-09-30',2,'WFSTALE2',25,'paid','UTR-STALE-2',now(),now()
  );
  insert into public.workforce_payout_payment_allocations values (
    '10000000-0000-4000-8000-000000000028','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000027','10000000-0000-4000-8000-000000000026',
    '10000000-0000-4000-8000-000000000004',25
  );
`);
const staleRequest = {
  sourceMappingId: "10000000-0000-4000-8000-000000000022",
  destinationWorkforceId: "10000000-0000-4000-8000-000000000021",
  destinationDropxId: "STALE2",
  stationId: "10000000-0000-4000-8000-000000000008",
  providerMemberId: "STALE-MEMBER",
  effectiveFrom: "2026-09-01",
  action: "keep",
  fingerprint: stalePreview.payment_fingerprint,
  operationId: "10000000-0000-4000-8000-000000000029"
};
await expectDatabaseError(
  () => replaceMapping(staleRequest),
  /payment history changed after confirmation/i
);
const staleMappingState = await db.query(`select status from public.field_executive_provider_mappings
  where id = '10000000-0000-4000-8000-000000000022'`);
if (staleMappingState.rows[0].status !== "active") throw new Error("stale request mutated mapping");

// Keep may cross stations and leaves immutable paid credit on the old ID. It
// also replays exactly once under the same operation ID.
const freshKeepPreview = await previewPaidHistory(
  staleRequest.sourceMappingId, staleRequest.destinationWorkforceId, staleRequest.effectiveFrom
);
const keepRequest = { ...staleRequest, fingerprint: freshKeepPreview.payment_fingerprint };
const kept = await replaceMapping(keepRequest);
if (kept.payment_action !== "keep" || Number(kept.paid_amount) !== 125) {
  throw new Error(`unexpected Keep result ${JSON.stringify(kept)}`);
}
const keptReplay = await replaceMapping(keepRequest);
if (keptReplay.replayed !== true) throw new Error("Keep request did not replay");
const keptOwners = await db.query(`select distinct credited_workforce_id
  from public.workforce_payout_effective_paid_allocations
  where payment_allocation_id in (
    '10000000-0000-4000-8000-000000000025',
    '10000000-0000-4000-8000-000000000028'
  )`);
if (keptOwners.rows.length !== 1
  || keptOwners.rows[0].credited_workforce_id !== "10000000-0000-4000-8000-000000000020") {
  throw new Error(`Keep moved paid credit ${JSON.stringify(keptOwners.rows)}`);
}

// A mid-month mapping date cannot move a whole monthly allocation. Transfer
// is rejected while Keep remains the explicit safe choice.
await db.exec(`
  insert into public.workforce(id,company_id,dropx_id) values
    ('10000000-0000-4000-8000-000000000030','10000000-0000-4000-8000-000000000002','PART1'),
    ('10000000-0000-4000-8000-000000000031','10000000-0000-4000-8000-000000000002','PART2');
  insert into public.field_executive_provider_mappings(
    id,company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from,status
  ) values (
    '10000000-0000-4000-8000-000000000032','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000030','10000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000004','PART-MEMBER','2026-09-01','active'
  );
  insert into public.workforce_payout_publications values (
    '10000000-0000-4000-8000-000000000033','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000030','10000000-0000-4000-8000-000000000004',
    '2026-09-01','2026-09-30','{"item":{"provider_member_ids":["PART-MEMBER"]}}'::jsonb
  );
  insert into public.workforce_payout_payment_items(
    id,company_id,batch_id,workforce_id,period_start,period_end,payment_version,
    reference_no,instruction_amount,status,utr_cin,created_at,finalized_at
  ) values (
    '10000000-0000-4000-8000-000000000034','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000030',
    '2026-09-01','2026-09-30',1,'WFPART1',75,'paid','UTR-PART',now(),now()
  );
  insert into public.workforce_payout_payment_allocations values (
    '10000000-0000-4000-8000-000000000035','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000034','10000000-0000-4000-8000-000000000033',
    '10000000-0000-4000-8000-000000000004',75
  );
`);
const partialPreview = await previewPaidHistory(
  "10000000-0000-4000-8000-000000000032",
  "10000000-0000-4000-8000-000000000031",
  "2026-09-15"
);
if (partialPreview.partial_period_allocation_count !== 1
  || partialPreview.periods[0].partial_period_allocation_count !== 1) {
  throw new Error(`mid-month allocation was not exposed ${JSON.stringify(partialPreview)}`);
}
await expectDatabaseError(
  () => replaceMapping({
    sourceMappingId: "10000000-0000-4000-8000-000000000032",
    destinationWorkforceId: "10000000-0000-4000-8000-000000000031",
    destinationDropxId: "PART2",
    stationId: "10000000-0000-4000-8000-000000000004",
    providerMemberId: "PART-MEMBER",
    effectiveFrom: "2026-09-15",
    action: "transfer",
    fingerprint: partialPreview.payment_fingerprint,
    operationId: "10000000-0000-4000-8000-000000000036"
  }),
  /falls inside a paid monthly allocation/i
);

// No-history replacements use the empty-set fingerprint, are audited as
// `none`, and retain ordinary cross-station mapping behavior.
await db.exec(`
  insert into public.workforce(id,company_id,dropx_id) values
    ('10000000-0000-4000-8000-000000000040','10000000-0000-4000-8000-000000000002','EMPTY1'),
    ('10000000-0000-4000-8000-000000000041','10000000-0000-4000-8000-000000000002','EMPTY2');
  insert into public.field_executive_provider_mappings(
    id,company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from,status
  ) values (
    '10000000-0000-4000-8000-000000000042','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000040','10000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000004','EMPTY-MEMBER','2026-09-01','active'
  );
`);
const emptyPreview = await previewPaidHistory(
  "10000000-0000-4000-8000-000000000042",
  "10000000-0000-4000-8000-000000000041",
  "2026-09-01"
);
const emptyResult = await replaceMapping({
  sourceMappingId: "10000000-0000-4000-8000-000000000042",
  destinationWorkforceId: "10000000-0000-4000-8000-000000000041",
  destinationDropxId: "EMPTY2",
  stationId: "10000000-0000-4000-8000-000000000008",
  providerMemberId: "EMPTY-MEMBER",
  effectiveFrom: "2026-09-01",
  action: "",
  fingerprint: emptyPreview.payment_fingerprint,
  operationId: "10000000-0000-4000-8000-000000000043"
});
if (emptyResult.payment_action !== "none") throw new Error("no-history replacement was not audited");

// The relock guard must detect an owner change at a different station; the
// old station is payment scope, not a filter for finding the successor.
await db.exec(`
  insert into public.workforce(id,company_id,dropx_id) values
    ('10000000-0000-4000-8000-000000000050','10000000-0000-4000-8000-000000000002','LOCK1'),
    ('10000000-0000-4000-8000-000000000051','10000000-0000-4000-8000-000000000002','LOCK2');
  insert into public.field_executive_provider_mappings(
    id,company_id,workforce_id,provider_id,station_id,provider_member_id,
    effective_from,effective_to,status
  ) values
    ('10000000-0000-4000-8000-000000000052','10000000-0000-4000-8000-000000000002',
     '10000000-0000-4000-8000-000000000050','10000000-0000-4000-8000-000000000003',
     '10000000-0000-4000-8000-000000000004','LOCK-MEMBER','2026-09-01','2026-09-14','closed'),
    ('10000000-0000-4000-8000-000000000053','10000000-0000-4000-8000-000000000002',
     '10000000-0000-4000-8000-000000000051','10000000-0000-4000-8000-000000000003',
     '10000000-0000-4000-8000-000000000008','LOCK-MEMBER','2026-09-15',null,'active');
  insert into public.workforce_payout_publications values (
    '10000000-0000-4000-8000-000000000054','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000050','10000000-0000-4000-8000-000000000004',
    '2026-09-01','2026-09-30','{"item":{"provider_member_ids":["LOCK-MEMBER"]}}'::jsonb
  );
  insert into public.workforce_payout_payment_items(
    id,company_id,batch_id,workforce_id,period_start,period_end,payment_version,
    reference_no,instruction_amount,status,utr_cin,created_at,finalized_at
  ) values (
    '10000000-0000-4000-8000-000000000055','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000050',
    '2026-09-01','2026-09-30',1,'WFLOCK1',50,'paid','UTR-LOCK',now(),now()
  );
  insert into public.workforce_payout_payment_allocations values (
    '10000000-0000-4000-8000-000000000056','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000055','10000000-0000-4000-8000-000000000054',
    '10000000-0000-4000-8000-000000000004',50
  );
  insert into public.workforce_payout_mapping_unlocks values (
    '10000000-0000-4000-8000-000000000057','10000000-0000-4000-8000-000000000002',
    '[{"id":"10000000-0000-4000-8000-000000000052"}]'::jsonb
  );
`);
await expectDatabaseError(
  () => db.exec(`insert into public.workforce_payout_mapping_relocks values (
    '10000000-0000-4000-8000-000000000058','10000000-0000-4000-8000-000000000002',
    array['10000000-0000-4000-8000-000000000057']::uuid[],
    '2026-09-01','2026-09-30'
  )`),
  /choose whether to transfer paid payment details or keep them/i
);

console.log(
  "verified paid-remap migration, stale fingerprint guard, monthly boundary guard, "
  + "Keep/replay, transfer chain, immutable bank evidence and cross-station relock guard"
);
await db.close();
