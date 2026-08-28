begin;

alter table public.payment_fields
  add column if not exists provider_calculation_sources jsonb not null default '{}'::jsonb;

update public.payment_fields
set provider_calculation_sources = jsonb_strip_nulls(
  coalesce(provider_calculation_sources, '{}'::jsonb)
  || jsonb_build_object('amazon', calculation_source)
)
where calculation_source is not null
  and not (coalesce(provider_calculation_sources, '{}'::jsonb) ? 'amazon');

alter table public.payment_fields
  drop constraint if exists payment_fields_provider_calculation_sources_check;

alter table public.payment_fields
  add constraint payment_fields_provider_calculation_sources_check check (
    jsonb_typeof(provider_calculation_sources) = 'object'
    and (not (provider_calculation_sources ? 'amazon') or provider_calculation_sources->>'amazon' in (
      'amazon_delivery', 'swa_delivery', 'total_delivery',
      'customer_return', 'seller_pickup', 'seller_return'
    ))
    and (not (provider_calculation_sources ? 'flipkart') or nullif(provider_calculation_sources->>'flipkart', '') is null)
    and (not (provider_calculation_sources ? 'internal') or provider_calculation_sources->>'internal' in (
      'attendance_bonus', 'performance_incentive', 'joining_bonus',
      'referral_incentive', 'manual_adjustment'
    ))
  );

alter table public.payment_fields
  drop constraint if exists payment_fields_calculation_source_required_check;

alter table public.payment_fields
  add constraint payment_fields_calculation_source_required_check check (
    calculation_type = 'manual_input'
    or calculation_source is not null
    or provider_calculation_sources <> '{}'::jsonb
  );

comment on column public.payment_fields.provider_calculation_sources is
  'Provider-specific normalized production sources. Supports Amazon now, Flipkart later, and common internal bonus/incentive sources.';

commit;
