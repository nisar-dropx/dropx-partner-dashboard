begin;

alter table public.whatsapp_message_logs
  drop constraint if exists whatsapp_message_logs_status_check;

alter table public.whatsapp_message_logs
  add constraint whatsapp_message_logs_status_check
  check (status in ('sent', 'delivered', 'read', 'failed', 'skipped'));

comment on column public.whatsapp_message_logs.status is
  'Latest provider delivery state. Payout notification history reads sent, delivered, read, failed, and skipped states from this audit row.';

commit;
