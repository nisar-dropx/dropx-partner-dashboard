-- Configure which beneficiary/payment methods requesters may use per payment head.
-- Existing heads retain current behaviour by supporting every method.

alter table public.payment_heads
  add column if not exists supported_payment_modes text[] not null
  default array['account_transfer', 'online_payment', 'upi_payment']::text[];

update public.payment_heads
set supported_payment_modes = array['account_transfer', 'online_payment', 'upi_payment']::text[]
where supported_payment_modes is null or cardinality(supported_payment_modes) = 0;

alter table public.payment_heads
  drop constraint if exists payment_heads_supported_payment_modes_check;

alter table public.payment_heads
  add constraint payment_heads_supported_payment_modes_check check (
    cardinality(supported_payment_modes) > 0
    and supported_payment_modes <@ array['account_transfer', 'online_payment', 'upi_payment']::text[]
  );
