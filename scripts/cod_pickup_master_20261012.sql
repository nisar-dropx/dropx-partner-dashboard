-- User-provided COD pickup table, 12 October 2026. Data only: no station rules in application code.
-- Existing portal settings, foreign keys and permissions are retained.
begin;
alter table public.cod_station_settings
  add column if not exists pickup_configured boolean not null default false,
  add column if not exists pickup_rule text;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.cod_station_settings'::regclass and conname='cod_pickup_rule_valid') then
    alter table public.cod_station_settings add constraint cod_pickup_rule_valid check (pickup_rule is null or pickup_rule in ('Same Day-Complete','Same Day-Partial','Next Day'));
    alter table public.cod_station_settings add constraint cod_pickup_window_valid check (not pickup_configured or (pickup_rule is not null and pickup_window_start is not null and pickup_window_end is not null and pickup_window_end > pickup_window_start));
  end if;
end $$;
create temporary table cod_pickup_import(station_code text primary key, state text, agent_name text, agent_mobile text, rule text, start_time time, end_time time) on commit drop;
insert into cod_pickup_import values
('KANA','Odisha','KUMAR SINGH','6371268404','Same Day-Partial','18:30','19:00'),
('JDBD','Chattisgarh','Vivek Das','7974816049','Same Day-Complete','18:00','18:30'),
('RPRN','Chattisgarh','Amit Shil','6267344255','Same Day-Complete','18:00','18:30'),
('KDJE','Odisha','Basant Kumar Mahanta','6372130381','Next Day','10:00','10:30'),
('JGBA','Chattisgarh','Jhumuk Lal Patra','9340426045','Same Day-Complete','18:00','18:30'),
('JUGD','Odisha','Phinku','8917352923','Same Day-Partial','19:00','19:30'),
('SPBE','Odisha','Jaganath Sahoo','8328875713','Same Day-Complete','17:30','18:00'),
('KDJG','Odisha','Sanjai','7008928084','Next Day','11:00','11:30'),
('NLRE','Andhra Pradesh','GALLA MUNI GOPAL','9494291727','Same Day-Partial','19:00','19:30'),
('TIRC','Andhra Pradesh','KUMARA CHANDRA SHEKAR','9705080980','Next Day','13:00','13:30'),
('GDRD','Andhra Pradesh','KONDETI PRAVEEN KUMAR','9703117546','Same Day-Complete','19:00','19:30'),
('GYMC','Andhra Pradesh','Govardhan','8008928988','Next Day','11:00','11:30'),
('GNTI','Andhra Pradesh','VALENTI NARAYANA','9912367243','Next Day','10:00','10:30'),
('GNTF','Andhra Pradesh','G Anil','9948490110','Same Day-Complete','19:00','19:30'),
('NLRC','Andhra Pradesh','B.SATHISH','9703439449','Same Day-Complete','19:00','19:30'),
('NLRF','Andhra Pradesh','P VENKATARAO','9701874774','Same Day-Complete','19:00','19:30'),
('XAPI','Andhra Pradesh','Saidulu','9347939640','Next Day','13:30','14:00'),
('XAPH','Andhra Pradesh','','','Next Day','15:00','15:30'),
('XAPL','Andhra Pradesh','','','Same Day-Complete','18:00','18:30'),
('JUGF','Odisha','Dileep Kumar Rout','7978792495','Next Day','08:00','08:30');
-- Fail atomically if a station is missing or ambiguous. Never silently skip a source row.
do $$ begin
  if exists (select i.station_code from cod_pickup_import i left join public.stations s on s.station_code=i.station_code and s.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' group by i.station_code having count(s.id) <> 1) then
    raise exception 'Pickup import requires one matching DropX location for every station';
  end if;
end $$;
insert into public.cod_station_settings(company_id,location_id,station_code,state,cms_agency,agent_name,agent_mobile,cod_deposit_day,pickup_time,pickup_window_start,pickup_window_end,pickup_configured,pickup_rule,portal_station_code)
select s.company_id,s.id,s.station_code,i.state,'Radiant',i.agent_name,i.agent_mobile,case when i.rule='Next Day' then 'Next Day' else 'Same Day' end,to_char(i.start_time,'HH24:MI')||'–'||to_char(i.end_time,'HH24:MI'),i.start_time,i.end_time,true,i.rule,s.station_code
from cod_pickup_import i join public.stations s on s.station_code=i.station_code and s.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
on conflict(company_id,location_id) do update set
  state=excluded.state,cms_agency=excluded.cms_agency,agent_name=excluded.agent_name,agent_mobile=excluded.agent_mobile,cod_deposit_day=excluded.cod_deposit_day,pickup_time=excluded.pickup_time,pickup_window_start=excluded.pickup_window_start,pickup_window_end=excluded.pickup_window_end,pickup_rule=excluded.pickup_rule,pickup_configured=true,updated_at=now()
-- A rerun must not replace later edits or resurrect deleted pickup setups.
where public.cod_station_settings.pickup_rule is null;
update public.app_pages set name='COD Pickup Master' where code='cod_master';
commit;
select station_code, pickup_rule, pickup_time, agent_name, agent_mobile from public.cod_station_settings where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and pickup_configured order by station_code;
