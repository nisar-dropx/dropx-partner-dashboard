-- Formalizes dropx-partner-dashboard as the single source of truth for the
-- hr_expense_* reimbursement schema and its RPCs, which had been independently
-- evolved by both dropx-partner-dashboard and dropx-hrms migrations against the
-- same shared database (each running its own `create or replace function`
-- against hr_decide_expense_claim, hr_submit_expense_claim, etc, with whichever
-- repo deployed last silently overwriting the other's logic).
--
-- A full audit (2026-09-15) confirmed dropx-partner-dashboard's current
-- function bodies are a strict superset of dropx-hrms's - same self-approval
-- guard, and the Managing-Partner-auto-skip-after-senior-head behavior from
-- dropx-hrms's 20260908170000_senior_head_skip_managing_partner.sql was not
-- lost: it is intentionally disabled for the reimbursement workflow via the
-- existing skip_managing_partner_after_senior_head route flag (see
-- 20260915134500_reimbursement_manager_finance_chain.sql), not removed. No
-- unique dropx-hrms logic needs porting.
--
-- Going forward: only dropx-partner-dashboard's migrations should create or
-- replace hr_expense_claims, hr_expense_claim_requests,
-- hr_expense_claim_request_assignees, hr_expense_approval_steps,
-- hr_expense_items, hr_expense_attachments, hr_expense_events,
-- hr_expense_categories, hr_expense_policies, hr_expense_policy_categories,
-- hr_submit_expense_claim, hr_resubmit_expense_claim, hr_decide_expense_claim,
-- hr_submit_expense_claim_request, hr_decide_expense_claim_request, and
-- hr_expense_claim_send_to_payment. dropx-hrms should only read/call these
-- objects, never redefine them. This migration adds a warning-only event
-- trigger (never blocks a deploy) that logs a NOTICE whenever one of these
-- objects is redefined, naming the migration file where it should live
-- instead, to catch an accidental future collision early via database logs.

begin;

comment on table public.hr_expense_claims is
  'Owned by dropx-partner-dashboard migrations. Do not create/alter/replace this table or its RPCs from dropx-hrms - see 20260915150000_expense_schema_ownership_guard.sql.';
comment on table public.hr_expense_claim_requests is
  'Owned by dropx-partner-dashboard migrations. Do not create/alter/replace this table or its RPCs from dropx-hrms - see 20260915150000_expense_schema_ownership_guard.sql.';
comment on table public.hr_expense_claim_request_assignees is
  'Owned by dropx-partner-dashboard migrations. Do not create/alter/replace this table or its RPCs from dropx-hrms - see 20260915150000_expense_schema_ownership_guard.sql.';
comment on table public.hr_expense_approval_steps is
  'Owned by dropx-partner-dashboard migrations. Do not create/alter/replace this table or its RPCs from dropx-hrms - see 20260915150000_expense_schema_ownership_guard.sql.';

create or replace function public.hr_expense_schema_ownership_notice()
returns event_trigger
language plpgsql as $$
declare
  obj record;
  guarded_names text[] := array[
    'hr_expense_claims', 'hr_expense_claim_requests', 'hr_expense_claim_request_assignees',
    'hr_expense_approval_steps', 'hr_expense_items', 'hr_expense_attachments', 'hr_expense_events',
    'hr_expense_categories', 'hr_expense_policies', 'hr_expense_policy_categories',
    'hr_submit_expense_claim', 'hr_resubmit_expense_claim', 'hr_decide_expense_claim',
    'hr_submit_expense_claim_request', 'hr_decide_expense_claim_request', 'hr_expense_claim_send_to_payment'
  ];
begin
  for obj in select * from pg_event_trigger_ddl_commands() loop
    if obj.object_type in ('table', 'function') then
      if exists (
        select 1 from unnest(guarded_names) as name
        where obj.object_identity ilike '%' || name || '%'
      ) then
        raise notice 'hr_expense schema ownership: % was just redefined (%). This schema is owned by dropx-partner-dashboard migrations - confirm this change belongs there, not in dropx-hrms. See 20260915150000_expense_schema_ownership_guard.sql.',
          obj.object_identity, obj.command_tag;
      end if;
    end if;
  end loop;
end;
$$;

drop event trigger if exists hr_expense_schema_ownership_guard;
create event trigger hr_expense_schema_ownership_guard
  on ddl_command_end
  when tag in ('CREATE TABLE', 'ALTER TABLE', 'CREATE FUNCTION', 'ALTER FUNCTION')
  execute function public.hr_expense_schema_ownership_notice();

commit;
