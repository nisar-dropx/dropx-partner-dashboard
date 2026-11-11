-- Keep the bank gate and report why each required publication failed it.
do $migration$
declare
  definition text := replace(pg_get_functiondef(
    'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure
  ), chr(13), '');
begin
  if strpos(definition, 'v_publication_blockers text;') > 0 then
    return;
  end if;

  if strpos(definition, $old0$  v_eligible_count integer;$old0$) = 0 then
    raise exception 'Unexpected Workforce payout candidate definition at change 1';
  end if;
  definition := replace(definition, $old0$  v_eligible_count integer;$old0$, $new0$  v_eligible_count integer;
  v_publication_blockers text;$new0$);

  if strpos(definition, $old1$        latest.id is not null
          and latest.snapshot ->> 'schema_version' = '2'
          and latest.snapshot ->> 'source' = 'workforce_payout_worksheet'
          and latest.snapshot -> 'item' ->> 'workforce_id' = v_workforce_id::text
          and (
            latest.snapshot #>> '{worksheet,payment_eligible}' = 'true'
            or (
              latest.snapshot #> '{worksheet,payment_eligible}' is null
              and latest.snapshot #> '{worksheet,payment_details_available}' is null
              and latest.snapshot #> '{worksheet,payment_status}' is null
              and latest.published_at < '2026-10-10 00:00:00+00'::timestamptz
            )
          )
          and latest.review_status in ('under_review', 'approved')
          and coalesce(latest.snapshot -> 'item' ->> 'net_amount', '')
            ~ '^[+-]?[0-9]+([.][0-9]+)?$'
          and nullif(btrim(coalesce(latest.snapshot_hash, '')), '') is not null
          and nullif(btrim(coalesce(
            latest.snapshot -> 'item' ->> 'station_code', station.station_code, ''
          )), '') is not null as is_valid$old1$) = 0 then
    raise exception 'Unexpected Workforce payout candidate definition at change 2';
  end if;
  definition := replace(definition, $old1$        latest.id is not null
          and latest.snapshot ->> 'schema_version' = '2'
          and latest.snapshot ->> 'source' = 'workforce_payout_worksheet'
          and latest.snapshot -> 'item' ->> 'workforce_id' = v_workforce_id::text
          and (
            latest.snapshot #>> '{worksheet,payment_eligible}' = 'true'
            or (
              latest.snapshot #> '{worksheet,payment_eligible}' is null
              and latest.snapshot #> '{worksheet,payment_details_available}' is null
              and latest.snapshot #> '{worksheet,payment_status}' is null
              and latest.published_at < '2026-10-10 00:00:00+00'::timestamptz
            )
          )
          and latest.review_status in ('under_review', 'approved')
          and coalesce(latest.snapshot -> 'item' ->> 'net_amount', '')
            ~ '^[+-]?[0-9]+([.][0-9]+)?$'
          and nullif(btrim(coalesce(latest.snapshot_hash, '')), '') is not null
          and nullif(btrim(coalesce(
            latest.snapshot -> 'item' ->> 'station_code', station.station_code, ''
          )), '') is not null as is_valid$old1$, $new1$        case
          when latest.id is null then 'Publish before payment'
          when latest.snapshot ->> 'schema_version' is distinct from '2'
            or latest.snapshot ->> 'source' is distinct from 'workforce_payout_worksheet'
            or latest.snapshot #>> '{item,workforce_id}' is distinct from v_workforce_id::text
            then 'Published payout details are incomplete'
          when latest.review_status is null
            or latest.review_status not in ('under_review', 'approved')
            then 'Payout review is missing or no longer current'
          when coalesce(latest.snapshot #>> '{item,net_amount}', '') !~ '^[+-]?[0-9]+([.][0-9]+)?$'
            then 'Published payout amount is missing or invalid'
          when nullif(btrim(coalesce(latest.snapshot_hash, '')), '') is null
            then 'Published payout verification is missing'
          when nullif(btrim(coalesce(latest.snapshot #>> '{item,station_code}', station.station_code, '')), '') is null
            then 'Published payout location is missing'
          when latest.snapshot #>> '{worksheet,payment_eligible}' = 'true'
            or (
              latest.snapshot #> '{worksheet,payment_eligible}' is null
              and latest.snapshot #> '{worksheet,payment_details_available}' is null
              and latest.snapshot #> '{worksheet,payment_status}' is null
              and latest.published_at < '2026-10-10 00:00:00+00'::timestamptz
            )
            then null
          when latest.snapshot #>> '{worksheet,payment_status}' = 'Route distance pending'
            then 'Route distance pending'
          when latest.snapshot #>> '{worksheet,payment_details_available}' = 'false'
            then 'Payment details were incomplete when published'
          when latest.snapshot #>> '{worksheet,payment_status}' = 'Configuration incomplete'
            then 'Payout configuration was incomplete when published'
          else 'Published payout is missing bank-payment eligibility'
        end as ineligible_reason$new1$);

  if strpos(definition, $old2$      round(coalesce(sum(evaluated.target_amount) filter (where evaluated.is_valid), 0), 2)
    into v_required_count, v_eligible_count, v_current_publications, v_profile_target$old2$) = 0 then
    raise exception 'Unexpected Workforce payout candidate definition at change 3';
  end if;
  definition := replace(definition, $old2$      round(coalesce(sum(evaluated.target_amount) filter (where evaluated.is_valid), 0), 2)
    into v_required_count, v_eligible_count, v_current_publications, v_profile_target$old2$, $new2$      round(coalesce(sum(evaluated.target_amount) filter (where evaluated.ineligible_reason is null), 0), 2),
      string_agg(
        concat_ws(' · ', nullif(evaluated.resolved_station_code, ''), evaluated.ineligible_reason),
        '; ' order by evaluated.resolved_station_code, evaluated.station_id
      ) filter (where evaluated.ineligible_reason is not null)
    into v_required_count, v_eligible_count, v_current_publications, v_profile_target,
      v_publication_blockers$new2$);

  if strpos(definition, $old3$where evaluated.is_valid$old3$) = 0 then
    raise exception 'Unexpected Workforce payout candidate definition at change 4';
  end if;
  definition := replace(definition, $old3$where evaluated.is_valid$old3$, $new3$where evaluated.ineligible_reason is null$new3$);

  if strpos(definition, $old4$      eligibility_message := format(
        'A current published payout is stale, incomplete, or not explicitly payment-eligible for Workforce ID %s.',
        coalesce(dropx_id, v_workforce_id::text)
      );$old4$) = 0 then
    raise exception 'Unexpected Workforce payout candidate definition at change 5';
  end if;
  definition := replace(definition, $old4$      eligibility_message := format(
        'A current published payout is stale, incomplete, or not explicitly payment-eligible for Workforce ID %s.',
        coalesce(dropx_id, v_workforce_id::text)
      );$old4$, $new4$      eligibility_message := v_publication_blockers;$new4$);

  execute definition;
end
$migration$;
