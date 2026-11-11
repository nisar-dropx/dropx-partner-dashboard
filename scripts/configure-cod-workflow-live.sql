-- Apply after the matching OpsPulse release is Ready. Preserve destinations and source scopes.
begin;
update report_bot_lm_dispatch_routes
set times=array['14:00','16:00','18:00','20:00','22:00'],schedule_start='14:00',schedule_end='22:00',interval_minutes=120,updated_at=now()
where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and report='scrub' and enabled;
update report_bot_lm_dispatch_routes r
set cod_workflow=true,cod_route_service_url='https://dropx-amazon-sync.withered-voice-1c40.workers.dev/cod-return-estimate',
 cod_reconciliation_allowance_minutes=15,cod_shortfall_lead_minutes=60,
 times=(select array_agg(to_char(t,'HH24:MI') order by t) from generate_series(timestamp '2000-01-01 08:00',timestamp '2000-01-01 23:30',interval '30 minutes') t)||array['23:55'],
 schedule_start='08:00',schedule_end='23:55',interval_minutes=30,mentions='{}',formats=array['photo'],updated_at=now()
where r.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and r.report='bank' and r.enabled
and exists(select 1 from report_bot_groups g where g.id=r.group_id and g.workspace='last_mile' and g.mode='live' and g.is_enabled and g.bot_in_group);
-- Keep legacy stage routes off: the single COD workflow now owns these stages.
update report_bot_lm_dispatch_routes set enabled=false,updated_at=now()
where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and report in('recon','deposit','slip') and enabled;
commit;
