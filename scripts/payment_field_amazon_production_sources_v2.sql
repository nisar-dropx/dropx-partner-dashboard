begin;

alter table public.payment_fields
  drop constraint if exists payment_fields_calculation_source_check;

alter table public.payment_fields
  add constraint payment_fields_calculation_source_check
    check (calculation_source is null or calculation_source in (
      'amazon_delivery', 'swa_delivery', 'total_delivery',
      'customer_return', 'seller_pickup', 'seller_return'
    ));

commit;
