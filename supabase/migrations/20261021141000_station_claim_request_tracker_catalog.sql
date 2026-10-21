begin;
-- Point the request-tracker source catalog at ops_station_loss_claims.
-- Does not drop workforce_station_loss_claims (empty; preserved for archival).
-- Idempotent: safe if already updated or the catalog table is absent.
do $$
begin
  if to_regclass('public.request_tracker_sources') is null then
    return;
  end if;
  update public.request_tracker_sources
  set source_table = 'ops_station_loss_claims',
      portal = 'Ops',
      aliases = '["reference"]'::jsonb,
      history = '[{"table": "ops_station_loss_claim_events", "keys": ["claim_id"]}]'::jsonb,
      label = 'Station loss claim'
  where kind = 'loss'
    and source_table = 'workforce_station_loss_claims';
end $$;
commit;
