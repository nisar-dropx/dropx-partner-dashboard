alter table public.stations add column if not exists inbound_requires_destination boolean not null default false;
update public.stations set inbound_requires_destination=true where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and station_code in ('NLRE','JGBA');
comment on column public.stations.inbound_requires_destination is 'Mixed receiving hub: exclude unverified destination packages from planning totals. Editable in Location Master.';
