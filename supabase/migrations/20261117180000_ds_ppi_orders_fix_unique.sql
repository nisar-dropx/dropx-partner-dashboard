-- Fix ds_ppi_orders unique constraint to include business_date
-- The old 3-column constraint prevented re-fetching the same order on a different day.
alter table ds_ppi_orders
  drop constraint if exists ds_ppi_orders_company_id_station_code_procurement_list_id_key;

alter table ds_ppi_orders
  add constraint ds_ppi_orders_unique
  unique (company_id, station_code, business_date, procurement_list_id);
