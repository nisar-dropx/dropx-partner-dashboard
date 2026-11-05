-- Payment holds do not consume earned salary available for loss recovery.
do $$
declare definition text;
begin
 select pg_get_functiondef('public.loss_recovery_payroll_windows(uuid,text[])'::regprocedure) into definition;
 if position('-case when h.in_net then 0 else h.held end' in definition)>0 then
  definition:=replace(definition,'-case when h.in_net then 0 else h.held end','');
 elsif position('coalesce(p.adjusted_net_pay,p.net_pay,0)' in definition)=0 then
  raise exception 'Unexpected payroll window definition';
 end if;
 definition:=replace(definition,'and b.worker_id=p.worker_id) b','and b.worker_id=p.worker_id and b.worker_type=p.worker_type) b');
 execute definition;
end $$;

-- Called only from server code after station/request access checks. No salary amounts exposed.
create or replace function public.salary_hold_context(p_company uuid,p_refs text[],p_months text[])
returns table(employee_ref text,salary_month text,actor_name text,actor_id text,reason text)
language sql stable set search_path=public as $$
 with runs as (
  select distinct on(r.period_start) r.id,r.period_start
  from hr_payroll_runs r where r.company_id=p_company
   and to_char(r.period_start,'YYYY-MM')=any(p_months)
   and r.period_start=date_trunc('month',r.period_start)::date
   and r.period_end=(r.period_start+interval '1 month -1 day')::date
  order by r.period_start,r.updated_at desc,r.id desc
 ), people as (
  select p.worker_type||':'||p.worker_id ref,to_char(r.period_start,'YYYY-MM') as salary_period,
   coalesce(h.requested_by_name,pr.full_name,pr.email) actor,
   coalesce(h.requested_by_user_id,m.applied_by)::text actor_id,
   coalesce(nullif(i.metadata->>'reason',''),h.reason,hr.name) reason
  from runs r join hr_payroll_run_people p on p.run_id=r.id and p.company_id=p_company
  join hr_payroll_run_items i on i.run_person_id=p.id and i.company_id=p_company
  left join hr_payroll_run_manual_entries m on m.run_id=r.id and m.company_id=p_company
   and m.worker_type=p.worker_type and m.worker_id=p.worker_id
  left join ops_salary_holds h on h.company_id=p_company and h.id::text=i.metadata->>'standing_hold_id'
  left join profiles pr on pr.id=coalesce(h.requested_by_user_id,m.applied_by)
  left join hr_salary_hold_reasons hr on hr.id=m.salary_hold_reason_id and hr.company_id=p_company
  where p.worker_type||':'||p.worker_id=any(p_refs) and i.code='SALARY_HOLD'
   and (i.amount>0 or i.metadata->>'full_month'='true')
 ), standing as (
  select h.worker_type||':'||h.worker_id ref,m.salary_period,h.requested_by_name actor,
    h.requested_by_user_id::text actor_id,h.reason
  from ops_salary_holds h cross join unnest(p_months) m(salary_period)
  left join hr_payroll_runs r on r.id=h.applied_run_id and r.company_id=p_company
  where h.company_id=p_company and h.worker_type||':'||h.worker_id=any(p_refs)
   and h.status in ('pending','cancel_requested','applied','release_requested')
   and (h.applied_run_id is null or to_char(r.period_start,'YYYY-MM')=m.salary_period)
   and not exists(select 1 from people p where p.ref=h.worker_type||':'||h.worker_id and p.salary_period=m.salary_period)
 ), wf as (
  select distinct on(e.workforce_id,e.period_start,e.period_end) e.*
  from workforce_payout_payment_hold_events e where e.company_id=p_company
   and 'workforce:'||e.workforce_id=any(p_refs) and to_char(e.period_start,'YYYY-MM')=any(p_months)
  order by e.workforce_id,e.period_start,e.period_end,e.created_at desc,e.id desc
 )
 select distinct ref,salary_period,actor,actor_id,reason from people
 union select ref,salary_period,actor,actor_id,reason from standing
 union select 'workforce:'||w.workforce_id,to_char(w.period_start,'YYYY-MM'),p.full_name,w.actor_user_id::text,w.remarks
 from wf w left join profiles p on p.id=w.actor_user_id where w.action='hold';
$$;
revoke all on function public.salary_hold_context(uuid,text[],text[]) from public,anon,authenticated;
grant execute on function public.salary_hold_context(uuid,text[],text[]) to service_role;
