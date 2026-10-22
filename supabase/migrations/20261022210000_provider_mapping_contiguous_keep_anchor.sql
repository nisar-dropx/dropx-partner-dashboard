-- Final hardening: Keep-all may span adjacent registered-location payment periods. Preserve the
-- deployed writer and every payout/owner/scope guard, while requiring the
-- confirmed audit anchor itself to be the row effective on the requested
-- start date. Full coverage continues to come from the canonical timeline
-- helper introduced in 20261015133000.
begin;

do $patch$
declare
  definition text;
  previous_check text := $previous$  if existing_mapping.effective_from > mapping_payload.effective_from
    or not public.workforce_provider_mapping_period_covered(
      p_company, p_workforce, existing_mapping.station_id,
      mapping_payload.provider_id, mapping_payload.provider_member_id,
      mapping_payload.effective_from, mapping_payload.effective_to
    )
$previous$;
  hardened_check text := $hardened$  if existing_mapping.effective_from > mapping_payload.effective_from
    or (
      existing_mapping.effective_to is not null
      and existing_mapping.effective_to < mapping_payload.effective_from
    )
    or not public.workforce_provider_mapping_period_covered(
      p_company, p_workforce, existing_mapping.station_id,
      mapping_payload.provider_id, mapping_payload.provider_member_id,
      mapping_payload.effective_from, mapping_payload.effective_to
    )
$hardened$;
begin
  select pg_get_functiondef(
    'public.workforce_keep_joining_mapping(uuid,uuid,uuid,uuid,text,jsonb,uuid[],text)'::regprocedure
  ) into definition;
  definition := replace(definition, E'\r\n', E'\n');
  previous_check := replace(previous_check, E'\r\n', E'\n');
  hardened_check := replace(hardened_check, E'\r\n', E'\n');

  if position(hardened_check in definition) = 0 then
    if (length(definition) - length(replace(definition, previous_check, '')))
      / length(previous_check) <> 1
    then
      raise exception 'Unexpected Keep-all coverage definition; migration stopped without changing it';
    end if;
    execute replace(definition, previous_check, hardened_check);
  end if;
end
$patch$;

comment on function public.workforce_keep_joining_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) is 'Keeps an additional-location mapping only when a confirmed registered anchor is effective at the requested start and the complete same-identity registered timeline covers the full requested period.';

notify pgrst, 'reload schema';
commit;
