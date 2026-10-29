begin;
-- Loss recovery now reads the unpaid bank balance in the payout loader.
-- Invalidate its calculation token whenever an instruction or settlement changes.
do $$
declare v_table text := 'workforce_payout_payment_items';
begin
 execute format('drop trigger if exists workforce_payout_dependency_revision_insert on public.%I',v_table);
 execute format('create trigger workforce_payout_dependency_revision_insert after insert on public.%I referencing new table as payout_dependency_new_rows for each statement execute function public.workforce_touch_payout_dependency_from_new_rows()',v_table);
 execute format('drop trigger if exists workforce_payout_dependency_revision_update on public.%I',v_table);
 execute format('create trigger workforce_payout_dependency_revision_update after update on public.%I referencing old table as payout_dependency_old_rows new table as payout_dependency_new_rows for each statement execute function public.workforce_touch_payout_dependency_from_changed_rows()',v_table);
 execute format('drop trigger if exists workforce_payout_dependency_revision_delete on public.%I',v_table);
 execute format('create trigger workforce_payout_dependency_revision_delete after delete on public.%I referencing old table as payout_dependency_old_rows for each statement execute function public.workforce_touch_payout_dependency_from_old_rows()',v_table);
end $$;
commit;
