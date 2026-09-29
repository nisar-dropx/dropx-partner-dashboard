create table if not exists public.workforce_payment_settings (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  calculation_method text not null default 'calendar_days',
  paid_off_days smallint not null default 4,
  work_units_per_paid_off numeric(5,2) not null default 6,
  cap_at_monthly_amount boolean not null default true,
  effective_from date not null,
  change_reason text not null,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_payment_settings_company_month_key unique (company_id, effective_from),
  constraint workforce_payment_settings_method_check check (
    calculation_method in ('calendar_days', 'fixed_paid_offs', 'earned_paid_offs')
  ),
  constraint workforce_payment_settings_paid_off_days_check check (
    paid_off_days between 0 and 10
  ),
  constraint workforce_payment_settings_work_units_check check (
    work_units_per_paid_off between 0.5 and 31
    and work_units_per_paid_off * 2 = trunc(work_units_per_paid_off * 2)
  ),
  constraint workforce_payment_settings_change_reason_check check (
    char_length(btrim(change_reason)) between 3 and 250
  ),
  constraint workforce_payment_settings_month_start_check check (
    effective_from = date_trunc('month', effective_from)::date
  )
);

comment on table public.workforce_payment_settings is
  'Effective-dated company policy for attendance-based monthly workforce payment heads.';
comment on column public.workforce_payment_settings.calculation_method is
  'calendar_days preserves existing behavior; fixed_paid_offs uses calendar days less the allowance; earned_paid_offs credits an off after configured attendance units.';

create index if not exists workforce_payment_settings_updated_by_idx
  on public.workforce_payment_settings(updated_by)
  where updated_by is not null;

create index if not exists workforce_payment_settings_created_by_idx
  on public.workforce_payment_settings(created_by)
  where created_by is not null;

alter table public.workforce_payment_settings enable row level security;

revoke all on table public.workforce_payment_settings from public, anon, authenticated;
revoke all on sequence public.workforce_payment_settings_id_seq from public, anon, authenticated;
grant select, insert, update on table public.workforce_payment_settings to service_role;
grant usage, select on sequence public.workforce_payment_settings_id_seq to service_role;

create or replace function public.guard_finalized_workforce_payment_setting()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_month date := date_trunc('month', timezone('Asia/Kolkata', now()))::date;
  v_last_allowed_month date := (date_trunc('month', timezone('Asia/Kolkata', now())) + interval '24 months')::date;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if old.effective_from <= v_current_month then
      raise exception 'Workforce payment policy is locked once its effective month begins.';
    end if;
    if exists (
      select 1
      from public.workforce_payroll_runs payroll_run
      where payroll_run.company_id = old.company_id
        and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
        and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
          && daterange(old.effective_from, (old.effective_from + interval '1 month - 1 day')::date, '[]')
    ) then
      raise exception 'Workforce payment policy cannot change after payroll is approved or paid for that month.';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    if new.effective_from <= v_current_month or new.effective_from > v_last_allowed_month then
      raise exception 'Workforce payment policy must take effect from next month through 24 months ahead.';
    end if;
    if exists (
      select 1
      from public.workforce_payroll_runs payroll_run
      where payroll_run.company_id = new.company_id
        and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
        and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
          && daterange(new.effective_from, (new.effective_from + interval '1 month - 1 day')::date, '[]')
    ) then
      raise exception 'Workforce payment policy cannot change after payroll is approved or paid for that month.';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.guard_finalized_workforce_payment_setting() from public, anon, authenticated;
grant execute on function public.guard_finalized_workforce_payment_setting() to service_role;

drop trigger if exists workforce_payment_settings_finalized_guard
  on public.workforce_payment_settings;
create trigger workforce_payment_settings_finalized_guard
before insert or update or delete on public.workforce_payment_settings
for each row execute function public.guard_finalized_workforce_payment_setting();

comment on function public.guard_finalized_workforce_payment_setting() is
  'Locks active months, limits scheduling to the next 24 months, and protects months with approved or paid Workforce payroll.';
