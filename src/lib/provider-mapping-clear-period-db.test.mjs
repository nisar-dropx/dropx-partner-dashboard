import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = (name) => readFile(
  new URL(`../../supabase/migrations/${name}`, import.meta.url),
  "utf8"
);

const id = (value) => `71000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const company = id(1);
const provider = id(2);
const actor = id(3);
const registeredStation = id(4);
const additionalStation = id(5);
const otherStation = id(6);
const methodA = id(7);
const methodB = id(8);
const worker = id(10);
const otherWorker = id(11);
const anchorWorker = id(12);
const scheduledWorker = id(13);
const futureOnlyWorker = id(14);
const historicalMapping = id(20);
const currentMapping = id(21);
const soleMapping = id(22);
const anchorMapping = id(23);
const dependentMapping = id(24);
const malformedMapping = id(25);
const scheduledCurrentMapping = id(26);
const scheduledFutureMapping = id(27);
const clearingCurrentMapping = id(28);
const futureOnlyMapping = id(29);
const mappingVersion = "2026-10-20T04:00:00.000Z";

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
      source_profile_type text,
      source_profile_id uuid,
      provider_employee_id text,
      provider_id_status text,
      updated_at timestamptz default now()
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
    create table public.workforce_joining_events (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      workforce_id uuid,
      event_code text,
      actor_id uuid,
      actor_name text,
      details jsonb,
      created_at timestamptz default now()
    );
    create unique index field_executive_provider_mappings_one_current_member_station_idx
      on public.field_executive_provider_mappings(
        company_id, provider_id, station_id, upper(btrim(provider_member_id))
      ) where effective_to is null and status = 'active';

    create or replace function public.workforce_provider_mapping_person(
      p_company uuid,
      p_workforce uuid,
      p_field_executive uuid,
      p_employee uuid,
      p_contractor uuid
    ) returns uuid language sql stable
    as $$ select coalesce(p_workforce, p_field_executive, p_employee, p_contractor) $$;
  `);

  // Install the deployed deferred registered-location trigger, its final
  // contiguous-period implementation, and then the period-clear RPC.
  await db.exec(await migration("20261012220000_provider_mapping_registered_location_exception.sql"));
  await db.exec(await migration("20261016100000_provider_mapping_contiguous_coverage_final.sql"));
  await db.exec(await migration("20261021103000_provider_mapping_registered_anchor_legacy_keep.sql"));
  const clearPeriodMigration = await migration("20261021120000_workforce_clear_mapping_period.sql");
  await db.exec(clearPeriodMigration);
  // Shared Supabase migrations are applied one file at a time and must remain
  // safe when an interrupted deployment retries the same file.
  await db.exec(clearPeriodMigration);

  await db.exec(`
    insert into public.workforce(
      id, company_id, dropx_id, location_id, provider_employee_id, provider_id_status
    ) values
      ('${worker}', '${company}', 'DX-CLEAR-1', '${registeredStation}', 'MEMBER-1', 'created'),
      ('${otherWorker}', '${company}', 'DX-CLEAR-2', '${otherStation}', 'MEMBER-2', 'created'),
      ('${anchorWorker}', '${company}', 'DX-CLEAR-3', '${registeredStation}', 'MEMBER-3', 'created');

    insert into public.field_executive_provider_mappings(
      id, company_id, workforce_id, provider_id, station_id,
      provider_member_id, effective_from, effective_to, payment_method_id,
      payment_values, production_threshold_config, pay_type, status, created_by,
      updated_at
    ) values
      (
        '${historicalMapping}', '${company}', '${worker}', '${provider}', '${registeredStation}',
        'MEMBER-1', '2026-09-01', '2026-09-30', '${methodA}',
        '{"DELIVERY":15}', '{"minimum_units":50}', 'PER_PACKET', 'closed', '${actor}',
        '${mappingVersion}'
      ),
      (
        '${currentMapping}', '${company}', '${worker}', '${provider}', '${registeredStation}',
        'MEMBER-1', '2026-10-01', null, '${methodB}',
        '{"DELIVERY":18}', null, 'PER_PACKET', 'active', '${actor}',
        '${mappingVersion}'
      ),
      (
        '${soleMapping}', '${company}', '${otherWorker}', '${provider}', '${otherStation}',
        'MEMBER-2', '2026-10-01', null, '${methodA}',
        '{"DELIVERY":20}', null, 'PER_PACKET', 'active', '${actor}',
        '${mappingVersion}'
      ),
      (
        '${anchorMapping}', '${company}', '${anchorWorker}', '${provider}', '${registeredStation}',
        'MEMBER-3', '2026-10-01', null, '${methodA}',
        '{"DELIVERY":21}', null, 'PER_PACKET', 'active', '${actor}',
        '${mappingVersion}'
      ),
      (
        '${dependentMapping}', '${company}', '${anchorWorker}', '${provider}', '${additionalStation}',
        'MEMBER-3', '2026-10-01', null, '${methodA}',
        '{"DELIVERY":21}', null, 'PER_PACKET', 'active', '${actor}',
        '${mappingVersion}'
      ),
      (
        '${malformedMapping}', '${company}', '${otherWorker}', '${provider}', '${registeredStation}',
        'MEMBER-MALFORMED', '2026-08-01', '2026-08-31', '${methodA}',
        '{"DELIVERY":9}', null, 'PER_PACKET', 'active', '${actor}',
        '${mappingVersion}'
      );
  `);
  return db;
}

const call = (db, {
  workforce = worker,
  mapping = historicalMapping,
  expectedUpdatedAt = mappingVersion,
  locations = [registeredStation]
} = {}) => {
  const scope = locations === null
    ? "null::uuid[]"
    : `array[${locations.map((location) => `'${location}'::uuid`).join(",")}]`;
  return db.query(`
    select public.workforce_clear_mapping_period(
      '${company}', '${actor}', '${workforce}', '${mapping}',
      '${expectedUpdatedAt}'::timestamptz, ${scope}, 'Period reviewer'
    ) as result;
  `);
};

test("clears one exact mapping period while preserving history and recomputing the current provider", async () => {
  const db = await database();
  try {
    const before = (await db.query(`
      select effective_from::text, effective_to::text, payment_method_id::text,
        payment_values, production_threshold_config, pay_type
      from public.field_executive_provider_mappings where id = '${historicalMapping}';
    `)).rows[0];

    const result = (await call(db)).rows[0].result;
    assert.deepEqual(result, {
      mapping_id: historicalMapping,
      disposition: "cancelled",
      original_status: "closed",
      effective_from: "2026-09-01",
      effective_to: "2026-09-30",
      payment_method_id: methodA,
      payment_values: { DELIVERY: 15 },
      remaining_mapping: {
        mapping_id: currentMapping,
        provider_id: provider,
        provider_member_id: "MEMBER-1",
        station_id: registeredStation,
        effective_from: "2026-10-01",
        effective_to: null,
        status: "active",
        payment_method_id: methodB,
        payment_values: { DELIVERY: 18 }
      }
    });

    const after = (await db.query(`
      select effective_from::text, effective_to::text, payment_method_id::text,
        payment_values, production_threshold_config, pay_type, status
      from public.field_executive_provider_mappings where id = '${historicalMapping}';
    `)).rows[0];
    assert.deepEqual(after, { ...before, status: "cancelled" });

    assert.deepEqual((await db.query(`
      select provider_employee_id, provider_id_status
      from public.workforce where id = '${worker}';
    `)).rows, [{ provider_employee_id: "MEMBER-1", provider_id_status: "created" }]);

    const event = (await db.query(`
      select event_code, actor_id::text, actor_name, details
      from public.workforce_joining_events
      where workforce_id = '${worker}' and event_code = 'provider_mapping_period_cleared';
    `)).rows[0];
    assert.equal(event.event_code, "provider_mapping_period_cleared");
    assert.equal(event.actor_id, actor);
    assert.equal(event.actor_name, "Period reviewer");
    assert.equal(event.details.original_status, "closed");
    assert.equal(event.details.original_effective_from, "2026-09-01");
    assert.equal(event.details.original_effective_to, "2026-09-30");
    assert.deepEqual(event.details.original_payment_values, { DELIVERY: 15 });
    assert.equal(event.details.remaining_mapping.mapping_id, currentMapping);
  } finally {
    await db.close();
  }
});

test("clearing the sole open period makes the profile unmapped without erasing its definition", async () => {
  const db = await database();
  try {
    const result = (await call(db, {
      workforce: otherWorker,
      mapping: soleMapping,
      locations: null
    })).rows[0].result;
    assert.equal(result.original_status, "active");
    assert.equal(result.effective_from, "2026-10-01");
    assert.equal(result.effective_to, null);
    assert.equal(result.remaining_mapping, null);
    assert.deepEqual((await db.query(`
      select status, effective_from::text, effective_to::text, payment_values
      from public.field_executive_provider_mappings where id = '${soleMapping}';
    `)).rows, [{
      status: "cancelled",
      effective_from: "2026-10-01",
      effective_to: null,
      payment_values: { DELIVERY: 20 }
    }]);
    assert.deepEqual((await db.query(`
      select provider_employee_id, provider_id_status
      from public.workforce where id = '${otherWorker}';
    `)).rows, [{ provider_employee_id: null, provider_id_status: "pending" }]);
  } finally {
    await db.close();
  }
});

test("clearing a scheduled future period keeps the bounded period covering today current", async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into public.workforce(
        id, company_id, dropx_id, location_id, provider_employee_id, provider_id_status
      ) values (
        '${scheduledWorker}', '${company}', 'DX-SCHEDULED', '${registeredStation}',
        'MEMBER-SCHEDULED', 'created'
      );

      insert into public.field_executive_provider_mappings(
        id, company_id, workforce_id, provider_id, station_id,
        provider_member_id, effective_from, effective_to, payment_method_id,
        payment_values, pay_type, status, created_by, updated_at
      ) values
        (
          '${scheduledCurrentMapping}', '${company}', '${scheduledWorker}', '${provider}',
          '${registeredStation}', 'MEMBER-SCHEDULED',
          (now() at time zone 'Asia/Kolkata')::date - 10,
          (now() at time zone 'Asia/Kolkata')::date + 1,
          '${methodA}', '{"DELIVERY":16}', 'PER_PACKET', 'closed', '${actor}',
          '${mappingVersion}'
        ),
        (
          '${scheduledFutureMapping}', '${company}', '${scheduledWorker}', '${provider}',
          '${registeredStation}', 'MEMBER-SCHEDULED',
          (now() at time zone 'Asia/Kolkata')::date + 2,
          null, '${methodB}', '{"DELIVERY":19}', 'PER_PACKET', 'active', '${actor}',
          '${mappingVersion}'
        );
    `);

    const result = (await call(db, {
      workforce: scheduledWorker,
      mapping: scheduledFutureMapping,
      locations: [registeredStation]
    })).rows[0].result;

    assert.equal(result.mapping_id, scheduledFutureMapping);
    assert.equal(result.remaining_mapping.mapping_id, scheduledCurrentMapping);
    assert.equal(result.remaining_mapping.status, "closed");
    assert.deepEqual((await db.query(`
      select id::text, status
      from public.field_executive_provider_mappings
      where id in ('${scheduledCurrentMapping}', '${scheduledFutureMapping}')
      order by id;
    `)).rows, [
      { id: scheduledCurrentMapping, status: "closed" },
      { id: scheduledFutureMapping, status: "cancelled" }
    ]);
    assert.deepEqual((await db.query(`
      select provider_employee_id, provider_id_status
      from public.workforce where id = '${scheduledWorker}';
    `)).rows, [{
      provider_employee_id: "MEMBER-SCHEDULED",
      provider_id_status: "created"
    }]);
  } finally {
    await db.close();
  }
});

test("clearing the period covering today does not treat a future scheduled period as current", async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into public.workforce(
        id, company_id, dropx_id, location_id, provider_employee_id, provider_id_status
      ) values (
        '${futureOnlyWorker}', '${company}', 'DX-FUTURE-ONLY', '${registeredStation}',
        'MEMBER-FUTURE', 'created'
      );

      insert into public.field_executive_provider_mappings(
        id, company_id, workforce_id, provider_id, station_id,
        provider_member_id, effective_from, effective_to, payment_method_id,
        payment_values, pay_type, status, created_by, updated_at
      ) values
        (
          '${clearingCurrentMapping}', '${company}', '${futureOnlyWorker}', '${provider}',
          '${registeredStation}', 'MEMBER-FUTURE',
          (now() at time zone 'Asia/Kolkata')::date - 10,
          (now() at time zone 'Asia/Kolkata')::date + 1,
          '${methodA}', '{"DELIVERY":14}', 'PER_PACKET', 'closed', '${actor}',
          '${mappingVersion}'
        ),
        (
          '${futureOnlyMapping}', '${company}', '${futureOnlyWorker}', '${provider}',
          '${registeredStation}', 'MEMBER-FUTURE',
          (now() at time zone 'Asia/Kolkata')::date + 2,
          null, '${methodB}', '{"DELIVERY":22}', 'PER_PACKET', 'active', '${actor}',
          '${mappingVersion}'
        );
    `);

    const result = (await call(db, {
      workforce: futureOnlyWorker,
      mapping: clearingCurrentMapping,
      locations: [registeredStation]
    })).rows[0].result;

    assert.equal(result.mapping_id, clearingCurrentMapping);
    assert.equal(result.remaining_mapping, null);
    assert.deepEqual((await db.query(`
      select id::text, status
      from public.field_executive_provider_mappings
      where id in ('${clearingCurrentMapping}', '${futureOnlyMapping}')
      order by id;
    `)).rows, [
      { id: clearingCurrentMapping, status: "cancelled" },
      { id: futureOnlyMapping, status: "active" }
    ]);
    assert.deepEqual((await db.query(`
      select provider_employee_id, provider_id_status
      from public.workforce where id = '${futureOnlyWorker}';
    `)).rows, [{ provider_employee_id: null, provider_id_status: "pending" }]);
  } finally {
    await db.close();
  }
});

test("rejects a stale mapping version without mutation or audit", async () => {
  const db = await database();
  try {
    await assert.rejects(
      call(db, {
        expectedUpdatedAt: "2026-10-20T04:00:01.000Z"
      }),
      /mapping period changed/i
    );
    assert.deepEqual((await db.query(`
      select status, updated_at::text
      from public.field_executive_provider_mappings
      where id = '${historicalMapping}';
    `)).rows, [{
      status: "closed",
      updated_at: "2026-10-20 04:00:00+00"
    }]);
    assert.equal((await db.query(`
      select count(*)::integer as count
      from public.workforce_joining_events
      where event_code = 'provider_mapping_period_cleared';
    `)).rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test("rejects stale ownership, noncanonical rows and out-of-scope stations", async () => {
  const db = await database();
  try {
    await assert.rejects(
      call(db, { workforce: otherWorker, mapping: historicalMapping, locations: null }),
      /does not belong to this Workforce profile/
    );
    await assert.rejects(
      call(db, { workforce: worker, mapping: historicalMapping, locations: [otherStation] }),
      /outside your station scope/
    );
    await db.exec(`
      update public.workforce set location_id = '${otherStation}' where id = '${worker}';
    `);
    await assert.rejects(
      call(db, { workforce: worker, mapping: historicalMapping, locations: [registeredStation] }),
      /outside your station scope/
    );
    await assert.rejects(
      call(db, { workforce: otherWorker, mapping: malformedMapping, locations: null }),
      /mapping period changed/i
    );
    assert.equal((await db.query(`
      select status from public.field_executive_provider_mappings
      where id = '${historicalMapping}';
    `)).rows[0].status, "closed");
    assert.equal((await db.query(`
      select count(*)::integer as count from public.workforce_joining_events
      where event_code = 'provider_mapping_period_cleared';
    `)).rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test("ordinary financial and registered-anchor mapping triggers remain authoritative", async () => {
  const financiallyLocked = await database();
  try {
    await financiallyLocked.exec(`
      create function public.test_financial_mapping_guard()
      returns trigger language plpgsql as $$
      begin
        if old.id = '${historicalMapping}' and new.status = 'cancelled' then
          raise exception 'published or bank payout is locked';
        end if;
        return new;
      end $$;
      create trigger test_financial_mapping_guard
      before update on public.field_executive_provider_mappings
      for each row execute function public.test_financial_mapping_guard();
    `);
    await assert.rejects(call(financiallyLocked), /published or bank payout is locked/);
    assert.equal((await financiallyLocked.query(`
      select status from public.field_executive_provider_mappings
      where id = '${historicalMapping}';
    `)).rows[0].status, "closed");
    assert.equal((await financiallyLocked.query(`
      select count(*)::integer as count from public.workforce_joining_events
      where event_code = 'provider_mapping_period_cleared';
    `)).rows[0].count, 0);
  } finally {
    await financiallyLocked.close();
  }

  const registeredAnchor = await database();
  try {
    await assert.rejects(
      call(registeredAnchor, {
        workforce: anchorWorker,
        mapping: anchorMapping,
        locations: [registeredStation]
      }),
      /registered-location mapping/i
    );
    assert.equal((await registeredAnchor.query(`
      select status from public.field_executive_provider_mappings
      where id = '${anchorMapping}';
    `)).rows[0].status, "active");
    assert.equal((await registeredAnchor.query(`
      select count(*)::integer as count from public.workforce_joining_events
      where workforce_id = '${anchorWorker}'
        and event_code = 'provider_mapping_period_cleared';
    `)).rows[0].count, 0);
  } finally {
    await registeredAnchor.close();
  }
});

test("the exact-period clear RPC is executable only by service_role", async () => {
  const db = await database();
  try {
    const privileges = (await db.query(`
      select
        has_function_privilege(
          'anon',
          'public.workforce_clear_mapping_period(uuid,uuid,uuid,uuid,timestamp with time zone,uuid[],text)',
          'execute'
        ) as anon,
        has_function_privilege(
          'authenticated',
          'public.workforce_clear_mapping_period(uuid,uuid,uuid,uuid,timestamp with time zone,uuid[],text)',
          'execute'
        ) as authenticated,
        has_function_privilege(
          'service_role',
          'public.workforce_clear_mapping_period(uuid,uuid,uuid,uuid,timestamp with time zone,uuid[],text)',
          'execute'
        ) as service_role;
    `)).rows[0];
    assert.deepEqual(privileges, {
      anon: false,
      authenticated: false,
      service_role: true
    });
  } finally {
    await db.close();
  }
});
