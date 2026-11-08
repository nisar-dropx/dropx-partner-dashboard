-- Changing Amazon delivery access requires a recorded central decision.
alter table public.amazon_da_commands
 add column if not exists reviewed_by uuid,
 add column if not exists reviewer_name text,
 add column if not exists reviewer_role text,
 add column if not exists reviewed_at timestamptz,
 add column if not exists review_decision text,
 add column if not exists review_remarks text;
alter table public.amazon_da_commands drop constraint amazon_da_commands_status_check;
alter table public.amazon_da_commands add constraint amazon_da_commands_status_check
 check(status in ('pending_approval','rejected','queued','checking','sending','confirmed','failed','unconfirmed'));
-- The original expression had escaped literal backslashes, rejecting valid provider IDs.
alter table public.amazon_da_commands drop constraint amazon_da_commands_provider_id_check;
alter table public.amazon_da_commands add constraint amazon_da_commands_provider_id_check
 check(provider_id ~ '^amzn1[.]flex[.]provider[.]v1[.][0-9a-fA-F-]{36}$');
drop index public.amazon_da_commands_one_open;
create unique index amazon_da_commands_one_open on public.amazon_da_commands(company_id,provider_id)
 where status in ('pending_approval','queued','checking','sending','unconfirmed');

-- Read current People assignment first, with active portal roles as an explicit fallback.
-- Invoker/service-only: browser roles cannot query or manufacture an approval.
create or replace function public.amazon_da_reviewer_role(p_company uuid,p_actor uuid) returns text
language sql stable set search_path=public,pg_temp as $$
 with active_user as (select id,role_id from profiles where id=p_actor and company_id=p_company and is_active),
 people_role as (
  select d.name from active_user u join hr_user_person_links l on l.user_id=u.id and l.company_id=p_company and l.status='active'
  join hr_engagements e on e.person_id=l.person_id and e.company_id=p_company and e.status='active'
  join lateral (select w.designation_id from hr_work_assignments w where w.engagement_id=e.id and w.company_id=p_company and w.is_primary
    and w.effective_from <= (now() at time zone 'Asia/Kolkata')::date
    and (w.effective_to is null or w.effective_to >= (now() at time zone 'Asia/Kolkata')::date)
    order by w.effective_from desc,w.id desc limit 1) w on true
  join designations d on d.id=w.designation_id and d.is_active
 ), portal_roles as (
  select r.name from active_user u join company_product_memberships m on m.user_id=u.id and m.company_id=p_company and m.is_active and m.product_code in ('operations','finance')
  join user_roles r on r.id=m.role_id and r.company_id=p_company and r.is_active
  union all select r.name from active_user u join user_roles r on r.id=u.role_id and r.company_id=p_company and r.is_active
 ), eligible as (select name from people_role union all select name from portal_roles)
 select name from eligible where lower(trim(name)) in ('finance manager','finance head','national head','managing partner','operations · national head','finance · national head') limit 1
$$;
revoke all on function public.amazon_da_reviewer_role(uuid,uuid) from public,anon,authenticated;
grant execute on function public.amazon_da_reviewer_role(uuid,uuid) to service_role;

create or replace function public.amazon_da_command_guard() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 if TG_OP='INSERT' then
  if new.status <> (case when new.action='RESEND_INVITATION' then 'queued' else 'pending_approval' end)
    then raise exception 'Delivery-access changes must start awaiting approval'; end if;
  if new.reviewed_by is not null or new.reviewed_at is not null or new.review_decision is not null or new.reviewer_name is not null or new.reviewer_role is not null or new.review_remarks is not null
    then raise exception 'A new request cannot contain an approval'; end if;
  if not exists(select 1 from public.stations s where s.id=new.station_id and s.company_id=new.company_id and s.is_active)
    then raise exception 'Station is outside this company or inactive'; end if;
  if not exists(select 1 from public.profiles p where p.id=new.actor_id and p.company_id=new.company_id and p.is_active)
    then raise exception 'An active company user is required'; end if;
 else
  if (to_jsonb(new)-array['status','result_message','observed_status','updated_at','reviewed_by','reviewer_name','reviewer_role','reviewed_at','review_decision','review_remarks'])
    is distinct from (to_jsonb(old)-array['status','result_message','observed_status','updated_at','reviewed_by','reviewer_name','reviewer_role','reviewed_at','review_decision','review_remarks'])
    then raise exception 'Amazon action identity and request are immutable'; end if;
  if old.status='pending_approval' then
   if new.status not in ('queued','rejected') or public.amazon_da_reviewer_role(new.company_id,new.reviewed_by) is null
     or new.reviewed_at is null or coalesce(length(trim(new.review_remarks)),0) not between 3 and 1000
     or new.review_decision is distinct from (case when new.status='queued' then 'approved' else 'rejected' end)
     then raise exception 'A current authorized reviewer and decision are required'; end if;
   new.reviewed_at=clock_timestamp();
   new.reviewer_role=public.amazon_da_reviewer_role(new.company_id,new.reviewed_by);
   select coalesce(p.full_name,p.email,'User') into new.reviewer_name from public.profiles p where p.id=new.reviewed_by;
  else
   if row(new.reviewed_by,new.reviewer_name,new.reviewer_role,new.reviewed_at,new.review_decision,new.review_remarks)
     is distinct from row(old.reviewed_by,old.reviewer_name,old.reviewer_role,old.reviewed_at,old.review_decision,old.review_remarks)
     then raise exception 'The approval decision is immutable'; end if;
   if not ((old.status='queued' and new.status in ('checking','failed'))
    or (old.status='checking' and new.status in ('sending','failed'))
    or (old.status='sending' and new.status in ('confirmed','failed','unconfirmed'))
    or (old.status='unconfirmed' and new.status='confirmed')) then raise exception 'Invalid Amazon action transition'; end if;
   if new.status in ('checking','sending') and new.action<>'RESEND_INVITATION' and (new.reviewed_by is null or new.review_decision is distinct from 'approved' or public.amazon_da_reviewer_role(new.company_id,new.reviewed_by) is null)
     then raise exception 'Approval is required before Amazon access changes'; end if;
  end if;
 end if;
 new.updated_at=clock_timestamp(); return new;
end $$;
revoke all on function public.amazon_da_command_guard() from public,anon,authenticated;
-- Existing immutable audit events remain; add decision provenance to the event text.
create or replace function public.amazon_da_command_audit() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 insert into public.amazon_da_command_events(command_id,status,message,observed_status)
 values(new.id,new.status,case when TG_OP='UPDATE' and old.status='pending_approval'
   then concat(new.review_decision,' by ',new.reviewer_name,' · ',new.reviewer_role,' · ',new.review_remarks,' · ',new.result_message)
   else new.result_message end,new.observed_status);
 return new;
end $$;
revoke all on function public.amazon_da_command_audit() from public,anon,authenticated;
