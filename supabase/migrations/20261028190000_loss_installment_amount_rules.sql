begin;
-- New/changed schedules only; do not invalidate an existing payroll obligation.
create or replace function public.enforce_loss_installment_amount_rules()
returns trigger language plpgsql security definer set search_path=public as $$
declare policy jsonb; line jsonb; months integer; threshold numeric;
begin
  if new.is_deleted or new.recovery_mode <> 'installments' then return new; end if;
  if tg_op = 'UPDATE' and not old.is_deleted and old.recovery_mode = new.recovery_mode
    and old.allocations is not distinct from new.allocations
    and old.installment_basis is not distinct from new.installment_basis
    and old.installment_value is not distinct from new.installment_value then return new; end if;
  select recovery_policy into policy from public.nl_loss_sources where company_id=new.company_id;
  if coalesce((policy->>'installment_thresholds_enabled')::boolean,false) = false then return new; end if;
  for line in select value from jsonb_array_elements(new.allocations) loop
    months := jsonb_array_length(coalesce(line->'installments','[]'::jsonb));
    if months < 2 or months > coalesce((policy->>'max_installments')::integer,24) then
      raise exception 'Invalid recurring recovery schedule';
    end if;
    threshold := case when months=2 then (policy->>'installment_two_month_min')::numeric
      else (policy->>'installment_three_month_min')::numeric + (months-3)*(policy->>'installment_extra_month_step')::numeric end;
    if threshold is null or threshold <= 0 then raise exception 'Recurring recovery rules are incomplete'; end if;
    if coalesce((line->>'amount')::numeric,0) <= threshold then
      raise exception '% months requires a recovery share above Rs % for %. Choose fewer months or Full debit.', months,threshold,coalesce(line->>'employee_code',line->>'ref');
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.enforce_loss_installment_amount_rules() from public;
drop trigger if exists nl_loss_installment_amount_rules on public.nl_loss_recoveries;
create trigger nl_loss_installment_amount_rules before insert or update on public.nl_loss_recoveries
for each row execute function public.enforce_loss_installment_amount_rules();
update public.nl_loss_sources set recovery_policy = jsonb_build_object(
 'installment_thresholds_enabled',true,'installment_two_month_min',7000,
 'installment_three_month_min',10000,'installment_extra_month_step',5000
) || coalesce(recovery_policy,'{}'::jsonb), updated_at=now()
where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and not coalesce(recovery_policy,'{}'::jsonb) ? 'installment_thresholds_enabled';
commit;
