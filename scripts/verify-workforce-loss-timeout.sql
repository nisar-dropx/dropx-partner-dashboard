-- Run after the migration in the same production project's SQL Editor.
-- Read-only check: no payouts, mappings or recovery records are changed.
begin read only;
set local statement_timeout = '15s';
with started as materialized (
  select clock_timestamp() started_at
), due as materialized (
  select d.* from started s
  cross join lateral public.nl_loss_recovery_due(
    '43866344-b550-4e8a-9a2d-9d23f3d8a997'::uuid,
    '2026-10','workforce',null
  ) d
  where s.started_at is not null
)
select
  strpos(pg_get_functiondef('public.nl_loss_recovery_due(uuid,text,text,uuid)'::regprocedure),
    'workforce_loss_due_history_batch_v1')>0 as performance_fix_installed,
  count(*) as october_recovery_lines,
  coalesce(sum(amount),0) as october_due_recovery_amount,
  round(extract(epoch from (clock_timestamp()-(select started_at from started)))*1000) as elapsed_ms
from due;
rollback;
