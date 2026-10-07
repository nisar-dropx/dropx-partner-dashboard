begin;

create temporary table purge_nonworkforce_advance_rows (
  dropx_id text primary key,
  expected_amount numeric(18,2) not null check (expected_amount > 0)
) on commit drop;

insert into purge_nonworkforce_advance_rows(dropx_id, expected_amount) values
  ('D0676', 2000),
  ('D0755', 2000),
  ('D0784', 2000),
  ('D0789', 7000),
  ('D0851', 2000),
  ('D0871', 2000),
  ('DROPX504', 10000),
  ('DROPX522', 5000),
  ('DROPX525', 3000),
  ('DROPX539', 2000),
  ('F280092', 2000),
  ('JDBD1039', 2000),
  ('JDBD1063', 3000),
  ('K1002', 2000),
  ('K1049', 2000),
  ('N1028', 2000);

do $purge_nonworkforce_advances$
declare
  v_company_id uuid;
  v_candidate_companies integer;
  v_invalid_rows integer;
  v_recovery_rows integer;
  v_amount_mismatches integer;
  v_deleted_rows integer;
  v_remaining_rows integer;
begin
  -- Resolve one company from the complete ID-and-total set without hardcoding a
  -- generated tenant ID. Partial matches in another company are not candidates.
  with per_company_totals as (
    select
      advance.company_id,
      requested.dropx_id,
      requested.expected_amount,
      count(advance.id) as advance_count,
      sum(advance.amount)::numeric(18,2) as actual_amount
    from purge_nonworkforce_advance_rows requested
    join public.workforce_advances advance
      on public.normalize_people_dropx_id(advance.imported_dropx_id)
        = public.normalize_people_dropx_id(requested.dropx_id)
    group by advance.company_id, requested.dropx_id, requested.expected_amount
  ), candidate_companies as (
    select totals.company_id
    from per_company_totals totals
    group by totals.company_id
    having count(*) = (select count(*) from purge_nonworkforce_advance_rows)
       and bool_and(
         totals.advance_count > 0
         and totals.actual_amount = totals.expected_amount
       )
  )
  select count(*), (array_agg(company_id order by company_id))[1]
  into v_candidate_companies, v_company_id
  from candidate_companies;

  if v_candidate_companies <> 1 then
    raise exception
      'Refusing to purge: expected one company matching the complete workbook, found %.',
      v_candidate_companies;
  end if;

  perform public.lock_workforce_payment_allocation_company(v_company_id);

  -- These IDs belong to other people categories. Only remove the locationless,
  -- unresolved rows created by the Workforce advance bulk-import workflow.
  select count(*)
  into v_invalid_rows
  from public.workforce_advances advance
  join purge_nonworkforce_advance_rows requested
    on public.normalize_people_dropx_id(advance.imported_dropx_id)
      = public.normalize_people_dropx_id(requested.dropx_id)
  where advance.company_id = v_company_id
    and (
      advance.source_type <> 'bulk_import'
      or advance.link_status <> 'pending'
      or advance.workforce_id is not null
      or advance.station_id is not null
      or advance.linked_at is not null
    );

  if v_invalid_rows <> 0 then
    raise exception
      'Refusing to purge: % matching advance row(s) are no longer pending Workforce imports.',
      v_invalid_rows;
  end if;

  select count(*)
  into v_recovery_rows
  from public.workforce_advance_recoveries recovery
  join public.workforce_advances advance
    on advance.company_id = recovery.company_id
   and advance.id = recovery.advance_id
  join purge_nonworkforce_advance_rows requested
    on public.normalize_people_dropx_id(advance.imported_dropx_id)
      = public.normalize_people_dropx_id(requested.dropx_id)
  where advance.company_id = v_company_id;

  if v_recovery_rows <> 0 then
    raise exception
      'Refusing to purge: % recovery row(s) already reference the selected advances.',
      v_recovery_rows;
  end if;

  with matched_totals as (
    select
      requested.dropx_id,
      requested.expected_amount,
      count(advance.id) as advance_count,
      coalesce(sum(advance.amount), 0)::numeric(18,2) as actual_amount
    from purge_nonworkforce_advance_rows requested
    left join public.workforce_advances advance
      on public.normalize_people_dropx_id(advance.imported_dropx_id)
        = public.normalize_people_dropx_id(requested.dropx_id)
     and advance.company_id = v_company_id
    group by requested.dropx_id, requested.expected_amount
  )
  select count(*)
  into v_amount_mismatches
  from matched_totals
  where advance_count = 0
     or actual_amount <> expected_amount;

  if v_amount_mismatches <> 0 then
    raise exception
      'Refusing to purge: % requested ID(s) are missing or their register total differs from the supplied workbook.',
      v_amount_mismatches;
  end if;

  delete from public.workforce_advances advance
  using purge_nonworkforce_advance_rows requested
  where advance.company_id = v_company_id
    and advance.source_type = 'bulk_import'
    and advance.link_status = 'pending'
    and advance.workforce_id is null
    and advance.station_id is null
    and advance.linked_at is null
    and public.normalize_people_dropx_id(advance.imported_dropx_id)
      = public.normalize_people_dropx_id(requested.dropx_id);

  get diagnostics v_deleted_rows = row_count;
  if v_deleted_rows < 16 then
    raise exception
      'Refusing to commit: expected at least 16 selected advance rows, deleted only %.',
      v_deleted_rows;
  end if;

  select count(*)
  into v_remaining_rows
  from public.workforce_advances advance
  join purge_nonworkforce_advance_rows requested
    on public.normalize_people_dropx_id(advance.imported_dropx_id)
      = public.normalize_people_dropx_id(requested.dropx_id)
  where advance.company_id = v_company_id;

  if v_remaining_rows <> 0 then
    raise exception
      'Refusing to commit: % selected Workforce advance row(s) remain after deletion.',
      v_remaining_rows;
  end if;
end;
$purge_nonworkforce_advances$;

-- Keep the original import batches as audit/idempotency tombstones so the same
-- erroneous workbook cannot recreate these Workforce advance rows.

commit;
