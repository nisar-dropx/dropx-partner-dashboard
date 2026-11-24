-- Dark Store Site Summary: associate banner + full active-order rows for Operations pages.

alter table public.ds_site_summary_snapshots
  add column if not exists waiting_for_orders int not null default 0,
  add column if not exists on_break int not null default 0,
  add column if not exists offered_associates int not null default 0,
  add column if not exists picking_associates int not null default 0,
  add column if not exists packing_racking int not null default 0,
  add column if not exists other_activities int not null default 0,
  add column if not exists total_associates int not null default 0;

alter table public.ds_site_summary_orders
  add column if not exists acceptance_seconds numeric(12,2),
  add column if not exists picking_seconds numeric(12,2),
  add column if not exists pack_rack_seconds numeric(12,2),
  add column if not exists total_seconds numeric(12,2),
  add column if not exists acceptance_target_seconds int,
  add column if not exists picking_target_seconds int,
  add column if not exists pack_rack_target_seconds int,
  add column if not exists total_target_seconds int;

comment on column public.ds_site_summary_snapshots.waiting_for_orders is 'Site Summary associate banner: Waiting for Orders';
comment on column public.ds_site_summary_snapshots.total_associates is 'Site Summary associate banner: Total Associates';
comment on column public.ds_site_summary_orders.acceptance_seconds is 'Actual acceptance elapsed seconds (Actual/Target UI)';
