begin;

-- Advance approvals keep the existing shared People mail queue. Finance is a
-- separate daily queue; its delivery policy is independent of legacy roles.
create or replace function public.hr_advance_individual_mail_allowed(p_company uuid,p_request uuid,p_step text)
returns boolean language sql stable set search_path='' as $$
 select not exists (
   select 1 from public.hr_pay_advance_steps s
   where s.company_id=p_company and s.request_id=p_request
     and s.id::text=p_step and s.step_type='finance'
 )
$$;
revoke all on function public.hr_advance_individual_mail_allowed(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.hr_advance_individual_mail_allowed(uuid,uuid,text) to service_role;

-- Wrap the current definition, preserving every other workflow and deployed
-- extension. The marker makes this safe to apply twice.
do $$ declare definition text;
begin
 select pg_get_viewdef('public.hr_pending_manager_approval_emails'::regclass,true) into definition;
 if position('hr_advance_individual_mail_allowed' in definition)=0 then
  execute 'create or replace view public.hr_pending_manager_approval_emails as select advance_mail_source.* from ('
   ||rtrim(definition,E';\n ')||') advance_mail_source where workflow<>''pay_advance'' or public.hr_advance_individual_mail_allowed(company_id,request_id,step_key)';
 end if;
end $$;

-- Close only Finance's old per-request mail leases. Operational manager
-- conversations retain their original subjects, message IDs and due times.
update public.hr_approval_email_threads t set status='closed',lease_token=null,lease_until=null,updated_at=now()
where t.workflow='pay_advance' and t.status='active'
and not public.hr_advance_individual_mail_allowed(t.company_id,t.request_id,t.step_key);

-- Dashboard sends the first message immediately through the same leased queue
-- used by People reminders. Concurrent API/cron calls cannot send two copies.
create or replace function public.hr_claim_initial_advance_email(p_company uuid,p_request uuid)
returns setof public.hr_approval_email_threads language plpgsql set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('hr_approval_email_discovery',0));
 insert into public.hr_approval_email_threads
 (company_id,workflow,request_id,step_key,recipient_user_id,recipient_email,recipient_name,request_label,request_summary)
 select d.company_id,d.workflow,d.request_id,d.step_key,d.approver_user_id,d.recipient_email,
 coalesce(d.recipient_name,''),d.request_label,coalesce(d.request_summary,'')
 from public.hr_pending_manager_approval_emails d
 join public.hr_approval_email_settings s on s.company_id=d.company_id and s.is_enabled and d.workflow=any(s.workflows)
 join public.email_notification_settings e on e.company_id=d.company_id and e.is_enabled
 where d.company_id=p_company and d.request_id=p_request and d.workflow='pay_advance'
 and d.recipient_active and nullif(d.recipient_email,'') is not null
 and public.hr_advance_individual_mail_allowed(d.company_id,d.request_id,d.step_key)
 on conflict(company_id,workflow,request_id,step_key,recipient_user_id,recipient_email) do nothing;

 return query update public.hr_approval_email_threads t
 set lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',updated_at=now()
 where t.id in (
  select q.id from public.hr_approval_email_threads q
  join public.hr_pending_manager_approval_emails d on d.company_id=q.company_id
   and d.workflow=q.workflow and d.request_id=q.request_id and d.step_key=q.step_key
   and d.approver_user_id=q.recipient_user_id and d.recipient_email=q.recipient_email and d.recipient_active
  join public.hr_approval_email_settings s on s.company_id=q.company_id and s.is_enabled and q.workflow=any(s.workflows)
  join public.email_notification_settings e on e.company_id=q.company_id and e.is_enabled
  where q.company_id=p_company and q.request_id=p_request and q.workflow='pay_advance'
  and q.status='active' and q.send_count=0 and q.next_send_at<=now()
  and (q.lease_until is null or q.lease_until<now())
  for update of q skip locked
 ) returning t.*;
end $$;
revoke all on function public.hr_claim_initial_advance_email(uuid,uuid) from public,anon,authenticated;
grant execute on function public.hr_claim_initial_advance_email(uuid,uuid) to service_role;

-- Finance's queue is assigned by the actual approval step, never all holders
-- of a broad legacy FINANCE/OWNER role. Paid/closed requests are not outstanding.
create or replace view public.hr_advance_finance_mail_queue with (security_invoker=true) as
select r.company_id,r.id as request_id,r.request_number,r.worker_name,r.worker_code,
 r.requested_amount,r.approved_amount,r.reason,r.requested_at,r.payment_request_id,
 s.id as step_id,s.approver_user_id,lower(trim(p.email)) as recipient_email,
 p.full_name as recipient_name,st.station_code,
 case when r.status='pending' then 'approval' else 'payment' end as queue_stage,
 greatest(r.requested_at,s.updated_at) as available_at
from public.hr_pay_advance_requests r
join lateral (
 select fs.* from public.hr_pay_advance_steps fs
 where fs.company_id=r.company_id and fs.request_id=r.id and fs.step_type='finance'
 and ((r.status='pending' and fs.status='pending') or (r.status='approved' and fs.status='approved'))
 order by fs.step_order desc limit 1
) s on true
join public.profiles p on p.id=s.approver_user_id and p.company_id=r.company_id and p.is_active
left join public.stations st on st.id=r.location_id and st.company_id=r.company_id
left join public.payment_requests pr on pr.id=r.payment_request_id and pr.company_id=r.company_id
where r.status in ('pending','approved') and r.disbursed_at is null
 and coalesce(lower(pr.status),'') not in ('processed','cancelled','rejected')
 and pr.paid_at is null and pr.processed_at is null
 and nullif(trim(p.email),'') is not null;
revoke all on public.hr_advance_finance_mail_queue from public,anon,authenticated;
grant select on public.hr_advance_finance_mail_queue to service_role;

-- Use the existing durable Ops digest worker. Enable only after its release
-- is verified. Initial insertion derives company/domain from current settings.
insert into public.portal_notification_controls(company_id,portal,event_key,state,subject_template,config)
select s.company_id,'ops','advance_finance_daily','enabled','Advance requests · Finance queue',
jsonb_build_object('delivery_ready',false,'timezone','Asia/Kolkata','schedule_time','17:00',
 'day_offset',0,'first_report_date',(now() at time zone 'Asia/Kolkata')::date,
 'email_domain',split_part(e.smtp_from,'@',2))
from public.hr_approval_email_settings s join public.email_notification_settings e on e.company_id=s.company_id
where s.is_enabled and 'pay_advance'=any(s.workflows) and e.is_enabled
on conflict(company_id,portal,event_key) do nothing;

-- Disable the independent 90-minute Ops timer. People owns all advance reminders.
update public.hr_pay_advance_requests set email_next_reminder_at=null where email_next_reminder_at is not null;
commit;
