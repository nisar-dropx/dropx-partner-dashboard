-- Controlled live enablement for DROPX LOGISTICS.
-- Actors: Sujan (OPERATIONS_AOM propose) → Varun (OPERATIONS_SLPM approve).
-- Cases: NL ₹0.56 NLRE; SLP Final ₹132 JDBD (2-month + cap override spot-check).

do $$
declare
  c uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  cm uuid := '16023ab1-7de6-48b6-b651-541d93381f26'; -- sujan
  slp uuid := '886c0b57-83ad-44c8-86a1-4b3346f3482d'; -- varun
  policy_at timestamptz;
  pay_month text := to_char(date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '1 month', 'YYYY-MM');
  nl_ref text := 'workforce:e052bcaa-2c48-4a23-8cf9-beb082c122fb'; -- NLRE CHENNURU SUNIL
  slp_ref text := 'workforce:b2d13043-5c41-4f24-bf2b-f56c47573e4a'; -- JDBD ACHAL DAS
  nl_case text := '630199769121';
  nl_month text := '2026-08';
  slp_case text := 'slp:June-July|02062026_JDBD_51902|2606020280|368262515886';
  slp_month text := '2026-06';
  initial_case text := 'slp:July-Aug|28072026_KDJE_23581|368321615281|368321615281';
  initial_month text := '2026-07';
  nl_ver int;
  slp_ver int;
  nl_lv int;
  slp_lv int;
  due_count int;
  locked_count int;
  initial_err text;
begin
  select updated_at into policy_at from nl_loss_sources where company_id = c;
  if policy_at is null then
    raise exception 'nl_loss_sources missing for DROPX LOGISTICS';
  end if;

  -- Fresh payables for both allocatees (required within 5 minutes of save).
  insert into nl_recovery_payables as p (
    company_id, employee_ref, salary_month, eligible, payable, gross, source, checked_at, policy_updated_at
  ) values
    (c, nl_ref, pay_month, true, 25000, 30000, 'ops-enablement', now(), policy_at),
    (c, slp_ref, pay_month, true, 25000, 30000, 'ops-enablement', now(), policy_at)
  on conflict (company_id, employee_ref, salary_month) do update
    set eligible = excluded.eligible,
        payable = excluded.payable,
        gross = excluded.gross,
        source = excluded.source,
        checked_at = excluded.checked_at,
        policy_updated_at = excluded.policy_updated_at;

  -- A) NL propose (AOM) → approve (SLPM)
  select lifecycle_version into nl_lv
  from nl_loss_month_cases
  where company_id = c and month = nl_month and case_key = nl_case;

  perform save_nl_recovery(
    c, nl_month, nl_case, 0, 'recover', 'custom',
    jsonb_build_array(jsonb_build_object('employee_ref', nl_ref, 'amount', '0.56')),
    'Ops enablement NL live case — full recovery',
    cm, 'SUJAN KUMAR SEAL', '{}'::jsonb, '{"mode":"full"}'::jsonb
  );

  select version into nl_ver
  from nl_loss_recoveries
  where company_id = c and month = nl_month and case_key = nl_case;

  select lifecycle_version into nl_lv
  from nl_loss_month_cases
  where company_id = c and month = nl_month and case_key = nl_case;

  -- Self-approve must fail
  begin
    perform nl_loss_recovery_approve(c, nl_month, nl_case, nl_ver, cm, 'SUJAN KUMAR SEAL', null, nl_lv);
    raise exception 'Expected self-approve rejection for NL case';
  exception when others then
    if sqlerrm not ilike '%another authorised person must approve%' then
      raise;
    end if;
  end;

  perform nl_loss_recovery_approve(
    c, nl_month, nl_case, nl_ver, slp, 'VARUN KUMAR K',
    'Ops enablement SLP approval — NL', nl_lv
  );

  -- B) SLP Final propose → approve with two-month plan + cap override spot-check
  select lifecycle_version into slp_lv
  from nl_loss_month_cases
  where company_id = c and month = slp_month and case_key = slp_case;

  -- Refresh payables again (5-minute freshness)
  update nl_recovery_payables
  set checked_at = now(), policy_updated_at = policy_at, eligible = true, payable = 25000, gross = 30000
  where company_id = c and employee_ref = slp_ref and salary_month = pay_month;

  perform save_nl_recovery(
    c, slp_month, slp_case, 0, 'recover', 'custom',
    jsonb_build_array(jsonb_build_object('employee_ref', slp_ref, 'amount', '132.00')),
    'Ops enablement SLP Final live case — two-month plan',
    cm, 'SUJAN KUMAR SEAL', '{}'::jsonb,
    jsonb_build_object(
      'mode', 'installments',
      'basis', 'months',
      'value', '2',
      'cap_override', true,
      'cap_override_reason', 'Ops enablement spot-check of authorised salary-cap override'
    )
  );

  select version into slp_ver
  from nl_loss_recoveries
  where company_id = c and month = slp_month and case_key = slp_case;

  select lifecycle_version into slp_lv
  from nl_loss_month_cases
  where company_id = c and month = slp_month and case_key = slp_case;

  perform nl_loss_recovery_approve(
    c, slp_month, slp_case, slp_ver, slp, 'VARUN KUMAR K',
    'Ops enablement SLP approval — SLP Final', slp_lv
  );

  -- C) SLP Initial-only must refuse allocation
  begin
    update nl_recovery_payables
    set checked_at = now(), policy_updated_at = policy_at
    where company_id = c and employee_ref = nl_ref and salary_month = pay_month;

    perform save_nl_recovery(
      c, initial_month, initial_case, 0, 'recover', 'custom',
      jsonb_build_array(jsonb_build_object('employee_ref', nl_ref, 'amount', '699.00')),
      'Should fail — SLP Initial only',
      cm, 'SUJAN KUMAR SEAL', '{}'::jsonb, '{"mode":"full"}'::jsonb
    );
    raise exception 'Expected SLP Initial save to be refused';
  exception when others then
    initial_err := sqlerrm;
    if initial_err not ilike '%still in SLP Initial%' and initial_err not ilike '%SLP Initial%' then
      raise exception 'Unexpected Initial-only error: %', initial_err;
    end if;
  end;

  -- Ensure Initial case is not due even if a legacy plan existed
  select count(*) into due_count
  from nl_loss_recovery_due(c, '2026-10', 'hrms') d
  where d.case_key = initial_case;
  if due_count <> 0 then
    raise exception 'Initial-only case unexpectedly due';
  end if;

  -- Force deduction months onto Oct 2026 payroll window for due check (policy start 2026-10)
  update nl_loss_recoveries
  set deduction_month = '2026-10'
  where company_id = c
    and case_key in (nl_case, slp_case);

  select count(*) into due_count
  from nl_loss_recovery_due(c, '2026-10', 'workforce') d
  where d.case_key = nl_case;
  if due_count < 1 then
    raise exception 'NL approved plan not due in 2026-10 workforce draft window';
  end if;

  select count(*) into due_count
  from nl_loss_recovery_due(c, '2026-10', 'workforce') d
  where d.case_key = slp_case;
  if due_count < 1 then
    raise exception 'SLP Final approved plan not due in 2026-10 workforce window';
  end if;

  -- Published-payout lock: none yet before publication
  select count(*) into locked_count
  from nl_recovery_locked_lines(c, nl_month, nl_case);
  if locked_count <> 0 then
    raise exception 'NL plan unexpectedly locked before payout/payroll publication';
  end if;
  select count(*) into locked_count
  from nl_recovery_locked_lines(c, slp_month, slp_case);
  if locked_count <> 0 then
    raise exception 'SLP plan unexpectedly locked before payout/payroll publication';
  end if;

  raise notice 'Ops enablement walkthrough OK (NL + SLP Final + Initial refuse + due + unlock)';
end $$;

-- Verification snapshot
select 'digest_before' as step, state, config->>'delivery_ready' as ready
from portal_notification_controls
where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and event_key='loss_recovery_action_digest';

select 'nl_case' as step, c.lifecycle_status, r.approval_status, r.recovery_mode,
  r.installment_basis, r.installment_value, r.cap_override, r.proposed_by_name, r.approved_by_name,
  r.deduction_month
from nl_loss_month_cases c
join nl_loss_recoveries r using (company_id, month, case_key)
where c.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and c.case_key='630199769121';

select 'slp_case' as step, c.lifecycle_status, r.approval_status, r.recovery_mode,
  r.installment_basis, r.installment_value, r.cap_override, r.cap_override_reason,
  r.proposed_by_name, r.approved_by_name, r.deduction_month
from nl_loss_month_cases c
join nl_loss_recoveries r using (company_id, month, case_key)
where c.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and c.case_key='slp:June-July|02062026_JDBD_51902|2606020280|368262515886';

select 'due_lines' as step, case_key, recovery_key, amount::text, employee_ref, installment_no
from nl_loss_recovery_due('43866344-b550-4e8a-9a2d-9d23f3d8a997','2026-10','workforce')
where case_key in (
  '630199769121',
  'slp:June-July|02062026_JDBD_51902|2606020280|368262515886'
)
order by case_key, installment_no nulls first;
