-- Cost reporting ownership only; payroll rate cards and payments are unchanged.
create table public.ops_cps_component_policies (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 component_code text not null check(length(component_code) between 1 and 120),
 label text not null,
 mode text not null check(mode in ('fleet','workforce')),
 effective_from date not null,
 updated_by uuid,
 updated_at timestamptz not null default now(),
 unique(company_id,component_code,effective_from)
);
alter table public.ops_cps_component_policies enable row level security;
revoke all on public.ops_cps_component_policies from public,anon,authenticated;
grant select,insert,update,delete on public.ops_cps_component_policies to service_role;

create trigger cps_component_configuration_change after insert or update on public.ops_cps_component_policies
 for each row execute function public.ops_cps_record_configuration_change();

-- Seed existing fixed vehicle-rental fields; package/production pay stays in
-- Workforce. These source choices are editable in CPS setup with effective dates.
insert into public.ops_cps_component_policies(company_id,component_code,label,mode,effective_from)
select f.company_id,upper(trim(f.code)),f.label,'fleet',
 coalesce((select min(s.work_date) from public.cps_shipment_daily s where s.company_id=f.company_id),(now() at time zone 'Asia/Kolkata')::date)
from public.payment_fields f
where f.calculation_type in ('fixed_daily','fixed_monthly')
 and upper(f.code||' '||f.label) ~ '(VAN|VEHICLE).*RENT';
