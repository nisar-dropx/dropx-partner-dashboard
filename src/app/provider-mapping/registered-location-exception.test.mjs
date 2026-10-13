import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  providerFirstLocationIsAllowed,
  providerFirstLocationRemap
} from "../../lib/provider-first-mapping-view.ts";

const worker = {
  id: "worker-1",
  dropxId: "DX-1",
  fullName: "Asha Devi",
  stationId: "station-a",
  providerId: "provider-1",
  dateOfJoin: "2026-09-01",
  mappingId: "mapping-a",
  paymentMethodId: "method-1",
  paymentValues: { DELIVERY: "10" },
  productionThresholdConfig: null,
  productionThresholdMinimumUnits: "",
  effectiveFrom: "2026-09-01",
  effectiveTo: "",
  mappedProviderMemberId: "member-1",
  locationLabel: "ST-A",
  profileStationId: "station-a",
  profileLocationLabel: "ST-A",
  onboardingStatus: "Active"
};

const secondLocation = {
  providerMemberId: "member-1",
  providerMemberName: "Asha Devi",
  stationId: "station-b",
  stationLabel: "ST-B",
  providerId: "provider-1",
  workforceId: worker.id,
  dropxId: worker.dropxId,
  dropxName: worker.fullName,
  mappingId: "",
  paymentMethodId: "method-1",
  paymentValues: { DELIVERY: "10" },
  productionThresholdConfig: null,
  productionThresholdMinimumUnits: "",
  effectiveFrom: "2026-09-01",
  effectiveTo: "",
  history: []
};

test("allows a second location only from the exact mapping at the profile registered station", () => {
  assert.equal(providerFirstLocationIsAllowed(secondLocation, worker), true);
  assert.deepEqual(providerFirstLocationRemap(secondLocation, worker), {
    kind: "location",
    allowMove: false,
    mappingId: "mapping-a",
    providerMemberId: "member-1",
    providerMemberName: "Asha Devi",
    existingDropxId: "DX-1",
    existingDropxName: "Asha Devi",
    existingLocationLabel: "ST-A",
    newLocationLabel: "ST-B",
    effectiveFrom: "2026-09-01"
  });

  const alreadyMappedSecondLocation = { ...secondLocation, mappingId: "mapping-b" };
  assert.equal(providerFirstLocationIsAllowed(alreadyMappedSecondLocation, worker), true);
  assert.equal(providerFirstLocationRemap(alreadyMappedSecondLocation, worker), null);

  assert.equal(providerFirstLocationIsAllowed(secondLocation, { ...worker, profileStationId: "" }), false);
  assert.equal(providerFirstLocationIsAllowed(secondLocation, { ...worker, stationId: "station-c" }), false);
  assert.equal(providerFirstLocationIsAllowed({ ...secondLocation, providerId: "provider-2" }, worker), false);
  assert.equal(providerFirstLocationIsAllowed({ ...secondLocation, providerMemberId: "member-2" }, worker), false);
  assert.equal(providerFirstLocationIsAllowed({ ...secondLocation, workforceId: "worker-2" }, worker), false);
});

test("keeps relocation into the registered station available without opening a third-location bypass", () => {
  const drifted = {
    ...worker,
    stationId: "station-b",
    locationLabel: "ST-B",
    profileStationId: "station-a",
    profileLocationLabel: "ST-A"
  };
  assert.equal(providerFirstLocationIsAllowed({ ...secondLocation, stationId: "station-a" }, drifted), true);
  assert.equal(providerFirstLocationIsAllowed({ ...secondLocation, stationId: "station-c" }, drifted), false);
});

test("the page exposes a historical registered-location mapping and selection inherits its complete period", async () => {
  const [page, component] = await Promise.all([
    readFile(new URL("../provider-id-mapping/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/provider-first-mapping-worksheet.tsx", import.meta.url), "utf8")
  ]);
  assert.match(page, /const registeredMappingByWorkforce = new Map<string, Mapping\[\]>/);
  assert.match(page, /const mappingHistoryByWorkforce = new Map<string, Mapping\[\]>/);
  assert.match(page, /const currentMappingsByWorkforce = new Map<string, Mapping\[\]>/);
  assert.match(page, /for \(const mapping of mappingHistory\)/);
  assert.match(page, /mapping\.status === "active" && !mapping\.effective_to/);
  assert.match(page, /mapping\.status === "closed" && Boolean\(mapping\.effective_to\)/);
  assert.match(page, /String\(mapping\.station_id \?\? ""\) !== profileStationId/);
  assert.match(page, /const registeredMappings = registeredMappingByWorkforce\.get\(worker\.id\) \?\? \[\]/);
  assert.match(page, /const mapping = mappingByWorkforce\.get\(worker\.id\);/);
  assert.doesNotMatch(page, /mappingByWorkforce\.get\(worker\.id\) \?\? registered/);
  assert.match(page, /const registeredLocationMappings = registeredMappings\.map/);
  assert.match(page, /const currentMappings = activeWorkerMappings\.map\(mappingView\)/);
  assert.match(page, /mappingHistory: completeMappingHistory/);
  assert.match(page, /registeredLocationMappings, registeredLocationMapping: registeredLocationMappings\[0\]/);
  assert.match(page, /effectiveFrom: stored\.effective_from/);
  assert.match(page, /effectiveTo: stored\.effective_to \?\? ""/);
  assert.match(component, /providerFirstMappingReferenceForRow/);
  assert.match(component, /const mappingReference = providerFirstMappingReferenceForRow\(row, worker\)/);
  assert.match(component, /mappingId: mappingReference\?\.mappingId \?\? ""/);
  assert.match(component, /effectiveFrom: targetHasMappingReference \? mappingReference\?\.effectiveFrom/);
  assert.match(component, /effectiveTo: targetHasMappingReference \? mappingReference\?\.effectiveTo/);
  assert.match(component, /providerFirstRowForMappingPeriod/);
  assert.match(component, /boundedHistoryByIndex/);
  assert.match(component, /const preservesLaterCurrent = snapshot\.replacementAction === "keep"/);
  assert.match(component, /preservesLaterCurrent[\s\S]*?\{ \.\.\.baseline, history: canonical\.history \}/);
  assert.match(component, /clearCurrentMapping\(canonical, canonical\.history\)/);
  assert.match(component, /mappingClosuresByWorker/);
  assert.match(component, /rememberClosure\([\s\S]*?saved\.relocation\.previousMappingId/);
  assert.match(component, /baseline\.mappingId !== canonical\.mappingId[\s\S]*?previousIsoDate\(canonical\.effectiveFrom\)/);
  assert.match(component, /saved\?\.cleared\?\.previousMappingId \?\? snapshot\.row\.mappingId/);
  assert.match(component, /currentMappings = \(next\.currentMappings \?\? \[\]\)\.filter\(\(mapping\) => !closureById\.has\(mapping\.mappingId\)\)/);
});

test("server selects a same-owner historical registered anchor that contains the requested period", async () => {
  const actions = await readFile(new URL("./actions.ts", import.meta.url), "utf8");
  assert.match(actions, /providerFirstMappingPeriodContains/);
  assert.match(actions, /registeredMappingResult/);
  assert.match(actions, /effective_from, effective_to, status/);
  assert.match(actions, /registeredMappings\.find/);
  assert.match(actions, /String\(mapping\.station_id \?\? ""\) === registeredStationId/);
  assert.match(actions, /mapping\.provider_id === providerId/);
  assert.match(actions, /providerMemberIdentity\(mapping\.provider_member_id\) === normalizedMemberId/);
  assert.match(actions, /providerFirstMappingPeriodContains\([\s\S]*?requestedEffectiveFrom,[\s\S]*?requestedEffectiveTo/);
  assert.match(actions, /mapping\.status === "active" && !mapping\.effective_to/);
  assert.match(actions, /mapping\.status === "closed" && Boolean\(mapping\.effective_to\)/);
  assert.match(actions, /!relevantProviderMappings\.length && !relevantTargetMappings\.length && !registeredLocationMapping/);
  assert.match(actions, /\.\.\.\(registeredLocationMapping \? \[registeredLocationMapping\] : \[\]\)/);
  assert.match(actions, /Keep all is required for an additional location/);
});

test("server and database repeat the registered-location proof for current and historical periods", async () => {
  const [actions, migration, historicalPeriodMigration] = await Promise.all([
    readFile(new URL("./actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../supabase/migrations/20261012220000_provider_mapping_registered_location_exception.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../supabase/migrations/20261013150000_provider_mapping_historical_registered_location_periods_final.sql", import.meta.url), "utf8")
  ]);
  assert.match(actions, /select\("id, dropx_id, full_name, location_id, source_profile_type, source_profile_id"\)/);
  assert.match(actions, /registeredLocationMapping = registeredMappings\.find/);
  assert.match(actions, /needsRegisteredLocationException && !registeredLocationMapping/);
  assert.match(actions, /Keep all is required for an additional location/);
  assert.match(actions, /if \(!mappingId && !options\.keepExistingLocationMappingId\)/);
  assert.match(migration, /anchor\.station_id = registered_station/);
  assert.match(migration, /mapping\.status = 'active'/);
  assert.match(migration, /mapping\.effective_to is null/);
  assert.match(migration, /anchor\.effective_from <= mapping\.effective_from/);
  assert.match(migration, /create constraint trigger field_executive_provider_mappings_03_registered_location_guard/);
  assert.match(migration, /after insert or update or delete on public\.field_executive_provider_mappings/);
  assert.match(migration, /deferrable initially deferred/);
  assert.doesNotMatch(migration, /before update of location_id on public\.workforce/);
  assert.match(historicalPeriodMigration, /create or replace function public\.workforce_assert_provider_mapping_registered_location/);
  assert.match(historicalPeriodMigration, /create or replace function public\.workforce_keep_joining_mapping/);
  assert.match(historicalPeriodMigration, /anchor\.effective_from <= mapping\.effective_from/);
  assert.match(historicalPeriodMigration, /anchor\.effective_to is null[\s\S]*anchor\.effective_to >= mapping\.effective_to/);
  assert.match(historicalPeriodMigration, /mapping\.effective_to is not null/);
  assert.match(historicalPeriodMigration, /existing_mapping\.station_id is distinct from person\.location_id/);
  assert.match(historicalPeriodMigration, /mapping_payload\.status = 'active'[\s\S]*mapping_payload\.effective_to is null/);
  assert.match(historicalPeriodMigration, /mapping_payload\.status = 'closed'[\s\S]*mapping_payload\.effective_to is not null/);
  assert.match(historicalPeriodMigration, /existing_mapping\.status = 'active' and existing_mapping\.effective_to is null/);
  assert.match(historicalPeriodMigration, /existing_mapping\.status = 'closed' and existing_mapping\.effective_to is not null/);
  assert.equal(
    (historicalPeriodMigration.match(/if mapping_payload\.effective_to is null\s+and exists \(/g) ?? []).length,
    2
  );
  assert.match(historicalPeriodMigration, /'provider_mapping_location_kept'/);
  assert.match(historicalPeriodMigration, /if mapping_payload\.status = 'active' and mapping_payload\.effective_to is null then\s+update public\.workforce/);

  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.workforce (
      id uuid primary key,
      company_id uuid not null,
      dropx_id text,
      full_name text,
      location_id uuid,
      deleted_at timestamptz,
      migration_state text default 'canonical',
      last_working_date date,
      lifecycle_status text,
      source_profile_type text,
      source_profile_id uuid,
      provider_employee_id text,
      provider_id_status text,
      updated_at timestamptz default now()
    );
    create table public.stations (
      id uuid primary key,
      company_id uuid not null,
      provider_id uuid not null
    );
    create table public.field_executive_provider_mappings (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      workforce_id uuid,
      field_executive_id uuid,
      employee_id uuid,
      contractor_id uuid,
      provider_id uuid,
      station_id uuid,
      provider_member_id text,
      effective_from date not null,
      effective_to date,
      payment_method_id uuid,
      payment_values jsonb default '{}'::jsonb,
      production_threshold_config jsonb,
      pay_type text,
      status text not null default 'active',
      created_by uuid,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    create unique index field_executive_provider_mappings_one_current_member_idx
      on public.field_executive_provider_mappings(company_id, provider_id, upper(btrim(provider_member_id)))
      where effective_to is null and status = 'active';
    create table public.workforce_joining_events (
      company_id uuid,
      workforce_id uuid,
      event_code text,
      actor_id uuid,
      actor_name text,
      details jsonb
    );
    create function public.workforce_provider_mapping_person(uuid, uuid, uuid, uuid, uuid)
    returns uuid language sql immutable as $$ select coalesce($2, $3, $4, $5) $$;
  `);
  const multiLocationMigration = await readFile(
    new URL("../../../supabase/migrations/20261009173118_workforce_provider_mapping_multi_location.sql", import.meta.url),
    "utf8"
  );
  await db.exec(multiLocationMigration);

  const company = "20000000-0000-4000-8000-000000000001";
  const provider = "20000000-0000-4000-8000-000000000002";
  const otherProvider = "20000000-0000-4000-8000-000000000003";
  const workerA = "20000000-0000-4000-8000-000000000004";
  const workerB = "20000000-0000-4000-8000-000000000005";
  const workerNoLocation = "20000000-0000-4000-8000-000000000006";
  const stationA = "20000000-0000-4000-8000-000000000007";
  const stationB = "20000000-0000-4000-8000-000000000008";
  const stationC = "20000000-0000-4000-8000-000000000009";
  const stationD = "20000000-0000-4000-8000-000000000010";
  const actor = "20000000-0000-4000-8000-000000000011";
  const paymentMethod = "20000000-0000-4000-8000-000000000012";
  const workerHistorical = "20000000-0000-4000-8000-000000000013";
  const workerWrongOwner = "20000000-0000-4000-8000-000000000014";
  const historicalAnchor = "20000000-0000-4000-8000-000000000015";
  const wrongOwnerAnchor = "20000000-0000-4000-8000-000000000016";
  const cancelledAnchor = "20000000-0000-4000-8000-000000000017";
  const workerAnchorOwner = "20000000-0000-4000-8000-000000000018";
  const workerClosedOpen = "20000000-0000-4000-8000-000000000019";
  const workerActiveBounded = "20000000-0000-4000-8000-000000000020";
  const closedOpenAnchor = "20000000-0000-4000-8000-000000000021";
  const activeBoundedAnchor = "20000000-0000-4000-8000-000000000022";
  await db.exec(`
    insert into public.workforce(id,company_id,dropx_id,location_id) values
      ('${workerA}','${company}','DX-A','${stationA}'),
      ('${workerB}','${company}','DX-B','${stationC}'),
      ('${workerNoLocation}','${company}','DX-N',null),
      ('${workerHistorical}','${company}','DX-H','${stationA}'),
      ('${workerWrongOwner}','${company}','DX-W','${stationA}'),
      ('${workerAnchorOwner}','${company}','DX-O','${stationA}'),
      ('${workerClosedOpen}','${company}','DX-CO','${stationA}'),
      ('${workerActiveBounded}','${company}','DX-AB','${stationA}');
    insert into public.stations(id,company_id,provider_id) values
      ('${stationA}','${company}','${provider}'),
      ('${stationB}','${company}','${provider}'),
      ('${stationC}','${company}','${provider}'),
      ('${stationD}','${company}','${provider}');
    insert into public.field_executive_provider_mappings(
      company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from
    ) values
      ('${company}','${workerA}','${provider}','${stationA}','MEMBER-1','2026-09-01'),
      ('${company}','${workerB}','${provider}','${stationB}','MEMBER-2','2026-09-01');
  `);
  await db.exec(migration);
  await db.exec(historicalPeriodMigration);

  await db.exec(`
    insert into public.field_executive_provider_mappings(
      company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from
    ) values ('${company}','${workerA}','${provider}','${stationB}',' member-1 ','2026-09-01');
  `);
  await assert.rejects(db.exec(`
    update public.field_executive_provider_mappings
    set status = 'closed', effective_to = '2026-10-01'
    where workforce_id = '${workerA}' and station_id = '${stationA}';
  `), /registered-location mapping/);
  await assert.rejects(db.exec(`
    delete from public.field_executive_provider_mappings
    where workforce_id = '${workerA}' and station_id = '${stationA}';
  `), /registered-location mapping/);
  await assert.rejects(db.exec(`
    update public.field_executive_provider_mappings
    set effective_from = '2026-10-01'
    where workforce_id = '${workerA}' and station_id = '${stationA}';
  `), /registered-location mapping/);
  await assert.rejects(db.exec(`
    insert into public.field_executive_provider_mappings(
      company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from
    ) values ('${company}','${workerA}','${provider}','${stationC}','MEMBER-X','2026-09-01');
  `), /registered location/);
  await assert.rejects(db.exec(`
    insert into public.field_executive_provider_mappings(
      company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from
    ) values ('${company}','${workerA}','${otherProvider}','${stationC}','MEMBER-1','2026-09-01');
  `), /registered location/);
  await assert.rejects(db.exec(`
    insert into public.field_executive_provider_mappings(
      company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from
    ) values ('${company}','${workerB}','${provider}','${stationD}','MEMBER-2','2026-09-01');
  `), /registered location/);
  await assert.rejects(db.exec(`
    insert into public.field_executive_provider_mappings(
      company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from
    ) values ('${company}','${workerB}','${provider}','${stationC}','MEMBER-2','2026-10-01');
  `), /cover the full additional-location mapping period/);
  await assert.rejects(db.exec(`
    insert into public.field_executive_provider_mappings(
      company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from
    ) values ('${company}','${workerNoLocation}','${provider}','${stationD}','MEMBER-3','2026-09-01');
  `), /no registered location/);

  // Keep all continues to use the existing RPC. Its deferred trigger observes
  // the registered-location anchor after the whole RPC statement completes.
  await db.exec(`
    select public.workforce_keep_joining_mapping(
      '${company}', '${actor}', '${workerA}',
      (select id from public.field_executive_provider_mappings
       where workforce_id = '${workerA}' and station_id = '${stationA}'),
      'DX-A',
      jsonb_build_object(
        'provider_id', '${provider}',
        'station_id', '${stationD}',
        'provider_member_id', ' MEMBER-1 ',
        'effective_from', '2026-09-15',
        'effective_to', null,
        'payment_method_id', '${paymentMethod}',
        'payment_values', '{}'::jsonb,
        'status', 'active'
      ),
      null::uuid[],
      'Registered location test'
    );
  `);
  const kept = await db.query(`
    select count(*)::integer as count
    from public.field_executive_provider_mappings
    where workforce_id = '${workerA}' and station_id = '${stationD}'
      and status = 'active' and effective_to is null;
  `);
  assert.equal(kept.rows[0].count, 1);

  // A closed registered-location mapping can anchor Keep all only when its
  // inclusive dates cover the complete bounded destination period.
  await db.exec(`
    insert into public.field_executive_provider_mappings(
      id,company_id,workforce_id,provider_id,station_id,provider_member_id,
      effective_from,effective_to,payment_method_id,status
    ) values (
      '${historicalAnchor}','${company}','${workerHistorical}','${provider}',
      '${stationA}','MEMBER-H','2026-09-01','2026-09-30','${paymentMethod}','closed'
    );
  `);
  await db.exec(`
    select public.workforce_keep_joining_mapping(
      '${company}', '${actor}', '${workerHistorical}', '${historicalAnchor}', 'DX-H',
      jsonb_build_object(
        'provider_id', '${provider}',
        'station_id', '${stationB}',
        'provider_member_id', ' member-h ',
        'effective_from', '2026-09-01',
        'effective_to', '2026-09-30',
        'payment_method_id', '${paymentMethod}',
        'payment_values', '{}'::jsonb,
        'status', 'closed'
      ),
      null::uuid[],
      'Historical exact-period test'
    );
  `);
  await db.exec(`
    select public.workforce_keep_joining_mapping(
      '${company}', '${actor}', '${workerHistorical}', '${historicalAnchor}', 'DX-H',
      jsonb_build_object(
        'provider_id', '${provider}',
        'station_id', '${stationD}',
        'provider_member_id', 'MEMBER-H',
        'effective_from', '2026-09-10',
        'effective_to', '2026-09-20',
        'payment_method_id', '${paymentMethod}',
        'payment_values', '{}'::jsonb,
        'status', 'closed'
      ),
      null::uuid[],
      'Historical narrower-period test'
    );
  `);
  // A current mapping that starts after the requested historical period must
  // not block a bounded repair using the exact historical anchor.
  await db.exec(`
    insert into public.field_executive_provider_mappings(
      company_id,workforce_id,provider_id,station_id,provider_member_id,
      effective_from,payment_method_id,status
    ) values (
      '${company}','${workerHistorical}','${provider}','${stationA}','MEMBER-FUTURE',
      '2026-10-01','${paymentMethod}','active'
    );
    update public.workforce
    set provider_employee_id = 'MEMBER-FUTURE', provider_id_status = 'created'
    where id = '${workerHistorical}';
  `);
  await db.exec(`
    select public.workforce_keep_joining_mapping(
      '${company}', '${actor}', '${workerHistorical}', '${historicalAnchor}', 'DX-H',
      jsonb_build_object(
        'provider_id', '${provider}',
        'station_id', '${stationC}',
        'provider_member_id', 'MEMBER-H',
        'effective_from', '2026-09-05',
        'effective_to', '2026-09-06',
        'payment_method_id', '${paymentMethod}',
        'payment_values', '{}'::jsonb,
        'status', 'closed'
      ),
      null::uuid[],
      'Historical repair with later current identity'
    );
  `);
  const historicalDependents = await db.query(`
    select station_id, effective_from::text as effective_from,
      effective_to::text as effective_to, status
    from public.field_executive_provider_mappings
    where workforce_id = '${workerHistorical}'
      and station_id <> '${stationA}'
    order by effective_from, station_id;
  `);
  assert.deepEqual(historicalDependents.rows, [
    { station_id: stationB, effective_from: "2026-09-01", effective_to: "2026-09-30", status: "closed" },
    { station_id: stationC, effective_from: "2026-09-05", effective_to: "2026-09-06", status: "closed" },
    { station_id: stationD, effective_from: "2026-09-10", effective_to: "2026-09-20", status: "closed" }
  ]);
  const preservedCurrentIdentity = await db.query(`
    select provider_employee_id, provider_id_status
    from public.workforce
    where id = '${workerHistorical}';
  `);
  assert.deepEqual(preservedCurrentIdentity.rows, [{
    provider_employee_id: "MEMBER-FUTURE",
    provider_id_status: "created"
  }]);
  const historicalEvents = await db.query(`
    select count(*)::integer as count
    from public.workforce_joining_events
    where workforce_id = '${workerHistorical}'
      and event_code = 'provider_mapping_location_kept';
  `);
  assert.equal(historicalEvents.rows[0].count, 3);

  const keepHistorical = ({
    expectedMapping = historicalAnchor,
    workforce = workerHistorical,
    dropx = "DX-H",
    providerId = provider,
    memberId = "MEMBER-H",
    from,
    to,
    status,
    station = stationC
  }) => db.exec(`
    select public.workforce_keep_joining_mapping(
      '${company}', '${actor}', '${workforce}', '${expectedMapping}', '${dropx}',
      jsonb_build_object(
        'provider_id', '${providerId}',
        'station_id', '${station}',
        'provider_member_id', '${memberId}',
        'effective_from', '${from}',
        'effective_to', ${to === null ? "null" : `'${to}'`},
        'payment_method_id', '${paymentMethod}',
        'payment_values', '{}'::jsonb,
        'status', '${status}'
      ),
      null::uuid[],
      'Historical rejection test'
    );
  `);

  await assert.rejects(keepHistorical({ from: "2026-07-01", to: "2026-07-31", status: "closed" }), /period|contain|mapping/i);
  await assert.rejects(keepHistorical({ from: "2026-10-01", to: "2026-10-31", status: "closed" }), /period|contain|mapping/i);
  await assert.rejects(keepHistorical({ from: "2026-09-01", to: null, status: "active" }), /period|contain|mapping/i);
  await assert.rejects(keepHistorical({ memberId: "MEMBER-X", from: "2026-09-01", to: "2026-09-30", status: "closed" }), /mapping|provider/i);
  await assert.rejects(keepHistorical({ providerId: otherProvider, from: "2026-09-01", to: "2026-09-30", status: "closed" }), /provider|station|mapping/i);

  // Status and end-date shape are part of the trust boundary: malformed
  // closed/open or active/bounded rows cannot serve as registered anchors.
  await db.exec(`
    insert into public.field_executive_provider_mappings(
      id,company_id,workforce_id,provider_id,station_id,provider_member_id,
      effective_from,effective_to,payment_method_id,status
    ) values
      ('${closedOpenAnchor}','${company}','${workerClosedOpen}','${provider}','${stationA}',
       'MEMBER-CO','2026-09-01',null,'${paymentMethod}','closed'),
      ('${activeBoundedAnchor}','${company}','${workerActiveBounded}','${provider}','${stationA}',
       'MEMBER-AB','2026-09-01','2026-09-30','${paymentMethod}','active');
  `);
  await assert.rejects(keepHistorical({
    expectedMapping: closedOpenAnchor,
    workforce: workerClosedOpen,
    dropx: "DX-CO",
    memberId: "MEMBER-CO",
    from: "2026-09-01",
    to: "2026-09-30",
    status: "closed"
  }), /mapping|confirmation/i);
  await assert.rejects(keepHistorical({
    expectedMapping: activeBoundedAnchor,
    workforce: workerActiveBounded,
    dropx: "DX-AB",
    memberId: "MEMBER-AB",
    from: "2026-09-01",
    to: "2026-09-30",
    status: "closed"
  }), /mapping|confirmation/i);

  await db.exec(`
    insert into public.field_executive_provider_mappings(
      id,company_id,workforce_id,provider_id,station_id,provider_member_id,
      effective_from,effective_to,payment_method_id,status
    ) values
      ('${wrongOwnerAnchor}','${company}','${workerAnchorOwner}','${provider}','${stationA}',
       'MEMBER-W','2026-09-01','2026-09-30','${paymentMethod}','closed'),
      ('${cancelledAnchor}','${company}','${workerHistorical}','${provider}','${stationA}',
       'MEMBER-C','2026-09-01','2026-09-30','${paymentMethod}','cancelled');
  `);
  await assert.rejects(keepHistorical({
    expectedMapping: wrongOwnerAnchor,
    workforce: workerWrongOwner,
    dropx: "DX-W",
    memberId: "MEMBER-W",
    from: "2026-09-01",
    to: "2026-09-30",
    status: "closed"
  }), /mapping|profile|confirmation/i);
  await assert.rejects(keepHistorical({
    expectedMapping: cancelledAnchor,
    memberId: "MEMBER-C",
    from: "2026-09-01",
    to: "2026-09-30",
    status: "closed"
  }), /mapping|confirmation/i);

  await assert.rejects(db.exec(`
    update public.field_executive_provider_mappings
    set effective_to = '2026-09-15'
    where id = '${historicalAnchor}';
  `), /registered-location mapping|registered location/i);
  await assert.rejects(db.exec(`
    delete from public.field_executive_provider_mappings
    where id = '${historicalAnchor}';
  `), /registered-location mapping|registered location/i);

  // Profile transfers remain independent; the provider-mapping worksheet can
  // reconcile a moved profile through its existing atomic correction flow.
  await db.exec(`update public.workforce set location_id = '${stationC}' where id = '${workerA}';`);
  await db.exec(`
    begin;
    update public.field_executive_provider_mappings
    set status = 'closed', effective_to = '2026-09-30'
    where workforce_id = '${workerA}' and status = 'active' and effective_to is null;
    insert into public.field_executive_provider_mappings(
      company_id,workforce_id,provider_id,station_id,provider_member_id,
      effective_from,payment_method_id,status
    ) values (
      '${company}','${workerA}','${provider}','${stationC}','MEMBER-1',
      '2026-10-01','${paymentMethod}','active'
    );
    commit;
  `);
  const moved = await db.query(`
    select station_id, status, effective_from::text as effective_from
    from public.field_executive_provider_mappings
    where workforce_id = '${workerA}' and status = 'active' and effective_to is null;
  `);
  assert.deepEqual(moved.rows, [{ station_id: stationC, status: "active", effective_from: "2026-10-01" }]);

  await db.close();
});
