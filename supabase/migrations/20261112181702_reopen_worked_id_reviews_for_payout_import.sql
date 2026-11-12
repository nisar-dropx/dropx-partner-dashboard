begin;

-- The upload and any review corrections must commit or roll back together.
create or replace function public.workforce_apply_payout_import_with_review_reopen(
  p_company_id uuid,
  p_effective_from date,
  p_effective_to date,
  p_file_name text,
  p_file_sha256 text,
  p_rows jsonb,
  p_actor_user_id uuid,
  p_allowed_location_ids uuid[] default null
) returns uuid
language plpgsql security invoker set search_path = ''
as $function$
declare
  previous_context text := current_setting('app.workforce_import_review_context', true);
  batch_id uuid;
begin
  if p_actor_user_id is null or p_company_id is null then
    raise exception 'An authenticated importer and company are required.';
  end if;
  perform set_config('app.workforce_import_review_context', jsonb_build_object(
    'company', p_company_id, 'actor', p_actor_user_id, 'locations', p_allowed_location_ids
  )::text, true);
  batch_id := public.workforce_apply_payout_import(
    p_company_id, p_effective_from, p_effective_to, p_file_name,
    p_file_sha256, p_rows, p_actor_user_id, p_allowed_location_ids
  );
  perform set_config('app.workforce_import_review_context', coalesce(previous_context, ''), true);
  return batch_id;
end;
$function$;

revoke all on function public.workforce_apply_payout_import_with_review_reopen(
  uuid,date,date,text,text,jsonb,uuid,uuid[]
) from public, anon, authenticated;
grant execute on function public.workforce_apply_payout_import_with_review_reopen(
  uuid,date,date,text,text,jsonb,uuid,uuid[]
) to service_role;

-- Change only the attendance/production branch. Mapping and CPS evidence
-- still require explicit review correction.
do $migration$
declare
  definition text := replace(pg_get_functiondef(
    'public.guard_worked_id_review_inputs()'::regprocedure
  ), chr(13), '');
  old_block constant text := $old$  if exists(select 1 from public.workforce_worked_id_reviews r where r.company_id=c
   and ((tg_table_name='workforce_custom_production_inputs' and r.decision='worked' and r.work_date=d and
     (r.workforce_id=worker or exists(select 1 from public.workforce_worked_id_shares a where a.review_id=r.id and a.owner_workforce_id=worker)))
    or (tg_table_name<>'workforce_custom_production_inputs' and r.decision='not_worked' and r.workforce_id=worker
       and r.work_date between coalesce(d,(v->>'effective_from')::date) and coalesce(d,(v->>'effective_to')::date)))) then
   raise exception 'This input conflicts with a Worked ID review. Reopen that day before importing replacement attendance or production.';end if;$old$;
  new_block constant text := $new$  for review in
    select r.* from public.workforce_worked_id_reviews r
    where r.company_id = c
      and (
        (tg_table_name = 'workforce_custom_production_inputs' and r.decision = 'worked' and r.work_date = d
          and (r.workforce_id = worker or exists (
            select 1 from public.workforce_worked_id_shares a
            where a.review_id = r.id and a.owner_workforce_id = worker
          )))
        or (tg_table_name <> 'workforce_custom_production_inputs' and r.decision = 'not_worked'
          and r.workforce_id = worker
          and r.work_date between coalesce(d, (v->>'effective_from')::date)
                              and coalesce(d, (v->>'effective_to')::date))
      )
    order by r.work_date, r.id
  loop
    if current_setting('role', true) is distinct from 'service_role' then
      raise exception 'This input conflicts with a Worked ID review. Reopen that day before replacing the input.';
    end if;
    import_context := nullif(current_setting('app.workforce_import_review_context', true), '')::jsonb;
    if import_context->>'company' is distinct from c::text or import_context->>'actor' is null then
      raise exception 'This input conflicts with a Worked ID review. Reopen that day before replacing the input.';
    end if;
    if jsonb_typeof(import_context->'locations') = 'array'
      and not (import_context->'locations' ? review.station_id::text) then
      raise exception 'A conflicting Worked ID review is outside your permitted locations.';
    end if;
    perform public.save_workforce_worked_id_review(
      c, (import_context->>'actor')::uuid, review.workforce_id, review.station_id,
      review.work_date, 'reopened', 'Reopened by replacement Workforce payout import.',
      review.version, '[]'::jsonb
    );
  end loop;$new$;
begin
  if strpos(definition, new_block) > 0 then return; end if;
  if strpos(definition, old_block) = 0 or strpos(definition, 'worker uuid;') = 0 then
    raise exception 'Unexpected Worked ID input guard definition.';
  end if;
  execute replace(replace(definition, 'worker uuid;', 'worker uuid; review record; import_context jsonb;'), old_block, new_block);
end;
$migration$;

notify pgrst, 'reload schema';
commit;
