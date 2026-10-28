begin;

-- A source refresh first marks the month absent and then upserts the rows that
-- still exist. Those transport fields are useful current-state metadata, but
-- they are not changes to a shipment and must not create two audit entries on
-- every refresh.
create or replace function public.nl_loss_source_snapshot(r jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'station_code', r->'station_code',
    'amount', r->'amount',
    'source_status', r->'source_status',
    'details', r->'details'
  )
$$;

create or replace function public.nl_loss_record_source_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  previous jsonb;
  current_value jsonb;
  identity_row jsonb;
  source_actor text;
  source_label text;
  run_id uuid;
begin
  if tg_op <> 'INSERT' then
    previous := public.nl_loss_source_snapshot(to_jsonb(old));
  end if;

  if tg_op = 'DELETE' then
    identity_row := to_jsonb(old);
    current_value := '{}'::jsonb;
  else
    identity_row := to_jsonb(new);
    current_value := public.nl_loss_source_snapshot(identity_row);
  end if;

  -- source_present, file/run IDs and observation clocks are deliberately not
  -- part of the snapshot. An unchanged hourly import therefore records nothing.
  if previous is distinct from current_value then
    begin
      run_id := nullif(identity_row->>'source_run_id', '')::uuid;
    exception when invalid_text_representation then
      run_id := null;
    end;

    if run_id is not null then
      select nullif(btrim(triggered_by), '')
        into source_actor
        from public.loss_report_runs
       where id = run_id;
    end if;

    source_label := case
      when coalesce(identity_row->>'report', 'nl') = 'slp' then 'Amazon SLP import'
      else 'Amazon NL import'
    end;

    insert into public.nl_loss_source_events(
      company_id, month, case_key, action, before_value, after_value, actor_name
    )
    values(
      (identity_row->>'company_id')::uuid,
      identity_row->>'month',
      identity_row->>'case_key',
      case tg_op
        when 'INSERT' then 'Source imported'
        when 'DELETE' then 'Source removed'
        else 'Source updated'
      end,
      previous,
      current_value,
      source_label || case when source_actor is null then ' (system)' else ' · ' || source_actor end
    );
  end if;

  return null;
end
$$;

drop trigger if exists nl_loss_record_source_history on public.nl_loss_month_cases;
create trigger nl_loss_record_source_history
after insert or update or delete on public.nl_loss_month_cases
for each row execute function public.nl_loss_record_source_history();

commit;
