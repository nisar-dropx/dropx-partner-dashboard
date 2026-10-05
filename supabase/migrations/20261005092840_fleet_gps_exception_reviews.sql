create table if not exists public.fleet_gps_exception_reviews (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 vehicle_id uuid not null references public.fleet_vehicles(id),
 vehicle_no text not null,
 movement_date date not null,
 exception_type text not null default 'after_hours' check(exception_type='after_hours'),
 reason text not null check(reason in ('authorised_work','driver_follow_up','gps_inaccuracy','other')),
 remarks text not null check(length(trim(remarks)) between 1 and 2000),
 reviewed_by uuid not null references public.profiles(id),
 reviewed_by_name text not null,
 reviewed_at timestamptz not null default now(),
 unique(company_id,vehicle_no,movement_date,exception_type)
);
alter table public.fleet_gps_exception_reviews enable row level security;
revoke all on public.fleet_gps_exception_reviews from anon,authenticated;
grant select,insert,update on public.fleet_gps_exception_reviews to service_role;
