-- Attendance eligibility and reporting-time eligibility may be used separately
-- or together. Rewards may be a fixed cycle bonus or a rate per delivered
-- shipment. All choices remain provider/model/station/designation scoped.

alter table public.workforce_incentive_campaigns
  add column if not exists attendance_required boolean not null default true,
  add column if not exists reporting_time_required boolean not null default true,
  add column if not exists attendance_threshold_type text not null default 'minimum_days',
  add column if not exists maximum_absent_days integer not null default 0,
  add column if not exists attendance_reward_type text not null default 'flat';

alter table public.workforce_incentive_campaigns
  drop constraint if exists workforce_incentive_attendance_values_check,
  drop constraint if exists workforce_incentive_attendance_rule_check;

alter table public.workforce_incentive_campaigns
  add constraint workforce_incentive_attendance_values_check
    check (
      minimum_present_days >= 0
      and allowed_late_days >= 0
      and maximum_absent_days >= 0
      and attendance_threshold_type in ('minimum_days', 'maximum_absent_days')
      and attendance_reward_type in ('flat', 'per_shipment')
    ),
  add constraint workforce_incentive_attendance_rule_check
    check (
      incentive_type <> 'attendance'
      or (
        metric = 'attendance_compliance'
        and calculation_type = 'flat_threshold'
        and cycle_type in ('half_monthly', 'monthly')
        and (attendance_required or reporting_time_required)
        and (
          not attendance_required
          or (attendance_threshold_type = 'minimum_days' and minimum_present_days > 0)
          or attendance_threshold_type = 'maximum_absent_days'
        )
        and (not reporting_time_required or reporting_time is not null)
        and (
          (attendance_reward_type = 'flat' and flat_amount > 0)
          or (attendance_reward_type = 'per_shipment' and rate_value > 0)
        )
      )
    );

comment on column public.workforce_incentive_campaigns.attendance_required is
  'When true, biometric present days must satisfy the configured attendance threshold.';
comment on column public.workforce_incentive_campaigns.reporting_time_required is
  'When true, biometric punch-in cutoff misses must not exceed allowed_late_days.';
comment on column public.workforce_incentive_campaigns.attendance_threshold_type is
  'Attendance target is either an explicit minimum day count or cycle calendar days less allowed absences.';
comment on column public.workforce_incentive_campaigns.maximum_absent_days is
  'Allowed cycle calendar days without a biometric punch when attendance_threshold_type is maximum_absent_days.';
comment on column public.workforce_incentive_campaigns.attendance_reward_type is
  'Qualified cycle reward: flat amount or rate_value multiplied by total delivered shipments.';
