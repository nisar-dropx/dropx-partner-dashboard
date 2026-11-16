-- Dark Store PPI tracking + Amazon inbound shipment reconciliation
-- ================================================================

-- Store config: maps our station_code (TZC4) to Amazon warehouse/store IDs
create table if not exists ds_store_config (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references auth.users on delete cascade,
  station_id      uuid references stations(id),
  station_code    text not null,          -- e.g. TZC4
  amazon_store_id text not null,          -- e.g. DU-AA-533
  warehouse_id    text not null,          -- e.g. TZC4 (same as station_code for HDNI)
  store_family    text not null default 'HDNI',
  region_code     text not null,          -- e.g. eu-south-2  (for associate audit subdomain)
  store_type      text not null default 'KISAN', -- for GroceryCentral: KISAN / HDNI
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, station_code)
);

-- Daily PPI summary per store per picker
create table if not exists ds_ppi_daily (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  station_id      uuid references stations(id),
  station_code    text not null,
  business_date   date not null,
  username        text not null,
  order_count     int  not null default 0,
  unit_count      int  not null default 0,
  total_ppt_ms    bigint not null default 0,  -- sum of PPT in milliseconds
  avg_ppt_seconds numeric(10,2),
  fetched_at      timestamptz not null default now(),
  unique (company_id, station_code, business_date, username)
);

-- Hourly PPI breakdown
create table if not exists ds_ppi_hourly (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  station_id      uuid references stations(id),
  station_code    text not null,
  business_date   date not null,
  hour            smallint not null check (hour between 0 and 23),
  order_count     int  not null default 0,
  unit_count      int  not null default 0,
  total_ppt_ms    bigint not null default 0,
  avg_ppt_seconds numeric(10,2),
  fetched_at      timestamptz not null default now(),
  unique (company_id, station_code, business_date, hour)
);

-- Per-order PPT detail
create table if not exists ds_ppi_orders (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  station_id           uuid references stations(id),
  station_code         text not null,
  business_date        date not null,
  procurement_list_id  text not null,   -- ProcurementListId UUID from AssociateAudit
  username             text not null,   -- picker who completed
  completed_at         timestamptz not null,
  unit_count           int not null default 0,
  ppt_seconds          numeric(10,2),
  fetched_at           timestamptz not null default now(),
  unique (company_id, station_code, procurement_list_id)
);

-- Amazon inbound shipments (GroceryCentral)
create table if not exists ds_inbound_shipments (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null,
  station_id              uuid references stations(id),
  station_code            text not null,
  amazon_shipment_ref_id  text not null,
  source_warehouse_id     text,
  departure_time          timestamptz,
  estimated_arrival_time  timestamptz,
  receive_time            timestamptz,
  total_units             int,
  pallet_count            int,
  pct_completion          numeric(5,2),
  has_overage             boolean default false,
  status                  text,          -- pending / in_transit / received / complete
  fetched_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (company_id, amazon_shipment_ref_id)
);

-- Per-ASIN reconciliation within each shipment
create table if not exists ds_inbound_reconciliation (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null,
  shipment_id             uuid not null references ds_inbound_shipments(id) on delete cascade,
  station_code            text not null,
  tote_id                 text,
  asin                    text not null,
  fc_sku                  text,
  fn_sku                  text,
  product_title           text,
  expected_qty            int not null default 0,
  received_qty            int not null default 0,
  reconcile_pending_qty   int generated always as (expected_qty - received_qty) stored,
  stow_pending_qty        int not null default 0,
  fetched_at              timestamptz not null default now(),
  unique (company_id, shipment_id, asin, fc_sku)
);

-- Fetch run log (audit trail per store per day)
create table if not exists ds_fetch_runs (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  station_code    text not null,
  run_type        text not null,  -- ppi / inbound
  business_date   date,
  status          text not null,  -- ok / error / partial
  error_message   text,
  rows_fetched    int,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);

-- Indexes
create index if not exists ds_ppi_daily_lookup     on ds_ppi_daily     (company_id, station_code, business_date);
create index if not exists ds_ppi_hourly_lookup    on ds_ppi_hourly    (company_id, station_code, business_date);
create index if not exists ds_ppi_orders_lookup    on ds_ppi_orders    (company_id, station_code, business_date);
create index if not exists ds_inbound_lookup       on ds_inbound_shipments (company_id, station_code);
create index if not exists ds_recon_shipment       on ds_inbound_reconciliation (shipment_id);
create index if not exists ds_fetch_runs_lookup    on ds_fetch_runs    (company_id, station_code, run_type, started_at desc);
