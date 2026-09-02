begin;

-- The webhook previously stamped last_seen_at with retry time. Rebuild it
-- once from the immutable middleware receipt timestamp stored on raw events.
with latest_event as (
  select
    raw.device_id,
    max(raw.received_at) as last_seen_at
  from public.biometric_raw_events raw
  where raw.device_id is not null
    and raw.received_at is not null
    and raw.received_at <= now() + interval '5 minutes'
  group by raw.device_id
)
update public.biometric_devices device
set
  last_seen_at = latest.last_seen_at,
  status = case
    when latest.last_seen_at < now() - interval '10 minutes' then 'Disconnected'
    when upper(coalesce(device.model, '')) = 'D01'
      and not exists (
        select 1
        from public.biometric_raw_events timelog
        where timelog.device_id = device.id
          and lower(coalesce(timelog.event_type, '')) = 'timelog'
      ) then 'Heartbeat only'
    else 'Connected'
  end,
  updated_at = now()
from latest_event latest
where device.id = latest.device_id;

update public.biometric_devices device
set
  last_seen_at = null,
  status = 'Disconnected',
  updated_at = now()
where not exists (
  select 1
  from public.biometric_raw_events raw
  where raw.device_id = device.id
    and raw.received_at is not null
    and raw.received_at <= now() + interval '5 minutes'
);

commit;
