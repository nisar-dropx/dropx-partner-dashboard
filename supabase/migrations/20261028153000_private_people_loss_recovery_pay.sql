begin;

-- Recovery schedules need the target, amount and salary month, but People
-- payroll amounts must never be copied into Ops-facing recovery snapshots.
-- Workforce payout figures remain visible because those are operational DA
-- payout records rather than confidential People salary records.
create or replace function public.nl_private_recovery_allocations(p_allocations jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      case
        when allocation->>'ref' like 'workforce:%' then allocation
        else allocation
          - 'salary_payable'
          - 'salary_gross'
          - 'salary_source'
          - 'recovery_limit'
          - 'override_limit'
          - 'reserved'
      end
      order by ordinal
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(
    case when jsonb_typeof(p_allocations) = 'array' then p_allocations else '[]'::jsonb end
  ) with ordinality as rows(allocation, ordinal)
$$;

create or replace function public.nl_private_recovery_allocations_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.allocations := public.nl_private_recovery_allocations(new.allocations);
  return new;
end
$$;

drop trigger if exists nl_private_recovery_allocations_before_write on public.nl_loss_recoveries;
create trigger nl_private_recovery_allocations_before_write
  before insert or update of allocations on public.nl_loss_recoveries
  for each row execute function public.nl_private_recovery_allocations_before_write();

-- Remove confidential values that older versions copied into the current plan.
update public.nl_loss_recoveries
set allocations = public.nl_private_recovery_allocations(allocations)
where exists (
  select 1 from jsonb_array_elements(coalesce(allocations, '[]'::jsonb)) item
  where item->>'ref' not like 'workforce:%'
    and item ?| array['salary_payable','salary_gross','salary_source','recovery_limit','override_limit','reserved']
);

-- The recovery audit stays operationally complete (person, amount, schedule,
-- decision and actor) while confidential People salary values are redacted.
update public.nl_loss_recovery_events
set before_value = case
      when jsonb_typeof(before_value) = 'object' and before_value ? 'allocations'
        then jsonb_set(before_value, '{allocations}', public.nl_private_recovery_allocations(before_value->'allocations'), false)
      else before_value
    end,
    after_value = case
      when jsonb_typeof(after_value) = 'object' and after_value ? 'allocations'
        then jsonb_set(after_value, '{allocations}', public.nl_private_recovery_allocations(after_value->'allocations'), false)
      else after_value
    end
where (jsonb_typeof(before_value) = 'object' and before_value ? 'allocations')
   or (jsonb_typeof(after_value) = 'object' and after_value ? 'allocations');

-- A one-time privacy repair is the only sanctioned mutation of immutable
-- lifecycle snapshots. Restore the immutability trigger immediately after it.
drop trigger if exists nl_loss_lifecycle_events_immutable on public.nl_loss_lifecycle_events;
update public.nl_loss_lifecycle_events
set snapshot = jsonb_set(
  snapshot,
  '{allocations}',
  public.nl_private_recovery_allocations(snapshot->'allocations'),
  false
)
where jsonb_typeof(snapshot) = 'object' and snapshot ? 'allocations';
create trigger nl_loss_lifecycle_events_immutable
  before update or delete on public.nl_loss_lifecycle_events
  for each row execute function public.nl_loss_lifecycle_events_immutable();

revoke all on function public.nl_private_recovery_allocations(jsonb) from public, anon, authenticated;
grant execute on function public.nl_private_recovery_allocations(jsonb) to service_role;
revoke all on function public.nl_private_recovery_allocations_before_write() from public, anon, authenticated;
grant execute on function public.nl_private_recovery_allocations_before_write() to service_role;

commit;
