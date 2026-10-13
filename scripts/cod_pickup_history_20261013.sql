-- User confirmed all listed stations are Next Day, and approved 30-minute windows
-- derived from remittance last-updated history. One median per update day avoids
-- multiple records from a single upload biasing the estimate. Evidence is retained
-- in output/cod-lifecycle-20261013/pickup-history-ui.json and pickup-estimates.json.
-- KBWE: user confirmed CMS has not started; no pickup hour is invented.
begin;
alter table public.cod_station_settings add column if not exists pickup_window_basis text;
alter table public.cod_station_settings drop constraint if exists cod_pickup_window_valid;
alter table public.cod_station_settings add constraint cod_pickup_window_valid check
 (not pickup_configured or (pickup_rule is not null and ((pickup_window_start is null and pickup_window_end is null) or (pickup_window_start is not null and pickup_window_end is not null and pickup_window_end > pickup_window_start))));
-- Tomorrow's preparation can begin before today's evening collection. These are
-- independent schedules; the previous constraint incorrectly coupled them.
alter table public.cod_station_settings drop constraint if exists cod_next_day_preparation_valid;
create temporary table cod_pickup_estimates(station_code text primary key, window_start time, window_end time, basis text) on commit drop;
insert into cod_pickup_estimates values
('HBSC','18:45','19:15','Estimated from 7 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window.'),
('KBWE',null,null,'CMS not started'),
('KGQA','10:30','11:00','Estimated from 12 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window. Update times vary widely; confirm with CMS.'),
('KGQC','10:30','11:00','Estimated from 11 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window.'),
('KGQE','11:00','11:30','Estimated from 10 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window. Update times vary widely; confirm with CMS.'),
('KLZA','12:45','13:15','Estimated from 10 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window. Update times vary widely; confirm with CMS.'),
('KLZH','09:30','10:00','Estimated from 11 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window.'),
('KOZA','11:15','11:45','Estimated from 11 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window. Update times vary widely; confirm with CMS.'),
('KTUB','13:00','13:30','Estimated from 12 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window. Update times vary widely; confirm with CMS.'),
('KTUO','10:00','10:30','Estimated from 6 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window. Update times vary widely; confirm with CMS.'),
('KTUR','10:15','10:45','Estimated from 10 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window. Update times vary widely; confirm with CMS.'),
('PEUA','09:30','10:00','Estimated from 10 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window.'),
('QLDA','14:15','14:45','Estimated from 5 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window. Update times vary widely; confirm with CMS.'),
('TLPA','10:15','10:45','Estimated from 10 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window.'),
('TLPB','10:15','10:45','Estimated from 9 distinct remittance-update days, 28 Sep–13 Oct 2026; median daily update, 30-minute window. Update times vary widely; confirm with CMS.');
do $$ begin
 if (select count(*) from cod_pickup_estimates e join public.stations s using(station_code) where s.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and s.is_active) <> 15 then raise exception 'Expected 15 authorized active stations'; end if;
end $$;
insert into public.cod_station_settings(company_id,location_id,station_code,state,cms_agency,agent_name,agent_mobile,cod_deposit_day,pickup_rule,pickup_time,pickup_window_start,pickup_window_end,pickup_window_basis,pickup_configured,next_day_preparation_from,driver_recon_due_time,recon_age_flag_days,cod_status_max_age_minutes,portal_station_code)
select s.company_id,s.id,s.station_code,s.state,'','','','Next Day','Next Day',case when e.window_start is not null then to_char(e.window_start,'HH24:MI')||'–'||to_char(e.window_end,'HH24:MI') end,e.window_start,e.window_end,e.basis,true,'16:00','21:00',1,15,s.station_code
from cod_pickup_estimates e join public.stations s using(station_code)
where s.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and s.is_active
on conflict (company_id,location_id) do nothing;
commit;
select station_code,pickup_rule,pickup_time,next_day_preparation_from,pickup_window_basis from public.cod_station_settings where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and station_code in ('HBSC','KBWE','KGQA','KGQC','KGQE','KLZA','KLZH','KOZA','KTUB','KTUO','KTUR','PEUA','QLDA','TLPA','TLPB') order by station_code;
