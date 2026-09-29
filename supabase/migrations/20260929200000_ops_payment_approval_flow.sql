-- Ops-portal payment requests: Station -> CLM -> AOM -> Business Head -> Finance
-- (DROPX LOGISTICS, requested 2026-09-29).
--
--   Step 1 CLM     station  Cluster Manager, else City Manager, else the mapped
--                           AOM approves on the CLM's behalf. Optional.
--   Step 2 AOM     station  Area Operations Manager, else Regional Manager.
--                           Optional; skipped when the same person already
--                           approved at step 1 (code: advanceApproval dedupe).
--   Step 3 BH      company  Business Head. MANDATORY, never skipped.
--   Step 4 Finance company  Finance Manager, else Accounts. MANDATORY.
-- The station raises the request (unchanged).
--
-- Applies to the 11 heads raised from the Ops portal. DropX One app heads
-- (Employee reimbursement, Field recruiter travel reimbursement) keep their
-- existing flows. National Head is no longer an alternate for Business Head,
-- and Fleet Manager is no longer the first approver for Van Fuel / Vehicle
-- Repair / Vehicle Service (they follow the same flow as the rest).
--
-- In-flight requests keep working: effectiveApprovalStepOrder re-anchors a
-- request's step from its current approver's role.

begin;

do $$
declare
  v_company uuid;
  v_clm uuid; v_cm uuid; v_aom uuid; v_rm uuid; v_bh uuid; v_fin uuid; v_acc uuid;
  v_page uuid;
  v_heads integer;
begin
  select id into v_company from public.companies where name = 'DROPX LOGISTICS';
  if v_company is null then raise exception 'Company not found; nothing changed.'; end if;

  select id into v_clm from public.user_roles where company_id = v_company and product_code = 'operations' and code = 'OPERATIONS_CLM' and is_active;
  select id into v_cm  from public.user_roles where company_id = v_company and product_code = 'operations' and code = 'OPERATIONS_CM' and is_active;
  select id into v_aom from public.user_roles where company_id = v_company and product_code = 'operations' and code = 'OPERATIONS_AOM' and is_active;
  select id into v_rm  from public.user_roles where company_id = v_company and product_code = 'operations' and code = 'OPERATIONS_RM' and is_active;
  select id into v_bh  from public.user_roles where company_id = v_company and product_code = 'operations' and code = 'OPERATIONS_BH' and is_active;
  select id into v_fin from public.user_roles where company_id = v_company and product_code = 'operations' and code = 'OPERATIONS_FINMGR' and is_active;
  select id into v_acc from public.user_roles where company_id = v_company and product_code = 'operations' and code = 'OPERATIONS_ACCOUNTS' and is_active;
  if v_clm is null or v_cm is null or v_aom is null or v_rm is null or v_bh is null or v_fin is null or v_acc is null then
    raise exception 'A required Ops role is missing; nothing changed.';
  end if;

  -- Finance must be able to act on Payment Approvals, or the mandatory
  -- Finance step would find nobody (candidates without edit access are ignored).
  select id into v_page from public.app_pages where company_id = v_company and code = 'payment_approvals';
  if v_page is null then raise exception 'payment_approvals page not found; nothing changed.'; end if;
  insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit, updated_at)
  values (v_company, v_fin, v_page, true, false, true, now()), (v_company, v_acc, v_page, true, false, true, now())
  on conflict (company_id, role_id, page_id) do update
  set can_view = true, can_edit = true, updated_at = now();

  create temporary table ops_heads on commit drop as
  select id from public.payment_heads
  where company_id = v_company and is_active
    and code in ('VAN_ADHOC','ADHOC_DRIVER','ADHOC_DA','VAN_FUEL','OFFICE_STATIONARY','DRINKING_WATER',
                 'VEHICLE_SERVICE','VEHICLE_REPAIR','CEANING_EXP','BROADBAND_CHARGE','ELECTRICITY_BILL');
  select count(*) into v_heads from ops_heads;
  if v_heads <> 11 then raise exception 'Expected 11 Ops payment heads, found %; nothing changed.', v_heads; end if;

  delete from public.payment_head_approval_steps where company_id = v_company and payment_head_id in (select id from ops_heads);

  insert into public.payment_head_approval_steps (company_id, payment_head_id, step_order, candidates, is_required, created_at, updated_at)
  select v_company, h.id, s.step_order, s.candidates, s.is_required, now(), now()
  from ops_heads h
  cross join (values
    (1, jsonb_build_array(jsonb_build_object('role_id', v_clm, 'scope', 'station'),
                          jsonb_build_object('role_id', v_cm,  'scope', 'station'),
                          jsonb_build_object('role_id', v_aom, 'scope', 'station')), false),
    (2, jsonb_build_array(jsonb_build_object('role_id', v_aom, 'scope', 'station'),
                          jsonb_build_object('role_id', v_rm,  'scope', 'station')), false),
    (3, jsonb_build_array(jsonb_build_object('role_id', v_bh,  'scope', 'company')), true),
    (4, jsonb_build_array(jsonb_build_object('role_id', v_fin, 'scope', 'company'),
                          jsonb_build_object('role_id', v_acc, 'scope', 'company')), true)
  ) as s(step_order, candidates, is_required);

  raise notice 'Updated % Ops payment heads to CLM -> AOM -> Business Head -> Finance.', v_heads;
end $$;

commit;

-- Verify (expect 11 heads x 4 steps):
-- select h.code, s.step_order, s.is_required,
--   (select string_agg(ur.code || '/' || (c->>'scope'), ' | ') from jsonb_array_elements(s.candidates) c join public.user_roles ur on ur.id = (c->>'role_id')::uuid) candidates
-- from public.payment_head_approval_steps s join public.payment_heads h on h.id = s.payment_head_id
-- where h.code in ('VAN_ADHOC','ADHOC_DRIVER','ADHOC_DA','VAN_FUEL','OFFICE_STATIONARY','DRINKING_WATER','VEHICLE_SERVICE','VEHICLE_REPAIR','CEANING_EXP','BROADBAND_CHARGE','ELECTRICITY_BILL')
-- order by h.code, s.step_order;
