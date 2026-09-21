-- Finance needs a traceable gross value, not one opaque purchase number.
alter table public.assets
  add column if not exists gst_rate numeric(5,2),
  add column if not exists gst_amount numeric(14,2),
  add column if not exists total_value numeric(14,2);

alter table public.assets
  drop constraint if exists assets_gst_rate_check,
  drop constraint if exists assets_gst_amount_check,
  drop constraint if exists assets_total_value_check;

alter table public.assets
  add constraint assets_gst_rate_check check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100)),
  add constraint assets_gst_amount_check check (gst_amount is null or gst_amount >= 0),
  add constraint assets_total_value_check check (total_value is null or total_value >= 0);

comment on column public.assets.purchase_value is 'Taxable/base purchase value, excluding GST.';
comment on column public.assets.gst_rate is 'GST percentage recorded from the purchase invoice.';
comment on column public.assets.gst_amount is 'GST amount recorded from the purchase invoice.';
comment on column public.assets.total_value is 'Total landed/purchase invoice value, including GST and other recorded charges.';
