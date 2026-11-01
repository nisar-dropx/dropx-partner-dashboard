-- Configurable reporting-time and attendance bonus rules. These rules use
-- actual biometric punch-ins only; shipment-derived or aggregate attendance
-- cannot satisfy a reporting-time incentive.

alter table public.workforce_incentive_campaigns
  add column if not exists reporting_time time,
  add column if not exists minimum_present_days integer not null default 0,
  add column if not exists allowed_late_days integer not null default 0;

alter table public.workforce_incentive_campaigns
  drop constraint if exists workforce_incentive_type_check,
  drop constraint if exists workforce_incentive_metric_check,
  drop constraint if exists workforce_incentive_attendance_values_check,
  drop constraint if exists workforce_incentive_attendance_rule_check;

alter table public.workforce_incentive_campaigns
  add constraint workforce_incentive_type_check
    check (incentive_type in ('conversion', 'performance', 'attendance')),
  add constraint workforce_incentive_metric_check
    check (metric in ('delivery_conversion', 'total_delivery', 'total_activity', 'amazon_delivery', 'swa_delivery', 'c_return', 'mfn', 'attendance_compliance')),
  add constraint workforce_incentive_attendance_values_check
    check (minimum_present_days >= 0 and allowed_late_days >= 0),
  add constraint workforce_incentive_attendance_rule_check
    check (
      incentive_type <> 'attendance'
      or (
        metric = 'attendance_compliance'
        and calculation_type = 'flat_threshold'
        and cycle_type in ('half_monthly', 'monthly')
        and reporting_time is not null
        and minimum_present_days > 0
        and flat_amount > 0
      )
    );

comment on column public.workforce_incentive_campaigns.reporting_time is
  'Latest allowed biometric punch-in time in Asia/Kolkata for attendance incentive eligibility.';
comment on column public.workforce_incentive_campaigns.minimum_present_days is
  'Minimum distinct days with an actual biometric in_time required in the incentive cycle.';
comment on column public.workforce_incentive_campaigns.allowed_late_days is
  'Maximum distinct biometric punch-in days later than reporting_time allowed in the incentive cycle.';
