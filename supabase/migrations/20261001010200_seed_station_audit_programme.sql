-- Materialise the current configured programme immediately. This deliberately
-- reads cadence, slots, time and response targets from Audit Master rather than
-- embedding any audit business rule in this migration.
do $$
declare
  v_today date := timezone('Asia/Kolkata', now())::date;
  v_type record;
  v_station record;
  v_slot jsonb;
  v_station_index integer;
  v_slot_code text;
  v_time text;
  v_start_day integer;
  v_end_day integer;
  v_slot_width integer;
  v_scheduled_on date;
  v_scheduled_for timestamptz;
  v_cycle_key text;
begin
  for v_type in
    select *
    from public.ops_audit_types
    where is_active = true
      and jsonb_typeof(scheduling_config -> 'period_slots') = 'array'
  loop
    v_time := coalesce(v_type.scheduling_config ->> 'schedule_time', '');
    if v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      continue;
    end if;

    v_station_index := 0;
    for v_station in
      select id, station_code, station_name, city, cluster, cluster_name
      from public.stations
      where company_id = v_type.company_id
        and is_active = true
        and coalesce(hide_from_location_list, false) = false
      order by station_code
    loop
      for v_slot in
        select value
        from jsonb_array_elements(v_type.scheduling_config -> 'period_slots')
      loop
        -- A weekly type uses its configured weekday range to distribute each
        -- station. Other cadences receive one audit per configured period slot.
        if v_type.cadence_unit = 'weekly' and v_slot <> (v_type.scheduling_config -> 'period_slots' -> 0) then
          continue;
        end if;

        v_slot_code := nullif(trim(v_slot ->> 'code'), '');
        if v_slot_code is null then
          continue;
        end if;
        v_start_day := greatest(1, coalesce(nullif(v_slot ->> 'start_day', '')::integer, 1));
        v_end_day := greatest(v_start_day, coalesce(nullif(v_slot ->> 'end_day', '')::integer, v_start_day));
        v_slot_width := greatest(1, v_end_day - v_start_day + 1);

        if v_type.cadence_unit = 'weekly' then
          v_scheduled_on := date_trunc('week', v_today)::date + (v_start_day - 1) + (v_station_index % v_slot_width);
          if v_scheduled_on < v_today then
            v_scheduled_on := v_scheduled_on + 7;
          end if;
          v_cycle_key := to_char(v_scheduled_on, 'IYYY-"W"IW');
        else
          v_scheduled_on := date_trunc('month', v_today)::date + (v_start_day - 1) + (v_station_index % v_slot_width);
          if v_scheduled_on < v_today then
            v_scheduled_on := date_trunc('month', v_today + interval '1 month')::date + (v_start_day - 1) + (v_station_index % v_slot_width);
          end if;
          v_cycle_key := to_char(v_scheduled_on, 'YYYY-MM');
        end if;

        v_scheduled_for := ((v_scheduled_on::text || ' ' || v_time)::timestamp at time zone 'Asia/Kolkata');
        insert into public.ops_station_audits (
          company_id, audit_number, audit_type_id, location_id, station_snapshot,
          cycle_key, period_slot, scheduled_for, scheduled_reason, schedule_source,
          status_code, response_due_at
        ) values (
          v_type.company_id,
          'AUD-' || to_char(v_scheduled_on, 'YYYYMMDD') || '-' || regexp_replace(upper(coalesce(v_station.station_code, 'STATION')), '[^A-Z0-9]', '', 'g') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
          v_type.id,
          v_station.id,
          jsonb_build_object('station_code', v_station.station_code, 'station_name', v_station.station_name, 'city', v_station.city, 'cluster', coalesce(v_station.cluster, v_station.cluster_name)),
          v_cycle_key,
          v_slot_code,
          v_scheduled_for,
          'Programme generated from Audit Master',
          'programme',
          'scheduled',
          v_scheduled_for + make_interval(hours => v_type.default_response_hours)
        ) on conflict (company_id, audit_type_id, location_id, cycle_key, period_slot) do nothing;
      end loop;
      v_station_index := v_station_index + 1;
    end loop;
  end loop;
end;
$$;
