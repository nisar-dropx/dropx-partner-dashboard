-- Rate rules are payout inputs and must invalidate stale recovery snapshots.
do $block$
begin
  if to_regclass('public.payment_conversion_rate_rules') is null then
    raise exception 'Required payout dependency table public.payment_conversion_rate_rules is missing.';
  end if;

  if not exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = 'payment_conversion_rate_rules'
      and column_info.column_name = 'company_id'
      and column_info.udt_name = 'uuid'
  ) then
    raise exception 'Required payout dependency table public.payment_conversion_rate_rules must have a UUID company_id column.';
  end if;
end;
$block$;

drop trigger if exists workforce_payout_dependency_revision_insert on public.payment_conversion_rate_rules;
create trigger workforce_payout_dependency_revision_insert
after insert on public.payment_conversion_rate_rules
referencing new table as payout_dependency_new_rows
for each statement execute function public.workforce_touch_payout_dependency_from_new_rows();

drop trigger if exists workforce_payout_dependency_revision_update on public.payment_conversion_rate_rules;
create trigger workforce_payout_dependency_revision_update
after update on public.payment_conversion_rate_rules
referencing old table as payout_dependency_old_rows new table as payout_dependency_new_rows
for each statement execute function public.workforce_touch_payout_dependency_from_changed_rows();

drop trigger if exists workforce_payout_dependency_revision_delete on public.payment_conversion_rate_rules;
create trigger workforce_payout_dependency_revision_delete
after delete on public.payment_conversion_rate_rules
referencing old table as payout_dependency_old_rows
for each statement execute function public.workforce_touch_payout_dependency_from_old_rows();

drop trigger if exists workforce_payout_dependency_revision_truncate on public.payment_conversion_rate_rules;
create trigger workforce_payout_dependency_revision_truncate
after truncate on public.payment_conversion_rate_rules
for each statement execute function public.workforce_touch_all_payout_dependency_revisions();
