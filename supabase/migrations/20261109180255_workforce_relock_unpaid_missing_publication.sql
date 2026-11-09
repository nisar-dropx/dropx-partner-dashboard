begin;

-- Preserve all later-installed bank, payroll and ownership guards. A selected
-- open correction may outlive its original publication after a data repair.
-- Permit publishing the newly calculated snapshot only if the entire impacted
-- month has no issued/paid bank evidence. Never invent a historical snapshot.
do $patch$
declare
  definition text;
  old_guard text := $old$        raise exception 'The source publication for a remapped payout is unavailable.';$old$;
  new_guard text := $new$        -- unpaid_missing_publication_relock_v1
        if exists (
          select 1 from public.workforce_payout_payment_items payment
          where payment.company_id = p_company_id
            and payment.workforce_id = any(v_impacted_ids)
            and daterange(payment.period_start, payment.period_end, '[]')
              && daterange(p_period_start, p_period_end, '[]')
            and payment.status in ('paid', 'processing')
        ) or exists (
          select 1 from public.workforce_payout_effective_paid_allocations paid
          where paid.company_id = p_company_id
            and (paid.credited_workforce_id = any(v_impacted_ids)
              or paid.original_workforce_id = any(v_impacted_ids))
            and daterange(paid.period_start, paid.period_end, '[]')
              && daterange(p_period_start, p_period_end, '[]')
        ) then
          raise exception 'The earlier payout publication is missing and this period has bank payment history. Restore its publication before relocking.';
        end if;
        -- The locked unlock audit and fresh server calculation provide the
        -- correction lineage; this is a new silent publication with no
        -- fabricated supersedes_publication_id.
        v_baseline.review_until := clock_timestamp() + interval '7 days';$new$;
  revision_marker text := $old$    insert into public.workforce_payout_publications (
      company_id, payroll_run_id, workforce_id, station_id, revision,$old$;
  revision_replacement text := $new$    -- Retain monotonically increasing revisions even if older rows were removed.
    v_next_revision := greatest(v_next_revision, coalesce((
      select max(unlock.base_revision) + 1
      from public.workforce_payout_mapping_unlocks unlock
      where unlock.company_id = p_company_id
        and unlock.id = any(p_unlock_ids)
        and unlock.workforce_id = v_workforce_id
    ), 1));

    insert into public.workforce_payout_publications (
      company_id, payroll_run_id, workforce_id, station_id, revision,$new$;
begin
  select pg_get_functiondef(
    'public.workforce_relock_payout_mappings(uuid,uuid,date,date,uuid[],uuid,text,text,jsonb)'::regprocedure
  ) into definition;
  if strpos(definition, 'unpaid_missing_publication_relock_v1') > 0 then
    return;
  end if;
  if strpos(definition, old_guard) = 0 or strpos(definition, revision_marker) = 0 then
    raise exception 'Unexpected relock function shape; missing-publication patch was not applied.';
  end if;
  definition := replace(definition, old_guard, new_guard);
  definition := replace(definition, revision_marker, revision_replacement);
  execute definition;
end
$patch$;

notify pgrst, 'reload schema';
commit;
