begin;
-- Bank deposit (outcome already_recovered): product label, required screenshot proof, SLP verification unchanged.

update public.nl_recovery_outcomes
   set label = 'Bank deposit',
       attachments_enabled = true,
       restricted = true,
       allocation_required = false,
       deduction_timing = 'none'
 where code = 'already_recovered';

create or replace function public.nl_recovery_receipt_guard() returns trigger
language plpgsql
set search_path = public
as $$
declare
  attachment jsonb;
  attachment_id text;
  attachment_count int := 0;
begin
  if not new.is_deleted and new.outcome_code = 'already_recovered' then
    if coalesce(new.recovery_details->>'received_amount', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
      raise exception 'Enter the full deposited amount.';
    end if;
    if round((new.recovery_details->>'received_amount')::numeric, 2) <> round(new.source_amount, 2) then
      raise exception 'Full recovery must equal the loss amount. Partial collections remain outstanding.';
    end if;
    if length(trim(coalesce(new.recovery_details->>'receipt_reference', ''))) < 5
       or coalesce(new.recovery_details->>'received_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Transaction number and received date are required.';
    end if;
    if (new.recovery_details->>'received_date')::date > (now() at time zone 'Asia/Kolkata')::date then
      raise exception 'Received date cannot be in the future.';
    end if;
    if jsonb_typeof(coalesce(new.recovery_details->'attachments', '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(new.recovery_details->'attachments', '[]'::jsonb)) < 1 then
      raise exception 'Attach a screenshot or proof of the bank deposit for SLP verification.';
    end if;
    for attachment in
      select value from jsonb_array_elements(coalesce(new.recovery_details->'attachments', '[]'::jsonb))
    loop
      attachment_id := nullif(btrim(coalesce(attachment->>'id', '')), '');
      if attachment_id is null then
        raise exception 'Attach a screenshot or proof of the bank deposit for SLP verification.';
      end if;
      if attachment_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        select count(*) into attachment_count
          from public.nl_recovery_attachments f
         where f.company_id = new.company_id
           and f.month = new.month
           and f.case_key = new.case_key
           and f.id = attachment_id::uuid;
      else
        attachment_count := 0;
      end if;
      if attachment_count < 1 then
        raise exception 'Upload the bank deposit screenshot again before saving.';
      end if;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists nl_recovery_receipt_guard on public.nl_loss_recoveries;
create trigger nl_recovery_receipt_guard
  before insert or update of outcome_code, recovery_details, remarks, source_amount, is_deleted
  on public.nl_loss_recoveries
  for each row execute function public.nl_recovery_receipt_guard();

notify pgrst, 'reload schema';
commit;
