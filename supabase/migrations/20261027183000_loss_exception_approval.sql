begin;
-- Only exception plans require independent approval. Eligibility still comes from
-- the writer's source, directory, salary-cap, full-allocation and payroll-lock checks.
do $$ declare f record; d text; patched boolean:=false; begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname='save_nl_recovery' loop
  d:=pg_get_functiondef(f.oid);
  if position('-- Exception-only recovery approval' in d)>0 then patched:=true; continue; end if;
  if position('-- All recovery updates require final approval' in d)=0 then continue; end if;
  d:=regexp_replace(d,'-- All recovery updates require final approval[\s\S]*?  insert into nl_loss_recoveries\(', $patch$-- Exception-only recovery approval
  if o.allocation_required and o.deduction_timing='current_month'
     and v_mode='full' and not v_override
     and c.lifecycle_status not in ('needs_review','returned_to_station','on_hold')
     and coalesce(old.approval_status,'none') not in ('needs_review','returned')
     and not (coalesce(old.approval_note,'') like 'Independent review required%' and old.approval_status='proposed')
     and (old.version is null or old.is_deleted or
          (old.source_amount=c.amount and old.source_status is not distinct from c.source_status))
     and not exists(select 1 from jsonb_array_elements(people) x where not coalesce((x->>'is_active')::boolean,false)
       or exists(select 1 from employees e where 'employee:'||e.id=x->>'ref' and e.company_id=p_company and e.last_working_date <= (now() at time zone 'Asia/Kolkata')::date)
       or exists(select 1 from workforce w where 'workforce:'||w.id=x->>'ref' and w.company_id=p_company and w.last_working_date <= (now() at time zone 'Asia/Kolkata')::date)) then
    v_approval := 'approved';
    next_lifecycle := 'recovery_approved_scheduled';
  else
    v_approval := 'proposed';
    next_lifecycle := 'slp_final_confirmation_pending';
  end if;

  insert into nl_loss_recoveries($patch$);
  d:=replace(d,'case when v_approval=''proposed'' then p_actor else old.proposed_by end','p_actor');
  d:=replace(d,'case when v_approval=''proposed'' then p_name else old.proposed_by_name end','p_name');
  d:=replace(d,'case when v_approval=''proposed'' then now() else old.proposed_at end','now()');
  d:=replace(d,'case when v_approval=''approved'' then old.approved_by else null end','null');
  d:=replace(d,'case when v_approval=''approved'' then old.approved_by_name else null end','case when v_approval=''approved'' then ''Automatic · full recovery'' else null end');
  d:=replace(d,'case when v_approval=''approved'' then old.approved_at else null end','case when v_approval=''approved'' then now() else null end');
  d:=replace(d,'case when v_approval=''proposed'' then '''' else coalesce(old.approval_note,'''') end','case when v_approval=''approved'' then ''Full recovery in the applicable payroll; no exception approval required.'' when c.lifecycle_status in (''needs_review'',''returned_to_station'') or old.approval_status in (''needs_review'',''returned'') or (coalesce(old.approval_note,'''') like ''Independent review required%'' and old.approval_status=''proposed'') or (old.version is not null and not old.is_deleted and (old.source_amount is distinct from c.amount or old.source_status is distinct from c.source_status)) then ''Independent review required after source change or return.'' when o.code=''responsible_left'' then ''Person left: verify recovery follow-up.'' when o.code=''already_recovered'' then ''Verify receipt before closing the balance.'' when v_mode=''installments'' then ''Recovery split across payrolls.'' when o.deduction_timing=''next_month'' then ''Recovery deferred to next payroll.'' when v_override then ''Salary cap override requested.'' else ''Person eligibility requires review.'' end');
  if position('-- Exception-only recovery approval' in d)=0 then raise exception 'Recovery routing patch failed'; end if;
  execute d; patched:=true;
 end loop;
 if not patched then raise exception 'Recovery writer not found'; end if;
end $$;

-- Existing decisions and payroll history are unchanged. New saves use the rule above.

-- Designation-based approvers, with existing location scope unchanged.
insert into role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
select r.company_id,r.id,p.id,true,false,true from user_roles r
join app_pages p on p.company_id=r.company_id and p.code='ops_losses'
where r.is_active and regexp_replace(upper(r.code),'^(OPERATIONS|FINANCE)_','') in
 ('SLPM','SLP_MANAGER','NH','NATIONAL_HEAD','FINMGR','FINANCE_MANAGER','GM','GENERAL_MANAGER','MP','MANAGING_PARTNER')
on conflict(company_id,role_id,page_id) do update set can_view=true,can_edit=true;
commit;
