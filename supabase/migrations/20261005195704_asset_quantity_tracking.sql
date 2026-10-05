alter table public.assets
  add column if not exists tracking_mode text not null default 'individual',
  add column if not exists quantity_total integer not null default 1,
  add column if not exists quantity_working integer not null default 1,
  add column if not exists quantity_faulty integer not null default 0;

update public.assets
set
  tracking_mode = 'individual',
  quantity_total = 1,
  quantity_working = case when condition in ('damaged', 'unusable') then 0 else 1 end,
  quantity_faulty = case when condition in ('damaged', 'unusable') then 1 else 0 end
where tracking_mode = 'individual';

alter table public.assets
  drop constraint if exists assets_tracking_mode_check,
  drop constraint if exists assets_quantity_total_check,
  drop constraint if exists assets_quantity_working_check,
  drop constraint if exists assets_quantity_faulty_check,
  drop constraint if exists assets_quantity_balance_check,
  drop constraint if exists assets_individual_quantity_check;

alter table public.assets
  add constraint assets_tracking_mode_check
    check (tracking_mode in ('individual', 'quantity')),
  add constraint assets_quantity_total_check
    check (quantity_total >= 1),
  add constraint assets_quantity_working_check
    check (quantity_working >= 0),
  add constraint assets_quantity_faulty_check
    check (quantity_faulty >= 0),
  add constraint assets_quantity_balance_check
    check (quantity_working + quantity_faulty = quantity_total),
  add constraint assets_individual_quantity_check
    check (tracking_mode = 'quantity' or quantity_total = 1);

comment on column public.assets.tracking_mode is
  'individual creates one register record per physical asset; quantity represents one homogeneous asset group under one register code';
comment on column public.assets.quantity_total is
  'Total physical units represented by this asset register record';
comment on column public.assets.quantity_working is
  'Physical units currently working or usable';
comment on column public.assets.quantity_faulty is
  'Physical units currently faulty, damaged, or not working';
