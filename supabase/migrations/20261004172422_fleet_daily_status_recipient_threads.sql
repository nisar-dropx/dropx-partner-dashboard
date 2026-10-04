-- Deliver one station-scoped Fleet status message per recipient and keep a
-- separate reply chain for each recipient in each calendar month.

alter table public.fleet_status_report_logs
  add column if not exists recipient_email text;

update public.fleet_status_report_logs
set recipient_email = coalesce(nullif(lower(recipients[1]), ''), '__legacy__')
where recipient_email is null;

alter table public.fleet_status_report_logs
  alter column recipient_email set default '__company__',
  alter column recipient_email set not null;

alter table public.fleet_status_report_logs
  drop constraint if exists fleet_status_report_logs_company_id_report_date_key;

alter table public.fleet_status_report_logs
  drop constraint if exists fleet_status_report_logs_company_date_recipient_key;

alter table public.fleet_status_report_logs
  add constraint fleet_status_report_logs_company_date_recipient_key
  unique (company_id, report_date, recipient_email);

create index if not exists fleet_status_report_logs_recipient_month_idx
  on public.fleet_status_report_logs(company_id, recipient_email, report_month, created_at desc);

alter table public.fleet_control_settings
  alter column daily_status_send_time set default '20:00:00';

update public.fleet_control_settings
set daily_status_send_time = '20:00:00',
    daily_status_email_config = jsonb_set(
      coalesce(daily_status_email_config, '{}'::jsonb),
      '{monthlyThread}',
      'true'::jsonb,
      true
    ),
    updated_at = now();

comment on column public.fleet_status_report_logs.recipient_email is
  'Recipient-specific delivery key used to maintain one Fleet status thread per recipient per calendar month.';
