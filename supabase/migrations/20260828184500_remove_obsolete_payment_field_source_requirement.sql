-- Provider/model production sources are stored in payment_field_provider_metrics.
-- The payment_fields row must be created or updated before those child rows can
-- be synchronized, so the former same-row source requirement is obsolete.
alter table public.payment_fields
  drop constraint if exists payment_fields_calculation_source_required_check;
