-- DropX One login accounts come from several tables (profiles, employees, and one table per
-- workforce type), so the HRMS device-reset screen can't reliably resolve account_id back to a
-- person. The binding is stamped with what HR needs at bind time instead.
alter table connect_account_devices
  add column if not exists company_id uuid,
  add column if not exists display_name text,
  add column if not exists country_code text,
  add column if not exists mobile_number text,
  add column if not exists device_label text;

create index if not exists connect_account_devices_company_idx
  on connect_account_devices (company_id)
  where reset_at is null;
