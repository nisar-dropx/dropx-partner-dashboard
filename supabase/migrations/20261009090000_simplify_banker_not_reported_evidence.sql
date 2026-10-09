-- Stations record an email that was already sent. The Control Tower mailbox can
-- confirm it using sender, subject, sent time and the mandatory CC; asking a
-- station user to retype every recipient adds no verification value.
alter table public.cod_daily_exceptions
  drop constraint if exists cod_daily_exception_evidence_check;

alter table public.cod_daily_exceptions
  add constraint cod_daily_exception_evidence_check check(coalesce(
    (kind='No Cash'
      and proof->>'storage_path' is not null
      and proof->>'storage_bucket'='ops-pulse-documents'
      and proof->>'storage_path' like company_id::text||'/%')
    or
    (kind='Banker Not Reported'
      and length(trim(email_subject)) between 3 and 250
      and sender_email is not null
      and email_sent_at is not null
      and 'ct@dropxlogistics.com'=any(email_cc)),
    false
  )) not valid;
