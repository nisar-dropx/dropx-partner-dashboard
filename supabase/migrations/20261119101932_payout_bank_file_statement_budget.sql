begin;
alter function public.workforce_create_payout_payment_row_batch_with_disputes(uuid,uuid,uuid,text,uuid,date,date,date,jsonb)
  set statement_timeout = '120s';
alter function public.helper_create_payout_payment_row_batch(uuid,uuid,uuid,text,uuid,date,date,date,jsonb)
  set statement_timeout = '120s';
notify pgrst, 'reload config';
commit;
