import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrations = await Promise.all([
  "../../../supabase/migrations/20261012220000_provider_mapping_registered_location_exception.sql",
  "../../../supabase/migrations/20261013150000_provider_mapping_historical_registered_location_periods_final.sql",
  "../../../supabase/migrations/20261015150000_provider_mapping_keep_registered_location.sql"
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

async function database() {
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
      delivery_rate numeric,
      pickup_rate numeric,
      mfn_rate numeric,
      mfn_return_rate numeric,
      guarantee_amount numeric,
      guarantee_schedule text,
      fuel_rate numeric,
      reason text,
      status text not null default 'active',
      created_by uuid,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    create unique index field_executive_provider_mappings_one_current_member_station_idx
      on public.field_executive_provider_mappings(
        company_id, provider_id, station_id, upper(btrim(provider_member_id))
      ) where effective_to is null and status = 'active';
    create table public.workforce_joining_events (
      company_id uuid,
      workforce_id uuid,
      event_code text,
      actor_id uuid,
      actor_name text,
      details jsonb
    );
    create table public.test_paid_history (
      id uuid primary key default gen_random_uuid(),
      mapping_id uuid not null references public.field_executive_provider_mappings(id),
      paid_amount numeric not null
    );
    create or replace function public.workforce_provider_mapping_person(
      p_company uuid,
      p_workforce uuid,
      p_field_executive uuid,
      p_employee uuid,
      p_contractor uuid
    ) returns uuid language sql stable as $$ select p_workforce $$;
  `);
  for (const migration of migrations) await db.exec(migration);
  return db;
}

const company = "20000000-0000-4000-8000-000000000001";
const provider = "20000000-0000-4000-8000-000000000002";
const worker = "20000000-0000-4000-8000-000000000003";
const registeredStation = "20000000-0000-4000-8000-000000000004";
const oldStation = "20000000-0000-4000-8000-000000000005";
const secondStation = "20000000-0000-4000-8000-000000000006";
const actor = "20000000-0000-4000-8000-000000000007";
const oldMethod = "20000000-0000-4000-8000-000000000008";
const newMethod = "20000000-0000-4000-8000-000000000009";
const expectedMapping = "20000000-0000-4000-8000-000000000010";
const secondMapping = "20000000-0000-4000-8000-000000000011";
const otherWorker = "20000000-0000-4000-8000-000000000012";

async function seed(db) {
  await db.exec(`
    insert into public.workforce(
      id, company_id, dropx_id, full_name, location_id, lifecycle_status
    ) values
      ('${worker}', '${company}', 'DX-101', 'Worker One', '${registeredStation}', 'active'),
      ('${otherWorker}', '${company}', 'DX-102', 'Worker Two', '${registeredStation}', 'active');
    insert into public.stations(id, company_id, provider_id) values
      ('${registeredStation}', '${company}', '${provider}'),
      ('${oldStation}', '${company}', '${provider}'),
      ('${secondStation}', '${company}', '${provider}');
    alter table public.field_executive_provider_mappings
      disable trigger field_executive_provider_mappings_03_registered_location_guard;
    insert into public.field_executive_provider_mappings(
      id, company_id, workforce_id, provider_id, station_id,
      provider_member_id, effective_from, payment_method_id, payment_values,
      production_threshold_config, pay_type, delivery_rate, status, created_by
    ) values
      (
        '${expectedMapping}', '${company}', '${worker}', '${provider}', '${oldStation}',
        ' MEMBER-101 ', '2026-08-01', '${oldMethod}', '{"DELIVERY":15}',
        '{"period":"month","component_codes":["DELIVERY"],"minimum_units":100}',
        'PER_PACKET', 15, 'active', '${actor}'
      ),
      (
        '${secondMapping}', '${company}', '${worker}', '${provider}', '${secondStation}',
        'MEMBER-101', '2026-11-15', '${oldMethod}', '{"DELIVERY":18}',
        null, 'PER_PACKET', 18, 'active', '${actor}'
      );
    alter table public.field_executive_provider_mappings
      enable trigger field_executive_provider_mappings_03_registered_location_guard;
    insert into public.test_paid_history(mapping_id, paid_amount)
    values ('${expectedMapping}', 12500);
  `);
}

function keepAtRegisteredLocation({
  db,
  locations = [registeredStation, oldStation, secondStation],
  expected = expectedMapping,
  member = "member-101",
  station = registeredStation
}) {
  const scopedLocations = locations === null
    ? "null::uuid[]"
    : `array[${locations.map((id) => `'${id}'::uuid`).join(",")}]`;
  return db.exec(`
    select public.workforce_keep_joining_mapping_at_registered_location(
      '${company}', '${actor}', '${worker}', '${expected}', 'DX-101',
      jsonb_build_object(
        'provider_id', '${provider}',
        'station_id', '${station}',
        'provider_member_id', '${member}',
        'effective_from', '2026-10-01',
        'effective_to', null,
        'payment_method_id', '${newMethod}',
        'payment_values', jsonb_build_object('DELIVERY', 25),
        'production_threshold_config', null,
        'pay_type', 'PER_PACKET',
        'status', 'active'
      ),
      ${scopedLocations},
      'Mapping reviewer'
    );
  `);
}

async function currentRows(db) {
  return (await db.query(`
    select id::text, station_id::text, workforce_id::text, provider_member_id,
      effective_from::text, effective_to::text, status, payment_method_id::text,
      payment_values, delivery_rate
    from public.field_executive_provider_mappings
    order by station_id, effective_from, id;
  `)).rows;
}

test("reverse Keep all adds only the registered anchor and preserves every mapping ID, period and paid-history reference", async () => {
  const db = await database();
  await seed(db);
  const before = await currentRows(db);
  await keepAtRegisteredLocation({ db });
  const after = await currentRows(db);

  assert.equal(after.length, 3);
  assert.deepEqual(after.filter(({ id }) => id === expectedMapping || id === secondMapping), before);
  const anchor = after.find(({ station_id }) => station_id === registeredStation);
  assert.deepEqual(anchor, {
    id: anchor.id,
    station_id: registeredStation,
    workforce_id: worker,
    provider_member_id: "member-101",
    effective_from: "2026-10-01",
    effective_to: null,
    status: "active",
    payment_method_id: newMethod,
    payment_values: { DELIVERY: 25 },
    delivery_rate: null
  });

  const paidHistory = await db.query(`select mapping_id::text, paid_amount from public.test_paid_history;`);
  assert.deepEqual(paidHistory.rows, [{ mapping_id: expectedMapping, paid_amount: "12500" }]);

  const events = await db.query(`
    select details from public.workforce_joining_events
    where event_code = 'provider_mapping_location_kept'
    order by details ->> 'new_station_id';
  `);
  assert.equal(events.rows.length, 2);
  assert.ok(events.rows.every(({ details }) => (
    details.keep_direction === "registered_anchor_added"
      && details.registered_mapping_id === anchor.id
      && [expectedMapping, secondMapping].includes(details.additional_mapping_id)
      && details.registered_station_id === registeredStation
      && [oldStation, secondStation].includes(details.additional_station_id)
      && details.existing_mapping_id === anchor.id
      && details.existing_station_id === registeredStation
      && details.provider_id === provider
      && details.provider_member_id === "member-101"
      && details.effective_from === "2026-10-01"
  )));
  assert.deepEqual(new Set(events.rows.map(({ details }) => details.new_mapping_id)), new Set([
    expectedMapping,
    secondMapping
  ]));
  assert.deepEqual(new Set(events.rows.map(({ details }) => details.concurrent_from)), new Set([
    "2026-10-01",
    "2026-11-15"
  ]));
  await db.exec(`select public.workforce_assert_provider_mapping_registered_location('${company}', '${worker}');`);
});

test("closed reverse-Keep history remains valid after a later legitimate registered-location change", async () => {
  const db = await database();
  await seed(db);
  await keepAtRegisteredLocation({ db });
  const anchor = (await currentRows(db)).find(({ station_id }) => station_id === registeredStation);

  await db.exec(`
    begin;
    update public.field_executive_provider_mappings
    set effective_to = '2026-12-31', status = 'closed'
    where company_id = '${company}' and workforce_id = '${worker}';
    update public.workforce
    set location_id = '${secondStation}'
    where company_id = '${company}' and id = '${worker}';
    insert into public.field_executive_provider_mappings(
      company_id, workforce_id, provider_id, station_id, provider_member_id,
      effective_from, payment_method_id, payment_values, pay_type, status, created_by
    ) values (
      '${company}', '${worker}', '${provider}', '${secondStation}', 'MEMBER-202',
      '2027-01-01', '${newMethod}', '{"DELIVERY":30}', 'PER_PACKET', 'active', '${actor}'
    );
    commit;
  `);

  await db.exec(`select public.workforce_assert_provider_mapping_registered_location('${company}', '${worker}');`);
  const historical = await db.query(`
    select id::text, effective_from::text, effective_to::text, status
    from public.field_executive_provider_mappings
    where id in ('${expectedMapping}', '${secondMapping}', '${anchor.id}')
    order by id;
  `);
  assert.deepEqual(historical.rows, [
    { id: expectedMapping, effective_from: "2026-08-01", effective_to: "2026-12-31", status: "closed" },
    { id: secondMapping, effective_from: "2026-11-15", effective_to: "2026-12-31", status: "closed" },
    { id: anchor.id, effective_from: "2026-10-01", effective_to: "2026-12-31", status: "closed" }
  ].sort((a, b) => a.id.localeCompare(b.id)));
});

test("reverse Keep all rejects stale identity, member and destination confirmations", async () => {
  for (const [label, overrides, pattern] of [
    ["stale mapping", { expected: actor }, /changed after confirmation/],
    ["wrong member", { member: "MEMBER-OTHER" }, /changed after confirmation/],
    ["wrong destination", { station: oldStation }, /registered location/]
  ]) {
    const db = await database();
    await seed(db);
    await assert.rejects(keepAtRegisteredLocation({ db, ...overrides }), pattern, label);
    assert.deepEqual(await currentRows(db), (await currentRows(db)).filter(({ id }) => id !== ""));
    assert.equal((await currentRows(db)).length, 2);
  }
});

test("reverse Keep all rejects an origin mapping that ended before the requested effective date", async () => {
  const db = await database();
  await seed(db);
  await db.exec(`
    alter table public.field_executive_provider_mappings
      disable trigger field_executive_provider_mappings_03_registered_location_guard;
    update public.field_executive_provider_mappings
    set effective_to = '2026-09-30', status = 'closed'
    where id = '${expectedMapping}';
    alter table public.field_executive_provider_mappings
      enable trigger field_executive_provider_mappings_03_registered_location_guard;
  `);

  const before = await currentRows(db);
  await assert.rejects(
    keepAtRegisteredLocation({ db }),
    /additional-location mapping changed after confirmation/i
  );
  assert.deepEqual(await currentRows(db), before);
  assert.equal(
    (await db.query(`select count(*)::integer as count from public.workforce_joining_events;`)).rows[0].count,
    0
  );
});

test("reverse Keep all fails closed when any retained location is outside the reviewer's scope", async () => {
  const db = await database();
  await seed(db);
  const before = await currentRows(db);
  await assert.rejects(
    keepAtRegisteredLocation({ db, locations: [registeredStation, oldStation] }),
    /outside your station scope/
  );
  assert.deepEqual(await currentRows(db), before);
  assert.equal((await db.query(`select count(*)::integer as count from public.workforce_joining_events;`)).rows[0].count, 0);
});

test("reverse Keep all retains existing mapping-trigger payment locks and rolls back atomically", async () => {
  const db = await database();
  await seed(db);
  const before = await currentRows(db);
  await db.exec(`
    create function public.test_locked_payment_guard()
    returns trigger language plpgsql as $$
    begin
      if new.station_id = '${registeredStation}' then
        raise exception 'published payout is locked';
      end if;
      return new;
    end $$;
    create trigger test_locked_payment_guard
      before insert on public.field_executive_provider_mappings
      for each row execute function public.test_locked_payment_guard();
  `);
  await assert.rejects(keepAtRegisteredLocation({ db }), /published payout is locked/);
  assert.deepEqual(await currentRows(db), before);
  assert.equal((await db.query(`select count(*)::integer as count from public.workforce_joining_events;`)).rows[0].count, 0);
});

test("a later registered anchor requires the audited reverse-Keep link and remains protected while additional mappings are open", async () => {
  const unaudited = await database();
  await seed(unaudited);
  await assert.rejects(unaudited.exec(`
    insert into public.field_executive_provider_mappings(
      company_id, workforce_id, provider_id, station_id, provider_member_id,
      effective_from, payment_method_id, payment_values, pay_type, status, created_by
    ) values (
      '${company}', '${worker}', '${provider}', '${registeredStation}', 'MEMBER-101',
      '2026-10-01', '${newMethod}', '{"DELIVERY":25}', 'PER_PACKET', 'active', '${actor}'
    );
  `), /registered-location mapping/i);
  assert.equal((await currentRows(unaudited)).length, 2);

  for (const [label, mutation] of [
    ["close", "update public.field_executive_provider_mappings set status = 'closed', effective_to = '2026-12-31' where id = $1"],
    ["cancel", "update public.field_executive_provider_mappings set status = 'cancelled' where id = $1"],
    ["delete", "delete from public.field_executive_provider_mappings where id = $1"]
  ]) {
    const db = await database();
    await seed(db);
    await keepAtRegisteredLocation({ db });
    const anchor = (await currentRows(db)).find(({ station_id }) => station_id === registeredStation);
    const sql = mutation.replace("$1", `'${anchor.id}'`);
    await assert.rejects(db.exec(sql), /registered-location mapping/i, label);
    const unchangedAnchor = (await currentRows(db)).find(({ id }) => id === anchor.id);
    assert.equal(unchangedAnchor?.status, "active");
    assert.equal(unchangedAnchor?.effective_to, null);
  }
});

test("reverse Keep audit proof is exact and cannot be forged across anchor owner, member, location or ID", async () => {
  const corruptions = [
    ["wrong anchor owner", async (db, anchorId) => {
      await db.exec(`alter table public.field_executive_provider_mappings disable trigger field_executive_provider_mappings_03_registered_location_guard; update public.field_executive_provider_mappings set workforce_id = '${otherWorker}' where id = '${anchorId}'; alter table public.field_executive_provider_mappings enable trigger field_executive_provider_mappings_03_registered_location_guard;`);
    }],
    ["wrong event member", (db) => db.exec(`update public.workforce_joining_events set details = jsonb_set(details, '{provider_member_id}', '"MEMBER-OTHER"');`)],
    ["wrong event location", (db) => db.exec(`update public.workforce_joining_events set details = jsonb_set(details, '{registered_station_id}', '"${oldStation}"');`)],
    ["stale anchor ID", (db) => db.exec(`update public.workforce_joining_events set details = jsonb_set(details, '{registered_mapping_id}', '"${actor}"');`)],
    ["forged concurrent boundary", (db) => db.exec(`update public.workforce_joining_events set details = jsonb_set(details, '{concurrent_from}', '"2027-01-01"');`)]
  ];

  for (const [label, corrupt] of corruptions) {
    const db = await database();
    await seed(db);
    await keepAtRegisteredLocation({ db });
    const anchor = (await currentRows(db)).find(({ station_id }) => station_id === registeredStation);
    await corrupt(db, anchor.id);
    await assert.rejects(
      db.exec(`select public.workforce_assert_provider_mapping_registered_location('${company}', '${worker}');`),
      /registered-location mapping/i,
      label
    );
  }
});

test("the reverse Keep all RPC remains service-role-only", () => {
  const migration = migrations.at(-1);
  assert.match(migration, /revoke all on function public\.workforce_keep_joining_mapping_at_registered_location\([\s\S]*?from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.workforce_keep_joining_mapping_at_registered_location\([\s\S]*?to service_role/);
  assert.match(migration, /'keep_direction', 'registered_anchor_added'/);
  assert.doesNotMatch(migration, /update public\.field_executive_provider_mappings/);
});
