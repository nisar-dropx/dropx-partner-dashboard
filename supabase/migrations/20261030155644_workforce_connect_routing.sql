-- Existing cases stay in place, preserving references, attachments and history.
-- Only service-side portal adapters may read these security-invoker views.
create or replace view public.people_connect_cases with (security_invoker=true) as
select c.* from public.communication_cases c
join public.communication_case_reporters r on r.case_id=c.id and r.company_id=c.company_id
where r.reporter_profile_type in ('employee','contractor');

create or replace view public.workforce_connect_cases with (security_invoker=true) as
select c.*,
  case when c.identity_protected or c.channel='integrity' then null else coalesce(w.location_id,h.location_id,v.location_id) end as location_id,
  case when c.identity_protected or c.channel='integrity' then 'Confidential reporter' else coalesce(w.full_name,h.full_name,v.full_name,'Workforce associate') end as reporter_name,
  case when c.identity_protected or c.channel='integrity' then null else coalesce(w.dropx_id,h.dropx_id,v.dropx_id) end as reporter_code,
  case when c.identity_protected or c.channel='integrity' then null else coalesce(w.designation,h.designation,v.designation) end as reporter_designation
from public.communication_cases c
join public.communication_case_reporters r on r.case_id=c.id and r.company_id=c.company_id
left join public.workforce w on r.reporter_profile_type in ('workforce','field_executive') and w.id=r.reporter_account_id and w.company_id=c.company_id
left join public.helpers h on r.reporter_profile_type='worker' and h.id=r.reporter_account_id and h.company_id=c.company_id
left join public.vendors v on r.reporter_profile_type='vendor' and v.id=r.reporter_account_id and v.company_id=c.company_id
where r.reporter_profile_type in ('workforce','field_executive','worker','vendor');

create or replace view public.people_scoped_web_notifications with (security_invoker=true) as
select n.* from public.people_web_notifications n
where n.event_code not like 'communication_case_%'
  or exists (select 1 from public.communication_case_reporters r
    where r.company_id=n.company_id and r.case_id::text=n.data->>'caseId'
      and r.reporter_profile_type in ('employee','contractor'));

revoke all on public.people_connect_cases,public.workforce_connect_cases,public.people_scoped_web_notifications from public,anon,authenticated;
grant select on public.people_connect_cases,public.workforce_connect_cases,public.people_scoped_web_notifications to service_role;

-- A reply and its notification are a single transaction. Portal classification
-- is checked again here, even if a forged case ID reaches a server action.
create or replace function public.send_scoped_communication_reply(
  p_company_id uuid,p_case_id uuid,p_actor_id uuid,p_message text,p_workspace text
) returns uuid language plpgsql security definer set search_path='' as $$
declare c public.communication_cases%rowtype; r public.communication_case_reporters%rowtype;
  message_id uuid; notification_id uuid; next_status text;
begin
  if p_workspace is null or p_workspace not in ('people','workforce') then raise exception 'Invalid portal.'; end if;
  if p_message is null or length(trim(p_message)) not between 2 and 3000 then raise exception 'Enter a message between 2 and 3000 characters.'; end if;
  select * into c from public.communication_cases where id=p_case_id and company_id=p_company_id for update;
  if not found then raise exception 'Conversation unavailable.'; end if;
  select * into r from public.communication_case_reporters where case_id=c.id and company_id=c.company_id;
  if not found or not ((p_workspace='people' and r.reporter_profile_type in ('employee','contractor'))
    or (p_workspace='workforce' and r.reporter_profile_type in ('workforce','field_executive','worker','vendor'))) then raise exception 'Conversation unavailable in this portal.'; end if;
  if c.status in ('closed','dismissed') then raise exception 'Reopen this conversation before replying.'; end if;
  if not exists (select 1 from public.profiles where id=p_actor_id and company_id=p_company_id and is_active) then raise exception 'Actor unavailable.'; end if;
  next_status := case when c.status='submitted' then 'acknowledged' else c.status end;
  insert into public.communication_case_messages(case_id,company_id,author_kind,visibility,body,actor_profile_id)
    values(c.id,c.company_id,'committee','reporter',trim(p_message),p_actor_id) returning id into message_id;
  insert into public.mob_app_notifications(company_id,recipient_profile_type,recipient_account_id,event_code,source_key,title,body,route,data,push_status)
    values(c.company_id,r.reporter_profile_type,r.reporter_account_id,'communication_case_update',c.id::text||':'||message_id::text,
      case when p_workspace='workforce' then 'New reply from Workforce Support' else 'New reply from People & Culture' end,
      c.case_number||' has a new reply. Open Connect to read and respond.','communication_center',
      jsonb_build_object('caseId',c.id,'messageId',message_id,'caseNumber',c.case_number,'status',next_status),'not_configured') returning id into notification_id;
  update public.communication_cases set status=next_status,acknowledged_at=case when c.status='submitted' then now() else acknowledged_at end,
    assigned_profile_id=coalesce(assigned_profile_id,p_actor_id),last_activity_at=now(),updated_at=now() where id=c.id;
  insert into public.communication_case_events(case_id,company_id,event_type,from_status,to_status,actor_profile_id)
    values(c.id,c.company_id,'reply_sent',c.status,next_status,p_actor_id);
  return notification_id;
end $$;
create or replace function public.send_communication_case_reply(p_company_id uuid,p_case_id uuid,p_actor_id uuid,p_message text)
returns uuid language sql security invoker set search_path='' as $$
  select public.send_scoped_communication_reply(p_company_id,p_case_id,p_actor_id,p_message,'people');
$$;
create or replace function public.send_workforce_communication_reply(p_company_id uuid,p_case_id uuid,p_actor_id uuid,p_message text)
returns uuid language sql security invoker set search_path='' as $$
  select public.send_scoped_communication_reply(p_company_id,p_case_id,p_actor_id,p_message,'workforce');
$$;
revoke all on function public.send_scoped_communication_reply(uuid,uuid,uuid,text,text),public.send_communication_case_reply(uuid,uuid,uuid,text),public.send_workforce_communication_reply(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.send_scoped_communication_reply(uuid,uuid,uuid,text,text),public.send_communication_case_reply(uuid,uuid,uuid,text),public.send_workforce_communication_reply(uuid,uuid,uuid,text) to service_role;

create or replace function public.manage_workforce_communication_case(
  p_company_id uuid,p_case_id uuid,p_actor_id uuid,p_intent text,p_value text
) returns uuid language plpgsql security definer set search_path='' as $$
declare c public.communication_cases%rowtype; r public.communication_case_reporters%rowtype;
  notification_id uuid; event_name text;
begin
  select * into c from public.communication_cases where id=p_case_id and company_id=p_company_id for update;
  if not found then raise exception 'Conversation unavailable.'; end if;
  select * into r from public.communication_case_reporters where case_id=c.id and company_id=c.company_id
    and reporter_profile_type in ('workforce','field_executive','worker','vendor');
  if not found then raise exception 'Conversation unavailable in this portal.'; end if;
  if not exists(select 1 from public.profiles where id=p_actor_id and company_id=p_company_id and is_active) then raise exception 'Actor unavailable.'; end if;
  if p_intent='assign' then
    update public.communication_cases set assigned_profile_id=p_actor_id,updated_at=now() where id=c.id;
    event_name:='assigned';
  elsif p_intent='note' then
    if p_value is null or length(trim(p_value)) not between 2 and 3000 then raise exception 'Enter a note between 2 and 3000 characters.'; end if;
    insert into public.communication_case_messages(case_id,company_id,author_kind,visibility,body,actor_profile_id)
      values(c.id,c.company_id,'committee','internal',trim(p_value),p_actor_id);
    event_name:='internal_note_added';
  elsif p_intent='status' then
    if p_value is null or p_value not in ('submitted','acknowledged','in_review','action_required','resolved','closed','dismissed') then raise exception 'Invalid status.'; end if;
    update public.communication_cases set status=p_value,
      acknowledged_at=case when p_value='acknowledged' then coalesce(acknowledged_at,now()) else acknowledged_at end,
      resolved_at=case when p_value in ('resolved','closed','dismissed') then now() else null end,
      last_activity_at=now(),updated_at=now() where id=c.id;
    event_name:='status_changed';
    insert into public.mob_app_notifications(company_id,recipient_profile_type,recipient_account_id,event_code,source_key,title,body,route,data,push_status)
      values(c.company_id,r.reporter_profile_type,r.reporter_account_id,'communication_case_update',c.id::text||':status:'||gen_random_uuid()::text,
        'Workforce Connect case updated',c.case_number||' is now '||replace(p_value,'_',' ')||'. Open Connect for details.',
        'communication_center',jsonb_build_object('caseId',c.id,'caseNumber',c.case_number,'status',p_value),'not_configured') returning id into notification_id;
  else raise exception 'Invalid action.';
  end if;
  insert into public.communication_case_events(case_id,company_id,event_type,from_status,to_status,actor_profile_id)
    values(c.id,c.company_id,event_name,c.status,case when p_intent='status' then p_value else c.status end,p_actor_id);
  return notification_id;
end $$;
revoke all on function public.manage_workforce_communication_case(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.manage_workforce_communication_case(uuid,uuid,uuid,text,text) to service_role;
notify pgrst,'reload schema';
