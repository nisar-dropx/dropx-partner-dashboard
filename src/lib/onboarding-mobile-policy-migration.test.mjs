import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("../../supabase/migrations/20261009015557_allow_shared_mobile_numbers_across_people.sql", import.meta.url);
const legacyMigrationUrl = new URL("../../supabase/migrations/20261009040000_remove_remaining_people_mobile_guards.sql", import.meta.url);
const registers = ["employees", "contractors", "vendors", "workforce_helpers"];

test("the People trigger allows shared mobiles without changing other identity fields", async () => {
  const db = new PGlite();
  try {
    for (const register of registers) {
      await db.exec(`
        create table public.${register} (
          id bigserial primary key,
          mobile text not null check (mobile ~ '^\\d{10}$'),
          email text not null unique,
          dropx_id text not null unique,
          biometric_id text not null unique
        );
      `);
    }
    await db.exec(`
      create table public.workforce (
        id bigserial primary key,
        mobile text not null check (mobile ~ '^\\d{10}$'),
        email text not null unique,
        dropx_id text not null unique,
        biometric_id text not null unique,
        identity_exception_required boolean not null default false,
        identity_exception_context jsonb not null default '{}'::jsonb,
        identity_exception_approved_at timestamptz,
        identity_exception_approved_by text
      );
    `);

    await db.exec(await readFile(migrationUrl, "utf8"));
    for (const register of [...registers, "workforce"]) {
      await db.exec(`
        create trigger ${register}_mobile_identity
        before insert or update on public.${register}
        for each row execute function public.enforce_onboarding_mobile_identity();
      `);
    }

    const sharedMobile = "7724078559";
    for (const [index, register] of registers.entries()) {
      await db.query(
        `insert into public.${register} (mobile, email, dropx_id, biometric_id) values ($1, $2, $3, $4)`,
        [sharedMobile, `${register}@example.test`, `DX-${index}`, `BIO-${index}`]
      );
    }
    const approvedAt = "2026-10-01T08:30:00.000Z";
    const approvedBy = "reviewer-1";
    await db.query(`
      insert into public.workforce (
        mobile, email, dropx_id, biometric_id,
        identity_exception_required, identity_exception_context,
        identity_exception_approved_at, identity_exception_approved_by
      ) values ($1, $2, $3, $4, true, $5::jsonb, $6, $7)
    `, [sharedMobile, "workforce@example.test", "DX-W", "BIO-W", '{"reason":"historical-review"}', approvedAt, approvedBy]);

    const state = await db.query(`
      select identity_exception_required, identity_exception_context,
             identity_exception_approved_at, identity_exception_approved_by
      from public.workforce
    `);
    assert.equal(state.rows[0].identity_exception_required, true);
    assert.deepEqual(state.rows[0].identity_exception_context, { reason: "historical-review" });
    assert.equal(new Date(state.rows[0].identity_exception_approved_at).toISOString(), approvedAt);
    assert.equal(state.rows[0].identity_exception_approved_by, approvedBy);

    await assert.rejects(
      db.query(
        "insert into public.employees (mobile, email, dropx_id, biometric_id) values ($1, $2, $3, $4)",
        ["9000000000", "other@example.test", "DX-0", "BIO-OTHER"]
      ),
      /duplicate key/i
    );
    await assert.rejects(
      db.query(
        "insert into public.employees (mobile, email, dropx_id, biometric_id) values ($1, $2, $3, $4)",
        ["9000000001", "employees@example.test", "DX-OTHER", "BIO-OTHER"]
      ),
      /duplicate key/i
    );
    await assert.rejects(
      db.query(
        "insert into public.employees (mobile, email, dropx_id, biometric_id) values ($1, $2, $3, $4)",
        ["9000000002", "other-2@example.test", "DX-OTHER-2", "BIO-0"]
      ),
      /duplicate key/i
    );
    await assert.rejects(
      db.query(
        "insert into public.employees (mobile, email, dropx_id, biometric_id) values ($1, $2, $3, $4)",
        ["invalid", "other-3@example.test", "DX-OTHER-3", "BIO-OTHER-3"]
      ),
      /check constraint/i
    );
  } finally {
    await db.close();
  }
});

test("the follow-up migration is safe when legacy People RPCs are absent", async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(legacyMigrationUrl, "utf8"));
  } finally {
    await db.close();
  }
});

test("the follow-up migration removes only legacy People mobile guards", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create table public.contractors (id uuid primary key);
      create table public.workforce (
        company_id uuid,
        deleted_at timestamptz,
        email text
      );

      create function public.enforce_people_workforce_confirmation_only()
      returns trigger
      language plpgsql
      security definer
      set search_path = ''
      as $function$
      begin
        raise exception 'legacy reviewed-mobile guard';
      end
      $function$;

      create function public.hr_bulk_create_people_profiles(
        p_company_id uuid,
        p_worker_type text,
        p_rows jsonb,
        p_actor_user_id uuid,
        p_source_filename text
      ) returns integer
      language plpgsql
      as $function$
      declare
        mobile_country_value text := '91';
        mobile_value text := '9000000000';
        seen_mobiles text[] := '{}'::text[];
        row_data jsonb := '{}'::jsonb;
      begin
        if p_company_id is null then raise exception 'Company is required'; end if;
        if (mobile_country_value || mobile_value) = any(seen_mobiles) then raise exception 'Mobile number +% appears more than once', mobile_country_value || mobile_value; end if;
        seen_mobiles := array_append(seen_mobiles, mobile_country_value || mobile_value);
        if nullif(row_data ->> 'mobile_review_key', '') is not null then
          if p_actor_user_id is null then raise exception 'A mobile override requires an identified import user'; end if;
        end if;
        if p_worker_type = 'employee' then
          return 1;
        end if;
        return 1;
      end
      $function$;

      create function public.hr_create_people_with_workforce_confirmation(
        p_company_id uuid,
        p_actor_user_id uuid,
        p_source_table text,
        p_profile jsonb,
        p_review_key text
      ) returns uuid
      language plpgsql
      as $function$
      declare
        profile_id uuid := p_company_id;
        matches jsonb := '[]'::jsonb;
      begin
        if p_actor_user_id is null then raise exception 'Actor is required'; end if;
        perform pg_catalog.pg_advisory_xact_lock(1);
        if jsonb_array_length(matches) = 0 or exists (
          select 1 from jsonb_array_elements(matches) item
        ) then raise exception 'Mobile number already has another profile or the Workforce match changed. Review again.'; end if;
        if p_review_key is distinct from md5(matches::text) then
          raise exception 'Workforce records changed. Review and confirm onboarding again.';
        end if;
        -- The normal identity guard consumes this context once, for this exact row.
        perform set_config('dropx.people_mobile_override', '{}'::text, true);
        if p_source_table = 'employees' then
          return profile_id;
        end if;
        return profile_id;
      end
      $function$;

      create function public.hr_transfer_workforce_to_people(
        p_company_id uuid,
        p_workforce_id uuid,
        p_contractor_id uuid,
        p_dropx_id text,
        p_biometric_id text,
        p_designation_name text,
        p_department_id uuid,
        p_location_id uuid,
        p_effective_from date,
        p_actor_user_id uuid
      ) returns uuid
      language plpgsql
      as $function$
      declare
        w record;
        v_mobile text;
        v_people_match jsonb := '{}'::jsonb;
      begin
        if p_workforce_id is null then raise exception 'Workforce profile not found.'; end if;
        v_mobile := public.normalize_onboarding_mobile(w.mobile);
        if v_people_match is not null then
          raise exception 'The mobile already has a People profile.';
        end if;
        perform set_config('dropx.people_mobile_override', jsonb_build_object(
          'company_id', p_company_id,
          'mobile', v_mobile
        )::text, true);
        insert into public.contractors (id) values (p_contractor_id);
        return p_contractor_id;
      end
      $function$;

      create function public.workforce_create_amazon_pilot(
        p_company uuid,
        p_actor uuid,
        p_data jsonb,
        p_locations uuid[]
      ) returns uuid
      language plpgsql
      as $function$
      declare
        v_mobile text := p_data->>'mobile';
        v_email text := lower(btrim(p_data->>'email'));
        exact_matches jsonb := '[]'::jsonb;
        other_matches jsonb := '[]'::jsonb;
        exception_confirmed boolean := false;
      begin
        if p_actor is null then raise exception 'Actor is required'; end if;
        perform pg_advisory_xact_lock(hashtextextended(p_company::text||v_mobile,0));
        if jsonb_array_length(exact_matches)>0 then
          raise exception 'Mobile number is already registered to another profile.';
        end if;
        if jsonb_array_length(other_matches)>0 and not exception_confirmed then
          raise exception 'Existing DropX identity found.';
        end if;
        if exists(select 1 from public.workforce w where w.company_id=p_company and w.deleted_at is null and lower(btrim(w.email))=v_email) then
          raise exception 'This Amazon email is already used by an associate.';
        end if;
        return p_company;
      end
      $function$;
    `);

    await db.exec(await readFile(legacyMigrationUrl, "utf8"));
    await db.exec(await readFile(legacyMigrationUrl, "utf8"));

    const definitions = await db.query(`
      select p.proname, lower(p.prosrc) as source
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (
          'enforce_people_workforce_confirmation_only',
          'hr_bulk_create_people_profiles',
          'hr_create_people_with_workforce_confirmation',
          'hr_transfer_workforce_to_people',
          'workforce_create_amazon_pilot'
        )
    `);
    const sources = new Map(definitions.rows.map((row) => [row.proname, row.source]));

    assert.match(sources.get("enforce_people_workforce_confirmation_only"), /return new/);
    assert.doesNotMatch(sources.get("enforce_people_workforce_confirmation_only"), /raise exception/);

    assert.match(sources.get("hr_bulk_create_people_profiles"), /company is required/);
    assert.doesNotMatch(sources.get("hr_bulk_create_people_profiles"), /mobile number \+% appears more than once/);
    assert.match(sources.get("hr_bulk_create_people_profiles"), /mobile_review_key/);
    assert.match(sources.get("hr_bulk_create_people_profiles"), /seen_mobiles := array_append/);

    assert.match(sources.get("hr_create_people_with_workforce_confirmation"), /actor is required/);
    assert.match(sources.get("hr_create_people_with_workforce_confirmation"), /pg_advisory_xact_lock/);
    assert.match(sources.get("hr_create_people_with_workforce_confirmation"), /dropx.people_mobile_override/);
    assert.doesNotMatch(sources.get("hr_create_people_with_workforce_confirmation"), /mobile number already has another profile/);
    assert.doesNotMatch(sources.get("hr_create_people_with_workforce_confirmation"), /workforce records changed/);

    assert.match(sources.get("hr_transfer_workforce_to_people"), /workforce profile not found/);
    assert.match(sources.get("hr_transfer_workforce_to_people"), /normalize_onboarding_mobile/);
    assert.match(sources.get("hr_transfer_workforce_to_people"), /dropx.people_mobile_override/);
    assert.doesNotMatch(sources.get("hr_transfer_workforce_to_people"), /mobile already has a people profile/);

    assert.match(sources.get("workforce_create_amazon_pilot"), /actor is required/);
    assert.match(sources.get("workforce_create_amazon_pilot"), /hashtextextended/);
    assert.match(sources.get("workforce_create_amazon_pilot"), /amazon email is already used/);
    assert.doesNotMatch(sources.get("workforce_create_amazon_pilot"), /mobile number is already registered/);
    assert.doesNotMatch(sources.get("workforce_create_amazon_pilot"), /existing dropx identity found/);
    assert.match(sources.get("workforce_create_amazon_pilot"), /identity matches are retained as audit context/);
  } finally {
    await db.close();
  }
});
