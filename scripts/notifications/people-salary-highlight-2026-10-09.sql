-- Run only after the safe, data-driven presentation renderer is deployed.
-- Updates the existing notice and every personalized variant; no new deliveries.
begin;
do $notice$
declare
  old_text text := 'processed before 15 October 2026';
  new_text text := 'processed on or before 15 October 2026';
  highlighted text := 'For this first-month transition only, one additional payout for approved corrections will be processed on or before 15 October 2026.';
  affected integer;
begin
  update communication_announcements
    set body=replace(body,old_text,new_text),updated_at=now(),updated_by='487d09f1-d9b4-4bea-aa2f-c59bb1a9d9ac'
    where id='468046d5-1739-4542-9cd9-d01410a7dfcc' and company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
      and status='published' and expires_at='2026-10-15T18:30:00Z';
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Expected one live salary notice'; end if;
  update mob_app_notifications
    set body=replace(body,old_text,new_text),
      data=jsonb_set(jsonb_set(replace(data::text,old_text,new_text)::jsonb,'{presentation}',
        jsonb_build_object('emphasis',jsonb_build_array('on or before 15 October 2026'),'callouts',jsonb_build_array(highlighted))),
        '{summary}','"Salary disbursed · Approved corrections on or before 15 October"')
    where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
      and campaign_id='49445e25-4e48-4e09-91c7-9809af7e8608'
      and source_key='468046d5-1739-4542-9cd9-d01410a7dfcc' and event_code='communication_announcement'
      and recipient_profile_type in ('employee','contractor') and data->'audienceCopy'->>'version'='1';
  get diagnostics affected = row_count;
  if affected <> 372 then raise exception 'Expected 372 existing personalized notices, got %',affected; end if;
end $notice$;
commit;
