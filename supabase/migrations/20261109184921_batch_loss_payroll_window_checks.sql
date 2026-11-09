-- Preserve the deployed recovery gates, history rules, grants and return type.
-- Refuse an unknown function shape rather than overwriting another deployment.
do $migration$
declare
 definition text := pg_get_functiondef('public.nl_loss_recovery_due(uuid,text,text,uuid)'::regprocedure);
 old_block text := $old$), loss_due_open_months as materialized (
   select c.employee_ref,c.salary_month,
     public.loss_recovery_open_payroll(p_company,c.employee_ref,c.salary_month) is_open
   from loss_due_open_month_candidates c
 )$old$;
 new_block text := $new$), loss_due_payroll_windows as materialized (
   -- One scoped lookup replaces one full payroll-window lookup per person/month.
   select w.* from public.loss_recovery_payroll_windows(
     p_company, array(select distinct employee_ref from loss_due_open_month_candidates)
   ) w
 ), loss_due_open_months as materialized (
   select c.employee_ref,c.salary_month,exists (
     select 1 from loss_due_payroll_windows w
     where w.employee_ref=c.employee_ref and w.salary_month=c.salary_month
       and w.payroll_open and (w.payable>0 or w.payable is null)
   ) is_open
   from loss_due_open_month_candidates c
 )$new$;
begin
 if position('loss_due_payroll_windows as materialized' in definition)>0 then return; end if;
 if position(old_block in definition)=0 then
   raise exception 'Unexpected nl_loss_recovery_due definition; review before applying payroll batching';
 end if;
 execute replace(definition,old_block,new_block);
end
$migration$;
