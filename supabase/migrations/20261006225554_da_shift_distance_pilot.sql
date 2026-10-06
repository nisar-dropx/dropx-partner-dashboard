create table public.ops_da_distance_pilots(
 id uuid primary key default gen_random_uuid(),company_id uuid not null references companies(id),station_id uuid not null references stations(id),
 workforce_id uuid not null,profile_id uuid not null,profile_type text not null,enabled boolean not null default false,
 effective_from date not null,effective_to date,max_accuracy_m numeric not null default 50 check(max_accuracy_m between 5 and 200),
 max_speed_kmh numeric not null default 100 check(max_speed_kmh between 10 and 150),max_gap_seconds integer not null default 300 check(max_gap_seconds between 30 and 900),
 max_shift_hours numeric not null default 12 check(max_shift_hours between 1 and 16),updated_at timestamptz not null default now(),updated_by uuid,
 unique(company_id,profile_id,profile_type),check(effective_to is null or effective_to>=effective_from)
);
create table public.ops_da_distance_points(
 id bigint generated always as identity primary key,company_id uuid not null references companies(id),pilot_id uuid not null references ops_da_distance_pilots(id),
 station_id uuid not null references stations(id),punch_date date not null,shift_in timestamptz not null,shift_sequence integer not null,
 captured_at timestamptz not null,lat double precision not null check(lat between -90 and 90),lng double precision not null check(lng between -180 and 180),accuracy_m double precision not null check(accuracy_m>=0),
 created_at timestamptz not null default now(),unique(pilot_id,captured_at)
);
create index ops_da_distance_points_scope on public.ops_da_distance_points(company_id,station_id,punch_date,captured_at);
alter table public.ops_da_distance_pilots enable row level security;
alter table public.ops_da_distance_points enable row level security;
revoke all on public.ops_da_distance_pilots,public.ops_da_distance_points from anon,authenticated;
grant all on public.ops_da_distance_pilots,public.ops_da_distance_points to service_role;
grant usage,select on sequence public.ops_da_distance_points_id_seq to service_role;
-- Explicit pilot configuration only; runtime has no station-code special case.
with station as(select s.id,s.company_id from stations s join companies c on c.id=s.company_id where c.name='DROPX LOGISTICS' and s.station_code='NLRF'),facts as(select s.*,ops_cps_source_facts(s.company_id,'2026-10-07','2026-10-07',array['NLRF']) d from station s)
insert into ops_da_distance_pilots(company_id,station_id,workforce_id,profile_id,profile_type,enabled,effective_from)
select f.company_id,f.id,(w->>'id')::uuid,(w->>'source_profile_id')::uuid,w->>'source_profile_type',true,'2026-10-07'
from facts f cross join lateral jsonb_array_elements(f.d->'workforce') w
where (w->>'is_active')::boolean and w->>'source_profile_type' in ('employee','contractor','field_executive','workforce')
and exists(select 1 from jsonb_array_elements(f.d->'mappings') m where m->>'workforce_id'=w->>'id' and coalesce((m->'payment_values'->>'KM_RUN')::numeric,0)>0 and m->>'effective_from'<='2026-10-07' and (m->>'effective_to' is null or m->>'effective_to'>='2026-10-07'))
on conflict(company_id,profile_id,profile_type) do nothing;
