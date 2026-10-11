begin;

-- Finalize the company-owned Workforce and Helper portions of one bank response
-- in a single PostgreSQL transaction.  The API resolves unrelated references
-- before calling this function; the ownership checks below are a database-side
-- boundary that prevents a future caller from widening that scope.
create or replace function public.finalize_owned_payout_payment_response(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_file_sha256 text,
  p_file_name text,
  p_workforce_rows jsonb,
  p_helper_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_workforce_count integer;
  v_helper_count integer;
  v_workforce_result jsonb;
  v_helper_result jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_batch_ids jsonb := '[]'::jsonb;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null then
    raise exception 'Company, actor and operation are required for a payout bank response.';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 bank response file hash is required.';
  end if;
  if nullif(btrim(coalesce(p_file_name, '')), '') is null or length(p_file_name) > 240 then
    raise exception 'A valid bank response file name is required.';
  end if;
  if jsonb_typeof(p_workforce_rows) is distinct from 'array'
    or jsonb_typeof(p_helper_rows) is distinct from 'array'
  then
    raise exception 'Workforce and Helper bank response rows must be arrays.';
  end if;

  v_workforce_count := jsonb_array_length(p_workforce_rows);
  v_helper_count := jsonb_array_length(p_helper_rows);
  if v_workforce_count + v_helper_count < 1
    or v_workforce_count + v_helper_count > 5000
  then
    raise exception 'Bank response must contain between 1 and 5000 company-owned rows.';
  end if;
  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_workforce_rows) response(value)
    where jsonb_typeof(response.value) is distinct from 'object'
  ) or exists (
    select 1
    from jsonb_array_elements(p_helper_rows) response(value)
    where jsonb_typeof(response.value) is distinct from 'object'
  ) then
    raise exception 'Every payout bank response row must be an object.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_workforce_rows) response(value)
    where nullif(
      public.workforce_payout_bank_reference_canonical(response.value ->> 'reference_no'),
      ''
    ) is null
      or not exists (
        select 1
        from public.workforce_payout_payment_items item
        where item.company_id = p_company_id
          and item.reference_no = public.workforce_payout_bank_reference_canonical(
            response.value ->> 'reference_no'
          )
      )
  ) then
    raise exception 'Every Workforce response row must reference a payment owned by this company.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_helper_rows) response(value)
    where nullif(
      public.workforce_payout_bank_reference_canonical(response.value ->> 'reference_no'),
      ''
    ) is null
      or not exists (
        select 1
        from public.helper_payout_payment_items item
        where item.company_id = p_company_id
          and item.reference_no = public.workforce_payout_bank_reference_canonical(
            response.value ->> 'reference_no'
          )
      )
  ) then
    raise exception 'Every Helper response row must reference a payment owned by this company.';
  end if;

  -- Keep this order stable for every mixed import.  Any exception from either
  -- finalizer aborts this outer function call and rolls back both ledgers.
  if v_workforce_count > 0 then
    v_workforce_result := public.workforce_finalize_payout_payment_response(
      p_company_id,
      p_actor_user_id,
      p_operation_id,
      p_file_sha256,
      p_file_name,
      p_workforce_rows
    );
  end if;
  if v_helper_count > 0 then
    v_helper_result := public.helper_finalize_payout_payment_response(
      p_company_id,
      p_actor_user_id,
      p_operation_id,
      p_file_sha256,
      p_file_name,
      p_helper_rows
    );
  end if;

  select coalesce(
    jsonb_agg(combined.row_value order by combined.row_number, combined.audience_order, combined.position),
    '[]'::jsonb
  )
  into v_rows
  from (
    select
      response.value as row_value,
      case
        when coalesce(response.value ->> 'row_number', '') ~ '^[0-9]+$'
          then (response.value ->> 'row_number')::bigint
        else 9223372036854775807::bigint
      end as row_number,
      0 as audience_order,
      response.ordinality as position
    from jsonb_array_elements(coalesce(v_workforce_result -> 'rows', '[]'::jsonb))
      with ordinality response(value, ordinality)
    union all
    select
      response.value as row_value,
      case
        when coalesce(response.value ->> 'row_number', '') ~ '^[0-9]+$'
          then (response.value ->> 'row_number')::bigint
        else 9223372036854775807::bigint
      end as row_number,
      1 as audience_order,
      response.ordinality as position
    from jsonb_array_elements(coalesce(v_helper_result -> 'rows', '[]'::jsonb))
      with ordinality response(value, ordinality)
  ) combined;

  select coalesce(jsonb_agg(combined.batch_id order by combined.batch_id), '[]'::jsonb)
  into v_batch_ids
  from (
    select response.value as batch_id
    from jsonb_array_elements_text(coalesce(v_workforce_result -> 'batch_ids', '[]'::jsonb)) response(value)
    union
    select response.value as batch_id
    from jsonb_array_elements_text(coalesce(v_helper_result -> 'batch_ids', '[]'::jsonb)) response(value)
  ) combined;

  return jsonb_build_object(
    'paid',
      coalesce((v_workforce_result ->> 'paid')::integer, 0)
        + coalesce((v_helper_result ->> 'paid')::integer, 0),
    'cancelled',
      coalesce((v_workforce_result ->> 'cancelled')::integer, 0)
        + coalesce((v_helper_result ->> 'cancelled')::integer, 0),
    'replayed_items',
      coalesce((v_workforce_result ->> 'replayed_items')::integer, 0)
        + coalesce((v_helper_result ->> 'replayed_items')::integer, 0),
    'rejected',
      coalesce((v_workforce_result ->> 'rejected')::integer, 0)
        + coalesce((v_helper_result ->> 'rejected')::integer, 0),
    'unknown',
      coalesce((v_workforce_result ->> 'unknown')::integer, 0)
        + coalesce((v_helper_result ->> 'unknown')::integer, 0),
    'batch_ids', v_batch_ids,
    'ledgers', jsonb_strip_nulls(jsonb_build_object(
      'workforce', v_workforce_result,
      'helpers', v_helper_result
    )),
    'replayed',
      (v_workforce_result is null or coalesce((v_workforce_result ->> 'replayed')::boolean, false))
      and (v_helper_result is null or coalesce((v_helper_result ->> 'replayed')::boolean, false)),
    'rows', v_rows
  );
end
$function$;

comment on function public.finalize_owned_payout_payment_response(
  uuid, uuid, uuid, text, text, jsonb, jsonb
) is
  'Atomically finalizes the company-owned Workforce and Helper portions of one bank response and returns their combined result.';

revoke all on function public.finalize_owned_payout_payment_response(
  uuid, uuid, uuid, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_owned_payout_payment_response(
  uuid, uuid, uuid, text, text, jsonb, jsonb
) to service_role;

notify pgrst, 'reload schema';

commit;
