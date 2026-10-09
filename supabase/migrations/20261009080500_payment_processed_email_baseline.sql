-- Do not replay years of historical paid notifications when the station
-- payment lifecycle mailer is first enabled. New payments remain null until
-- their completion email is accepted.
update public.payment_requests
set processed_email_sent_at = coalesce(processed_at, updated_at, now())
where processed_email_sent_at is null
  and (
    upper(coalesce(status, '')) = 'PROCESSED'
    or upper(coalesce(approval_status, '')) = 'PROCESSED'
  );
