alter table public.fleet_status_report_logs add column if not exists region_key text not null default '__legacy__';
alter table public.fleet_status_report_logs drop constraint if exists fleet_status_report_logs_company_date_recipient_key;
create unique index if not exists fleet_status_report_logs_region_delivery_key on public.fleet_status_report_logs(company_id,report_date,recipient_email,region_key);
create index if not exists fleet_status_report_logs_region_thread_idx on public.fleet_status_report_logs(company_id,recipient_email,region_key,report_month,created_at desc);
comment on column public.fleet_status_report_logs.region_key is 'Location Master region. Separate monthly reply chain and daily delivery claim per recipient and region.';
