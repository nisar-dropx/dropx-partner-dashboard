-- Backfill payment_head_approval_steps for every existing payment head, per
-- company, from the confirmed default chain: Senior Store Manager (own
-- station) -> Regional Manager (company-wide) -> Business Head (company-wide).
-- payment_process_role_ids already exists and is left untouched - it is not
-- an approval step, it is who processes payment after final approval.
--
-- Role matching is by role CODE, not id, since ids differ per company. A
-- company missing one of these roles simply gets fewer steps - the resolver
-- (application code) already treats a step with zero candidates as skippable
-- unless is_required is set, so a short chain here is safe, not broken.
begin;

do $$
declare
  company_row record;
  head_row record;
  srsm_role_id uuid;
  rm_role_id uuid;
  bh_role_id uuid;
  next_step int;
begin
  for company_row in select id from public.companies loop
    select id into srsm_role_id from public.user_roles
      where company_id = company_row.id and code = 'OPERATIONS_SRSM' and is_active = true limit 1;
    select id into rm_role_id from public.user_roles
      where company_id = company_row.id and code = 'OPERATIONS_RM' and is_active = true limit 1;
    select id into bh_role_id from public.user_roles
      where company_id = company_row.id and code = 'OPERATIONS_BH' and is_active = true limit 1;

    if srsm_role_id is null and rm_role_id is null and bh_role_id is null then
      continue;
    end if;

    for head_row in
      select id from public.payment_heads
        where company_id = company_row.id
          and not exists (
            select 1 from public.payment_head_approval_steps s
              where s.payment_head_id = payment_heads.id
          )
    loop
      next_step := 1;

      if srsm_role_id is not null then
        insert into public.payment_head_approval_steps (company_id, payment_head_id, step_order, candidates, is_required)
        values (company_row.id, head_row.id, next_step,
          jsonb_build_array(jsonb_build_object('role_id', srsm_role_id, 'scope', 'station')),
          false);
        next_step := next_step + 1;
      end if;

      if rm_role_id is not null then
        insert into public.payment_head_approval_steps (company_id, payment_head_id, step_order, candidates, is_required)
        values (company_row.id, head_row.id, next_step,
          jsonb_build_array(jsonb_build_object('role_id', rm_role_id, 'scope', 'company')),
          true);
        next_step := next_step + 1;
      end if;

      if bh_role_id is not null then
        insert into public.payment_head_approval_steps (company_id, payment_head_id, step_order, candidates, is_required)
        values (company_row.id, head_row.id, next_step,
          jsonb_build_array(jsonb_build_object('role_id', bh_role_id, 'scope', 'company')),
          true);
        next_step := next_step + 1;
      end if;
    end loop;
  end loop;
end $$;

-- Cache each request's total step count at its payment head, so the UI can
-- show progress without re-deriving it. Only backfills requests still open;
-- terminal requests (approved/rejected/processed/cancelled) don't need it.
update public.payment_requests pr
set total_steps = (
  select count(*) from public.payment_head_approval_steps s
    where s.payment_head_id = pr.payment_head_id
)
where pr.total_steps is null
  and pr.status in ('pending', 'resubmitted')
  and exists (
    select 1 from public.payment_head_approval_steps s where s.payment_head_id = pr.payment_head_id
  );

commit;
