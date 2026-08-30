begin;

alter table public.workforce_deduction_heads
  add column if not exists is_system boolean not null default false,
  add column if not exists percentage_without_pan numeric(5,2) not null default 0,
  add column if not exists workforce_category_codes text[] not null default '{}'::text[];

alter table public.workforce_deduction_heads
  drop constraint if exists workforce_deduction_heads_percentage_without_pan_check;
alter table public.workforce_deduction_heads
  add constraint workforce_deduction_heads_percentage_without_pan_check
  check (percentage_without_pan >= 0 and percentage_without_pan <= 100);

comment on column public.workforce_deduction_heads.is_system is
  'True for protected deduction heads supplied by the system.';
comment on column public.workforce_deduction_heads.percentage_without_pan is
  'Alternate percentage used by the TDS system deduction when a valid PAN is unavailable.';
comment on column public.workforce_deduction_heads.workforce_category_codes is
  'Workforce category codes to which the deduction applies. Empty means unrestricted for normal heads and unconfigured for TDS.';

insert into public.workforce_deduction_heads (
  company_id,
  code,
  name,
  description,
  calculation_type,
  default_value,
  percentage_without_pan,
  workforce_category_codes,
  applies_to_all,
  is_system,
  is_active
)
select
  company.id,
  'TDS',
  'TDS Deduction',
  'System TDS deduction with separate percentages for workers with and without PAN.',
  'percentage',
  0,
  0,
  '{}'::text[],
  true,
  true,
  true
from public.companies company
on conflict (company_id, code) do update
set
  name = 'TDS Deduction',
  calculation_type = 'percentage',
  applies_to_all = true,
  is_system = true,
  updated_at = now();

create or replace function public.seed_system_tds_deduction_head()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workforce_deduction_heads (
    company_id, code, name, description, calculation_type, default_value,
    percentage_without_pan, workforce_category_codes, applies_to_all, is_system, is_active
  ) values (
    new.id, 'TDS', 'TDS Deduction',
    'System TDS deduction with separate percentages for workers with and without PAN.',
    'percentage', 0, 0, '{}'::text[], true, true, true
  ) on conflict (company_id, code) do nothing;
  return new;
end;
$$;

drop trigger if exists companies_seed_system_tds_deduction_head on public.companies;
create trigger companies_seed_system_tds_deduction_head
after insert on public.companies
for each row execute function public.seed_system_tds_deduction_head();

revoke all on function public.seed_system_tds_deduction_head() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
