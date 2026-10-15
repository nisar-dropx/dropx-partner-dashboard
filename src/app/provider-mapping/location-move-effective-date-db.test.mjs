import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(
  new URL("../../../supabase/migrations/20261005160446_provider_mapping_finalized_payout_period_guard.sql", import.meta.url),
  "utf8"
);
const functionStart = migration.lastIndexOf(
  "create or replace function public.workforce_replace_joining_mapping("
);
const functionEnd = migration.indexOf(
  "revoke all on function public.workforce_replace_joining_mapping(",
  functionStart
);
assert.notEqual(functionStart, -1, "the current replacement function must exist");
assert.notEqual(functionEnd, -1, "the current replacement function must be complete");
const replaceJoiningMapping = migration.slice(functionStart, functionEnd);

const id = (value) => `30000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const company = id(1);
const provider = id(2);
const worker = id(3);
const stationA = id(4);
const stationB = id(5);
const actor = id(6);
const paymentMethod = id(7);
const septemberMapping = id(8);

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
    create table public.test_paid_history (
      id uuid primary key default gen_random_uuid(),
      mapping_id uuid not null references public.field_executive_provider_mappings(id),
      paid_amount numeric not null
    );
    create table public.test_policy_rebases (
      workforce_id uuid,
      old_station_id uuid,
      new_station_id uuid,
      effective_from date
    );

    create function public.workforce_rebase_payment_policy_location(
      p_company uuid,
      p_workforce uuid,
      p_old_station uuid,
      p_new_station uuid,
      p_effective_from date
    ) returns void language plpgsql as $$
    begin
      insert into public.test_policy_rebases(
        workforce_id, old_station_id, new_station_id, effective_from
      ) values (p_workforce, p_old_station, p_new_station, p_effective_from);
    end $$;

    create function public.workforce_save_joining_mapping(
      p_company uuid,
      p_actor uuid,
      p_workforce uuid,
      p_mapping uuid,
      p_dropx text,
      p_payload jsonb,
      p_locations uuid[],
      p_actor_name text
    ) returns void language plpgsql as $$
    begin
      insert into public.field_executive_provider_mappings(
        company_id, workforce_id, provider_id, station_id,
        provider_member_id, effective_from, effective_to,
        payment_method_id, payment_values, production_threshold_config,
        pay_type, status, created_by
      ) values (
        p_company, p_workforce, (p_payload ->> 'provider_id')::uuid,
        (p_payload ->> 'station_id')::uuid,
        p_payload ->> 'provider_member_id',
        (p_payload ->> 'effective_from')::date,
        nullif(p_payload ->> 'effective_to', '')::date,
        (p_payload ->> 'payment_method_id')::uuid,
        p_payload -> 'payment_values',
        p_payload -> 'production_threshold_config',
        p_payload ->> 'pay_type', p_payload ->> 'status', p_actor
      );
      update public.workforce
      set dropx_id = p_dropx,
          location_id = (p_payload ->> 'station_id')::uuid,
          updated_at = now()
      where company_id = p_company and id = p_workforce;
    end $$;
  `);
  await db.exec(replaceJoiningMapping);
  return db;
}

test("Move from October 1 closes only the old September period and preserves its history", async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into public.workforce(
        id, company_id, dropx_id, full_name, location_id
      ) values (
        '${worker}', '${company}', 'DX-101', 'Worker One', '${stationB}'
      );
      insert into public.field_executive_provider_mappings(
        id, company_id, workforce_id, provider_id, station_id,
        provider_member_id, effective_from, effective_to,
        payment_method_id, payment_values, pay_type, status, created_by
      ) values (
        '${septemberMapping}', '${company}', '${worker}', '${provider}', '${stationA}',
        'MEMBER-101', '2026-09-01', null,
        '${paymentMethod}', '{"DELIVERY":15}', 'PER_PACKET', 'active', '${actor}'
      );
      insert into public.test_paid_history(mapping_id, paid_amount)
      values ('${septemberMapping}', 12000);
    `);

    await db.exec(`
      select public.workforce_replace_joining_mapping(
        '${company}', '${actor}', '${worker}', '${septemberMapping}', 'DX-101',
        jsonb_build_object(
          'provider_id', '${provider}',
          'station_id', '${stationB}',
          'provider_member_id', 'MEMBER-101',
          'effective_from', '2026-10-01',
          'effective_to', null,
          'payment_method_id', '${paymentMethod}',
          'payment_values', jsonb_build_object('DELIVERY', 18),
          'production_threshold_config', null,
          'pay_type', 'PER_PACKET',
          'status', 'active'
        ),
        array['${stationA}'::uuid, '${stationB}'::uuid],
        'Mapping reviewer'
      );
    `);

    const mappings = await db.query(`
      select id::text, station_id::text, effective_from::text,
        effective_to::text, status, payment_values
      from public.field_executive_provider_mappings
      order by effective_from, station_id
    `);
    assert.equal(mappings.rows.length, 2);
    assert.deepEqual(mappings.rows[0], {
      id: septemberMapping,
      station_id: stationA,
      effective_from: "2026-09-01",
      effective_to: "2026-09-30",
      status: "closed",
      payment_values: { DELIVERY: 15 }
    });
    assert.equal(mappings.rows[1].station_id, stationB);
    assert.equal(mappings.rows[1].effective_from, "2026-10-01");
    assert.equal(mappings.rows[1].effective_to, null);
    assert.equal(mappings.rows[1].status, "active");
    assert.deepEqual(mappings.rows[1].payment_values, { DELIVERY: 18 });

    const preservedHistory = await db.query(`
      select mapping_id::text, paid_amount::text
      from public.test_paid_history
    `);
    assert.deepEqual(preservedHistory.rows, [{
      mapping_id: septemberMapping,
      paid_amount: "12000"
    }]);

    const rebase = await db.query(`
      select workforce_id::text, old_station_id::text, new_station_id::text,
        effective_from::text
      from public.test_policy_rebases
    `);
    assert.deepEqual(rebase.rows, [{
      workforce_id: worker,
      old_station_id: stationA,
      new_station_id: stationB,
      effective_from: "2026-10-01"
    }]);

    const movedEvent = await db.query(`
      select details
      from public.workforce_joining_events
      where event_code = 'provider_mapping_location_moved'
    `);
    assert.equal(movedEvent.rows.length, 1);
    assert.equal(movedEvent.rows[0].details.previous_mapping_id, septemberMapping);
    assert.equal(movedEvent.rows[0].details.effective_from, "2026-10-01");
    assert.equal(movedEvent.rows[0].details.old_mapping_disposition, "closed");
  } finally {
    await db.close();
  }
});
