-- Reports follow the entered deployment date, not the UTC date of request creation.
create or replace function public.sync_adhoc_deployment_work_date()
returns trigger language plpgsql security invoker set search_path = public as $$
declare deployment date;
begin
 if not exists(select 1 from public.payment_head_questions q join public.payment_heads h on h.id=q.payment_head_id and h.company_id=q.company_id
   where q.id=new.question_id and q.company_id=new.company_id and lower(trim(q.question_text))='deployment date' and h.code like '%ADHOC%') then return new; end if;
 if coalesce(new.answer_value,'') !~ '^\d{4}-\d{2}-\d{2}$' then return new; end if;
 begin deployment := new.answer_value::date; exception when others then return new; end;
 update public.payment_requests set work_date=deployment,
 details=coalesce(details,'{}'::jsonb)||jsonb_build_object('deployment_date_alignment',jsonb_build_object('previous_work_date',work_date,'deployment_date',deployment,'source','Saved Deployment Date answer','at',now()))
 where id=new.payment_request_id and company_id=new.company_id and work_date is distinct from deployment;
 return new;
end; $$;
revoke all on function public.sync_adhoc_deployment_work_date() from public,anon,authenticated;
drop trigger if exists sync_adhoc_deployment_work_date on public.payment_request_answers;
create trigger sync_adhoc_deployment_work_date after insert or update of answer_value on public.payment_request_answers
for each row execute function public.sync_adhoc_deployment_work_date();
-- Align only this month's unsubmitted actuals. Preserve completed financial history.
update public.payment_request_answers a set answer_value=a.answer_value
from public.payment_requests r,public.payment_head_questions q,public.payment_heads h
where a.payment_request_id=r.id and a.company_id=r.company_id and q.id=a.question_id and q.company_id=r.company_id and h.id=q.payment_head_id and h.company_id=r.company_id
and lower(trim(q.question_text))='deployment date' and h.code like '%ADHOC%' and r.amount is null
and a.answer_value >= to_char(date_trunc('month',now() at time zone 'Asia/Kolkata'),'YYYY-MM-DD')
and a.answer_value <= to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD') and a.answer_value<>r.work_date::text;
