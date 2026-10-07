begin;

-- station_id records where the advance was paid, not the current station of
-- the Workforce member who owes the balance. A previously unregistered import
-- may have no known paid-at station even after its identity is corrected.
alter table public.workforce_advances
  drop constraint workforce_advances_link_shape_check,
  add constraint workforce_advances_link_shape_check
    check (
      (
        link_status = 'pending'
        and workforce_id is null
        and station_id is null
        and source_type = 'bulk_import'
        and linked_at is null
      )
      or
      (
        link_status = 'linked'
        and workforce_id is not null
        and linked_at is not null
      )
    );

comment on column public.workforce_advances.station_id is
  'Historical station where the advance was paid. It is immutable after creation and may be null when an imported advance had no known paid-at station.';

create or replace function public.prepare_workforce_advance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_recovered numeric(18,2);
  v_workforce public.workforce%rowtype;
  v_identity_changed boolean := false;
  v_is_exact_automatic_link boolean := false;
  v_has_reassignment_audit boolean := false;
begin
  if new.advance_number is null or pg_catalog.btrim(new.advance_number) = '' then
    new.advance_number := 'WA-' || pg_catalog.to_char(new.advance_date, 'YYYYMMDD')
      || '-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(new.id::text, '-', ''), 1, 8));
  else
    new.advance_number := pg_catalog.upper(pg_catalog.btrim(new.advance_number));
  end if;
  new.payment_reference := nullif(pg_catalog.btrim(new.payment_reference), '');
  new.external_reference := nullif(pg_catalog.btrim(new.external_reference), '');
  new.remark := nullif(pg_catalog.btrim(new.remark), '');
  new.link_status := coalesce(nullif(new.link_status, ''), 'linked');

  if new.identity_revision is null or new.identity_revision < 0 then
    raise exception 'Workforce advance identity revision is invalid.';
  end if;
  if tg_op = 'INSERT' and new.identity_revision <> 0 then
    raise exception 'A new Workforce advance must start at identity revision zero.';
  end if;
  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id then
      raise exception 'A Workforce advance cannot move to another company.';
    end if;
    if new.imported_dropx_id is distinct from old.imported_dropx_id then
      raise exception 'The original imported DropX ID is immutable.';
    end if;
    if new.identity_revision < old.identity_revision
      or new.identity_revision > old.identity_revision + 1
    then
      raise exception 'Workforce advance identity revisions must increase one at a time.';
    end if;
    v_identity_changed := new.workforce_id is distinct from old.workforce_id
      or new.link_status is distinct from old.link_status;
  end if;

  if new.source_type = 'manual'
    and coalesce(new.external_reference, '') ~* '^WAI[12]-'
  then
    raise exception 'WAI1 and WAI2 references are reserved for Workforce advance imports.';
  end if;
  if new.source_type = 'bulk_import'
    and (
      tg_op = 'INSERT'
      or new.external_reference is distinct from old.external_reference
    )
    and coalesce(new.external_reference, '') !~* '^WAI2-[0-9a-f]{32}$'
  then
    raise exception 'A bulk-imported Workforce advance requires its database-generated WAI2 key.';
  end if;

  if new.link_status = 'pending' then
    if tg_op = 'UPDATE' and old.link_status = 'linked' then
      raise exception 'A linked Workforce advance cannot be returned to pending identity status.';
    end if;
    if new.source_type <> 'bulk_import'
      or new.workforce_id is not null
      or new.station_id is not null
      or new.linked_at is not null
      or new.identity_revision <> 0
    then
      raise exception 'A pending Workforce advance must be a locationless, unreassigned bulk-import row.';
    end if;
    if public.normalize_people_dropx_id(new.imported_dropx_id) is null
      or pg_catalog.char_length(new.imported_dropx_id) > 80
    then
      raise exception 'A pending Workforce advance requires its original DropX ID.';
    end if;
  elsif new.link_status = 'linked' then
    if new.workforce_id is null then
      raise exception 'A linked Workforce advance requires a canonical Workforce member.';
    end if;

    select workforce.*
    into v_workforce
    from public.workforce workforce
    where workforce.company_id = new.company_id
      and workforce.id = new.workforce_id
      and workforce.location_id is not null
      and workforce.deleted_at is null
      and workforce.migration_state is distinct from 'reclassified'
    for update;
    if not found then
      raise exception 'Advance location must be the canonical Workforce member''s current location.';
    end if;

    if public.normalize_people_dropx_id(new.imported_dropx_id) is null then
      new.imported_dropx_id := coalesce(
        nullif(v_workforce.dropx_id, ''),
        new.workforce_id::text
      );
    end if;

    v_is_exact_automatic_link := tg_op = 'UPDATE'
      and old.link_status = 'pending'
      and old.workforce_id is null
      and old.station_id is null
      and new.link_status = 'linked'
      and new.identity_revision = old.identity_revision
      and public.normalize_people_dropx_id(new.imported_dropx_id)
        = public.normalize_people_dropx_id(v_workforce.dropx_id);

    if (tg_op = 'INSERT' or v_is_exact_automatic_link)
      and (
        new.station_id is null
        or new.station_id is distinct from v_workforce.location_id
      )
    then
      raise exception 'Advance location must be the canonical Workforce member''s current location.';
    end if;
    if tg_op = 'UPDATE'
      and new.station_id is distinct from old.station_id
      and not v_is_exact_automatic_link
    then
      raise exception 'The advance paid-at location is immutable.';
    end if;
    if tg_op = 'UPDATE' and v_identity_changed
      and new.identity_revision = old.identity_revision
      and not v_is_exact_automatic_link
    then
      raise exception 'Use the Workforce advance reassignment workflow to change its identity.';
    end if;
    if tg_op = 'UPDATE' and not v_identity_changed
      and new.identity_revision is distinct from old.identity_revision
    then
      raise exception 'A Workforce advance identity revision requires an identity change.';
    end if;

    if tg_op = 'UPDATE' and new.identity_revision > 0 then
      select exists (
        select 1
        from public.workforce_advance_reassignments reassignment
        where reassignment.company_id = new.company_id
          and reassignment.advance_id = new.id
          and reassignment.revision = new.identity_revision
          and reassignment.to_workforce_id = new.workforce_id
          and reassignment.original_imported_dropx_id = new.imported_dropx_id
          and (
            new.identity_revision = old.identity_revision
            or reassignment.reassigned_by = new.updated_by
          )
      ) into v_has_reassignment_audit;
      if not v_has_reassignment_audit then
        raise exception 'Workforce advance identity changes require an immutable reassignment audit.';
      end if;
    end if;
    if public.normalize_people_dropx_id(new.imported_dropx_id)
        <> public.normalize_people_dropx_id(v_workforce.dropx_id)
      and not v_has_reassignment_audit
    then
      raise exception 'Imported DropX ID does not match the canonical Workforce member.';
    end if;
    new.linked_at := coalesce(new.linked_at, pg_catalog.clock_timestamp());
  else
    raise exception 'Unsupported Workforce advance identity-link status.';
  end if;

  if new.opening_deducted_amount is null
    or new.opening_deducted_amount < 0
    or new.opening_deducted_amount > new.amount
  then
    raise exception 'Opening deducted amount must be between zero and the advance amount.';
  end if;
  if tg_op = 'UPDATE'
    and new.opening_deducted_amount is distinct from old.opening_deducted_amount
  then
    raise exception 'Opening deducted amount is immutable after an advance is imported.';
  end if;

  if tg_op = 'UPDATE' and new.amount is distinct from old.amount then
    select coalesce(sum(recovery.amount) filter (where recovery.status = 'deducted'), 0)
    into v_recovered
    from public.workforce_advance_recoveries recovery
    where recovery.company_id = old.company_id
      and recovery.advance_id = old.id;
    if new.amount < greatest(v_recovered, new.opening_deducted_amount) then
      raise exception 'Advance amount cannot be lower than the amount already deducted.';
    end if;
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

create or replace function public.workforce_reassign_advance(
  p_company_id uuid,
  p_advance_id uuid,
  p_target_workforce_id uuid,
  p_expected_workforce_id uuid,
  p_expected_identity_revision integer,
  p_reason text,
  p_actor_user_id uuid,
  p_allowed_location_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_advance public.workforce_advances%rowtype;
  v_source_workforce public.workforce%rowtype;
  v_target_workforce public.workforce%rowtype;
  v_source_station public.stations%rowtype;
  v_target_station public.stations%rowtype;
  v_preliminary_workforce_id uuid;
  v_reason text;
  v_active_deducted numeric(18,2);
  v_next_revision integer;
  v_reassigned_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_company_id is null or p_advance_id is null
    or p_target_workforce_id is null or p_actor_user_id is null
  then
    raise exception 'Company, advance, target Workforce member, and actor are required.';
  end if;
  if p_expected_identity_revision is null or p_expected_identity_revision < 0 then
    raise exception 'The expected identity revision is invalid.';
  end if;
  v_reason := pg_catalog.btrim(coalesce(p_reason, ''));
  if pg_catalog.char_length(v_reason) < 3 or pg_catalog.char_length(v_reason) > 500 then
    raise exception 'Enter a reassignment reason between 3 and 500 characters.';
  end if;

  select advance.workforce_id
  into v_preliminary_workforce_id
  from public.workforce_advances advance
  where advance.company_id = p_company_id
    and advance.id = p_advance_id;
  if not found then
    raise exception 'The Workforce advance no longer exists.';
  end if;

  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id in (p_target_workforce_id, v_preliminary_workforce_id)
  order by workforce.id
  for update;

  perform public.lock_workforce_payment_allocation_company(p_company_id);

  select advance.*
  into v_advance
  from public.workforce_advances advance
  where advance.company_id = p_company_id
    and advance.id = p_advance_id
  for update;
  if not found then
    raise exception 'The Workforce advance no longer exists.';
  end if;
  if v_advance.identity_revision <> p_expected_identity_revision
    or v_advance.workforce_id is distinct from p_expected_workforce_id
  then
    raise exception 'The advance assignment changed. Refresh the register and try again.';
  end if;
  if v_advance.workforce_id = p_target_workforce_id then
    raise exception 'The advance is already assigned to the selected Workforce member.';
  end if;

  select workforce.*
  into v_target_workforce
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id = p_target_workforce_id
    and workforce.location_id is not null
    and workforce.deleted_at is null
    and workforce.migration_state is distinct from 'reclassified'
  for update;
  if not found
    or public.normalize_people_dropx_id(v_target_workforce.dropx_id) is null
  then
    raise exception 'The selected target is not a canonical Workforce member with a valid DropX ID and current location.';
  end if;

  select station.*
  into v_target_station
  from public.stations station
  where station.company_id = p_company_id
    and station.id = v_target_workforce.location_id;
  if not found then
    raise exception 'The selected target Workforce member does not have a valid current location.';
  end if;

  if v_advance.workforce_id is not null then
    select workforce.*
    into v_source_workforce
    from public.workforce workforce
    where workforce.company_id = p_company_id
      and workforce.id = v_advance.workforce_id;
  end if;
  if v_source_workforce.location_id is not null then
    select station.*
    into v_source_station
    from public.stations station
    where station.company_id = p_company_id
      and station.id = v_source_workforce.location_id;
  end if;

  if p_allowed_location_ids is not null
    and (
      v_advance.workforce_id is null
      or v_source_workforce.location_id is null
      or not (v_source_workforce.location_id = any(p_allowed_location_ids))
      or not (v_target_workforce.location_id = any(p_allowed_location_ids))
    )
  then
    raise exception 'The source or target Workforce advance is outside your assigned locations.';
  end if;

  perform 1
  from public.workforce_advance_recoveries recovery
  where recovery.company_id = p_company_id
    and recovery.advance_id = p_advance_id
  order by recovery.id
  for update;

  select coalesce(sum(recovery.amount) filter (where recovery.status = 'deducted'), 0)
  into v_active_deducted
  from public.workforce_advance_recoveries recovery
  where recovery.company_id = p_company_id
    and recovery.advance_id = p_advance_id;
  if v_advance.opening_deducted_amount > 0 or v_active_deducted > 0 then
    raise exception 'This advance already has a deducted amount and cannot be reassigned. Reverse its active deductions first.';
  end if;

  if exists (
    select 1
    from public.workforce duplicate
    where duplicate.company_id = p_company_id
      and duplicate.id <> v_target_workforce.id
      and public.normalize_people_dropx_id(duplicate.dropx_id)
        = public.normalize_people_dropx_id(v_target_workforce.dropx_id)
      and duplicate.deleted_at is null
      and duplicate.migration_state is distinct from 'reclassified'
  ) then
    raise exception 'The selected target DropX ID matches more than one canonical Workforce member.';
  end if;

  v_next_revision := v_advance.identity_revision + 1;
  insert into public.workforce_advance_reassignments(
    company_id, advance_id, revision, original_imported_dropx_id,
    from_workforce_id, from_station_id, from_dropx_id, from_workforce_name, from_location,
    to_workforce_id, to_station_id, to_dropx_id, to_workforce_name, to_location,
    reason, reassigned_by, reassigned_at
  ) values (
    p_company_id, p_advance_id, v_next_revision, v_advance.imported_dropx_id,
    v_advance.workforce_id, v_source_workforce.location_id,
    coalesce(nullif(v_source_workforce.dropx_id, ''), v_advance.imported_dropx_id),
    coalesce(nullif(v_source_workforce.full_name, ''), 'Awaiting Workforce registration'),
    coalesce(nullif(v_source_station.station_code, ''), '—'),
    v_target_workforce.id, v_target_workforce.location_id,
    v_target_workforce.dropx_id,
    coalesce(nullif(v_target_workforce.full_name, ''), 'Workforce'),
    coalesce(nullif(v_target_station.station_code, ''), '—'),
    v_reason, p_actor_user_id, v_reassigned_at
  );

  update public.workforce_advances advance
  set workforce_id = v_target_workforce.id,
      link_status = 'linked',
      linked_at = v_reassigned_at,
      identity_revision = v_next_revision,
      updated_by = p_actor_user_id
  where advance.company_id = p_company_id
    and advance.id = p_advance_id;

  return pg_catalog.jsonb_build_object(
    'advanceId', v_advance.id,
    'advanceNumber', v_advance.advance_number,
    'identityRevision', v_next_revision,
    'originalImportedDropxId', v_advance.imported_dropx_id,
    'workforceId', v_target_workforce.id,
    'dropxId', v_target_workforce.dropx_id,
    'workforceName', coalesce(nullif(v_target_workforce.full_name, ''), 'Workforce'),
    'location', coalesce(nullif(v_target_station.station_code, ''), '—'),
    'paidLocationPreserved', true,
    'reassignedAt', v_reassigned_at
  );
end;
$function$;

notify pgrst, 'reload schema';

commit;
