-- Named-user deletion is tenant-wide, shared by COD and physical audits.
-- Default deny; deployment configuration seeds the approved users separately.
alter table public.ops_audit_programme_settings
  add column if not exists delete_user_ids uuid[] not null default '{}';

create or replace function public.manage_station_audit(p_company_id uuid,p_audit_id uuid,p_operation text,p_expected_updated_at timestamptz,p_assigned_to uuid,p_reason text,p_actor_id uuid,p_actor_name text,p_actor_email text,p_actor_role text)
returns void language plpgsql security invoker set search_path='' as $$
declare v public.ops_station_audits%rowtype; target public.profiles%rowtype; before_value jsonb;
begin
 select * into v from public.ops_station_audits where id=p_audit_id and company_id=p_company_id and deleted_at is null for update;
 if not found then raise exception 'Audit unavailable.'; end if;
 if v.updated_at is distinct from p_expected_updated_at then raise exception 'This audit changed. Refresh and try again.'; end if;
 if coalesce(length(trim(p_reason)),0)=0 or length(p_reason)>500 then raise exception 'Enter a reason up to 500 characters.'; end if;
 before_value=jsonb_build_object('assigned_to',v.assigned_to,'assigned_name',v.assigned_name,'status_code',v.status_code);
 if p_operation='delete' then
  if not exists (
    select 1 from public.profiles p
    join public.ops_audit_programme_settings s on s.company_id=p.company_id
    where p.id=p_actor_id and p.company_id=p_company_id and p.is_active
      and p.id=any(s.delete_user_ids)
      and (p.is_master_owner or exists (
        select 1 from public.company_product_memberships m
        join public.user_roles r on r.id=m.role_id and r.company_id=m.company_id and r.is_active
        where m.company_id=p_company_id and m.user_id=p.id and m.is_active
          and m.product_code='operations'
          and (m.has_all_location_access or r.location_access_mode='all_locations' or v.location_id=any(m.location_scope_ids))
      ))
  ) then raise exception 'Only named authorized users can delete audits.'; end if;
  update public.ops_station_audits set deleted_at=now(),deleted_by=p_actor_id,deletion_reason=trim(p_reason),updated_at=now() where id=v.id;
 elsif p_operation='reassign' then
  if v.started_at is not null or v.status_code<>'scheduled' then raise exception 'Only an unstarted audit can be reassigned.'; end if;
  select * into target from public.profiles where id=p_assigned_to and company_id=p_company_id and is_active;
  if not found then raise exception 'Choose an active auditor.'; end if;
  update public.ops_station_audits set assigned_to=target.id,assigned_name=target.full_name,assigned_email=target.email,assignment_verified=true,updated_at=now() where id=v.id;
 else raise exception 'Unknown audit action.';
 end if;
 insert into public.ops_station_audit_events(company_id,audit_id,event_type,before_data,after_data,actor_user_id,actor_name,actor_email,actor_role)
 values(p_company_id,v.id,case when p_operation='delete' then 'deleted' else 'reassigned' end,before_value,jsonb_build_object('reason',trim(p_reason),'assigned_to',p_assigned_to,'assigned_name',target.full_name),p_actor_id,p_actor_name,p_actor_email,p_actor_role);
end; $$;
revoke all on function public.manage_station_audit(uuid,uuid,text,timestamptz,uuid,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.manage_station_audit(uuid,uuid,text,timestamptz,uuid,text,uuid,text,text,text) to service_role;

