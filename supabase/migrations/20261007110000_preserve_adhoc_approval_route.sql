-- Reason-specific workflows are owned by the Ad Hoc Reason Master. A general
-- payment-head update must never silently assign one to an unrelated role.
create or replace function public.fleet_guard_adhoc_approval_route()
returns trigger language plpgsql set search_path = '' as $$
declare
 stage jsonb;
 allowed_roles uuid[];
begin
 if jsonb_typeof(new.adhoc_approval_steps) is distinct from 'array' then return new; end if;
 if jsonb_array_length(new.adhoc_approval_steps)=0 then return new; end if;
 if upper(coalesce(new.status,'')) in ('DRAFT','RETURNED','REJECTED','CANCELLED','APPROVED','PROCESSING','PROCESSED')
 or upper(coalesce(new.approval_status,'')) in ('DRAFT','RETURNED','REJECTED','CANCELLED','FINAL_APPROVED','RE_APPROVED','PROCESSING','PROCESSED') then return new; end if;
 select s into stage from jsonb_array_elements(new.adhoc_approval_steps) s
 where (s->>'step_order')::int=coalesce(new.current_step_order,1);
 if stage is null then raise exception 'The approval stage is not in this request''s configured Ad Hoc Reason workflow.'; end if;
 select coalesce(array_agg((c->>'role_id')::uuid),array[]::uuid[]) into allowed_roles
 from jsonb_array_elements(stage->'candidates') c;
 if (new.current_approver_role_id is not null and not(new.current_approver_role_id=any(allowed_roles)))
 or not(coalesce(new.current_approver_role_ids,array[]::uuid[]) <@ allowed_roles)
 or (new.current_approver_user_id is not null and new.current_approver_role_id is null and cardinality(coalesce(new.current_approver_role_ids,array[]::uuid[]))=0) then
  raise exception 'This request follows its Ad Hoc Reason approval workflow. Its approver must belong to the configured stage.';
 end if;
 new.total_steps:=jsonb_array_length(new.adhoc_approval_steps);
 return new;
end $$;
revoke all on function public.fleet_guard_adhoc_approval_route() from public,anon,authenticated;
create trigger zz_fleet_adhoc_approval_route before insert or update of
 current_approver_user_id,current_approver_role_id,current_approver_role_ids,current_step_order,total_steps,adhoc_approval_steps,status,approval_status
 on public.payment_requests for each row execute function public.fleet_guard_adhoc_approval_route();
