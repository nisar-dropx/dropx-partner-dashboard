-- Correct Control Tower address confirmed by the user. Preserve historical email evidence.
do $$ declare item record; begin
 for item in select conname from pg_constraint where conrelid='public.cod_daily_exceptions'::regclass and contype='c' and pg_get_constraintdef(oid) like '%cd@dropxlogistics.com%'
 loop execute format('alter table public.cod_daily_exceptions drop constraint %I',item.conname); end loop;
end $$;
-- Never rewrite recipients of an email already sent. Any older record must be corrected by its station.
update public.cod_daily_exceptions set email_check_status='Email not found',email_check_reason='Control Tower CC must be ct@dropxlogistics.com. Correct the recorded email details.',email_message_id=null,email_checked_at=null
 where kind='Banker Not Reported' and not ('ct@dropxlogistics.com'=any(email_cc));
alter table public.cod_daily_exceptions add constraint cod_daily_exception_evidence_check check(coalesce(
 (kind='No Cash' and proof->>'storage_path' is not null and proof->>'storage_bucket'='ops-pulse-documents' and proof->>'storage_path' like company_id::text||'/%') or
 (kind='Banker Not Reported' and length(trim(email_subject)) between 3 and 250 and sender_email is not null and email_sent_at is not null and cardinality(stakeholder_emails)>0 and cardinality(client_poc_emails)>0 and 'ct@dropxlogistics.com'=any(email_cc)),false)) not valid;
