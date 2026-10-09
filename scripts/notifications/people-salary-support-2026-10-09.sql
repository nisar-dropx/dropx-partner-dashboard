-- User-authorized correction of an existing in-app announcement only.
-- Deploy audience-copy support to DropX One before running this transaction.
-- No new messages, recipient/read-state changes, access changes or payroll writes.
begin;
do $notice$
declare
  announcement_id uuid := '468046d5-1739-4542-9cd9-d01410a7dfcc';
  notice_campaign uuid := '49445e25-4e48-4e09-91c7-9809af7e8608';
  notice_company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  prefix text := E'Salaries have been disbursed based on your attendance and the regularizations completed within the communicated window.\n\nCheck Payments → Salary Calculation for your current breakup and payment status. This is an interim view, not your final salary or payslip. Final salary details will appear in your payslip under Documents once published.\n\nFor this first-month transition only, one additional payout for approved corrections will be processed before 15 October 2026.\n\n';
  cluster_body text;
  city_body text;
  hr_body text;
  rules jsonb;
  affected integer;
  ground_codes jsonb := '["ATL","TL","STM","SSA","PTSSA","HK_P","PC","PTPC","PE","QC","SI","SIC","SM","SRSM"]';
begin
  cluster_body := prefix || 'If the amount credited differs from what you expect, contact your Cluster Manager to review your attendance and complete any required regularization. If unresolved, raise a message in Connect Centre.';
  city_body := prefix || 'If the amount credited differs from what you expect, contact your City Manager or assigned reporting manager to review your attendance and complete any required regularization. If unresolved, raise a message in Connect Centre.';
  hr_body := prefix || 'If the amount credited differs from what you expect, contact HR to review your attendance and complete any required regularization. If unresolved, raise a message in Connect Centre.';
  rules := jsonb_build_object('version', 1, 'fallbackBody', hr_body, 'rules', jsonb_build_array(
    jsonb_build_object('designationCodes', ground_codes, 'locationModelCodes', jsonb_build_array('EDSP','XPT','ODH','MDH'),
      'businessLines', jsonb_build_array('edsp','xpt','odh','mdh'), 'body', cluster_body),
    jsonb_build_object('designationCodes', ground_codes, 'locationModelCodes', jsonb_build_array('NOW'),
      'businessLines', jsonb_build_array('amazon_now'), 'body', city_body)
  ));
  update communication_announcements
    set body=hr_body, updated_at=now(), updated_by='487d09f1-d9b4-4bea-aa2f-c59bb1a9d9ac'
    where id=announcement_id and company_id=notice_company and status='published'
      and expires_at='2026-10-15T18:30:00Z';
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Expected exactly one published salary announcement with the approved expiry'; end if;
  update mob_app_notifications
    set body=hr_body, data=jsonb_set(coalesce(data,'{}'::jsonb),'{audienceCopy}',rules)
    where company_id=notice_company and campaign_id=notice_campaign
      and source_key=announcement_id::text and event_code='communication_announcement'
      and recipient_profile_type in ('employee','contractor');
  get diagnostics affected = row_count;
  if affected <> 372 then raise exception 'Expected 372 existing salary notices, got %; transaction rolled back',affected; end if;
end $notice$;
commit;
