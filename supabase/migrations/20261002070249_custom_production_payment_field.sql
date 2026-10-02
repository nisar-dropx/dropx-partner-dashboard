alter table public.payment_fields
  add column if not exists is_custom_production boolean not null default false;

alter table public.payment_fields
  drop constraint if exists payment_fields_custom_production_type_check;

alter table public.payment_fields
  add constraint payment_fields_custom_production_type_check
  check (
    not is_custom_production
    or (
      field_type = 'production'
      and calculation_type = 'count_x_rate'
    )
  );

comment on column public.payment_fields.is_custom_production is
  'True when per-worker production units are supplied independently of provider and operating-model production counts.';

notify pgrst, 'reload schema';
