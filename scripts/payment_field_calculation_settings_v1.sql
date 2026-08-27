alter table public.payment_fields
  add column if not exists calculation_type text not null default 'manual_input',
  add column if not exists calculation_source text;

alter table public.payment_fields
  drop constraint if exists payment_fields_calculation_type_check;

alter table public.payment_fields
  add constraint payment_fields_calculation_type_check check (
    calculation_type in (
      'manual_input',
      'count_x_rate',
      'fixed_daily',
      'fixed_monthly',
      'percentage',
      'eligibility_bonus'
    )
  );

alter table public.payment_fields
  drop constraint if exists payment_fields_calculation_source_check;

alter table public.payment_fields
  add constraint payment_fields_calculation_source_check check (
    calculation_source is null or calculation_source in (
      'amazon_delivery',
      'swa_delivery',
      'total_delivery',
      'customer_return',
      'mfn_forward',
      'mfn_return',
      'total_activity',
      'attendance_eligibility',
      'performance_metric'
    )
  );

alter table public.payment_fields
  drop constraint if exists payment_fields_calculation_source_required_check;

alter table public.payment_fields
  add constraint payment_fields_calculation_source_required_check check (
    calculation_type in ('manual_input', 'fixed_daily', 'fixed_monthly')
    or calculation_source is not null
  );

comment on column public.payment_fields.calculation_type is
  'Configurable rule used by the payment engine; payment methods do not hard-code shipment columns.';

comment on column public.payment_fields.calculation_source is
  'Normalized daily shipment, attendance, or performance metric consumed by the calculation rule.';

