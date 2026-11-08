-- Identity comes from the invitation/portal link, never a payment or route mapping.
alter table public.amazon_da_detail_snapshots add column request_block_ids text[];
alter table public.amazon_da_detail_snapshots add column requests_checked_at timestamptz;
alter table public.amazon_da_idfy_actions add column actor_profile_type text not null default 'user';
create function public.guard_idfy_actor_type() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if new.actor_profile_type is distinct from old.actor_profile_type then raise exception 'IDfy actor is immutable'; end if;
 return new;
end; $$;
create trigger guard_idfy_actor_type before update on public.amazon_da_idfy_actions for each row execute function public.guard_idfy_actor_type();
revoke all on function public.guard_idfy_actor_type() from public,anon,authenticated;

create view public.connect_idfy_owners with (security_invoker=true) as
with candidates as (
 select w.company_id,w.id owner_id,l.amazon_provider_id provider_id,lower(trim(l.amazon_email)) identity_email,
   w.id account_id,'workforce'::text profile_type
 from public.workforce w join public.workforce_amazon_portal_links l on l.workforce_id=w.id and l.company_id=w.company_id
 where w.deleted_at is null and w.migration_state is distinct from 'reclassified'
 union
 select w.company_id,w.id,l.amazon_provider_id,lower(trim(l.amazon_email)),w.source_profile_id,w.source_profile_type
 from public.workforce w join public.workforce_amazon_portal_links l on l.workforce_id=w.id and l.company_id=w.company_id
 where w.deleted_at is null and w.migration_state is distinct from 'reclassified' and w.source_profile_id is not null and w.source_profile_type is not null
 union
 select c.company_id,c.id,i.external_reference,lower(trim(c.alias_email)),c.id,'workforce'
 from public.workforce_amazon_email_pilot_candidates c
 join public.workforce_amazon_invitation_requests i on i.id=c.invitation_request_id and i.company_id=c.company_id and i.email_pilot_candidate_id=c.id
 where c.closed_at is null and c.inbox_status<>'suspended' and lower(trim(i.amazon_email))=lower(trim(c.alias_email))
), valid as (
 select * from candidates where provider_id ~ '^amzn1\.flex\.provider\.v1\.[0-9a-f-]{36}$' and identity_email<>''
)
select distinct v.company_id,v.owner_id,v.account_id,v.profile_type,v.provider_id,v.identity_email
from valid v where
 (select count(distinct x.owner_id) from valid x where x.company_id=v.company_id and x.provider_id=v.provider_id)=1
 and (select count(distinct x.provider_id) from valid x where x.company_id=v.company_id and x.account_id=v.account_id and x.profile_type=v.profile_type)=1;
revoke all on public.connect_idfy_owners from public,anon,authenticated;
grant select on public.connect_idfy_owners to service_role;

-- A complete, successfully checked source queue controls the notification lifecycle.
create function public.sync_connect_idfy_notifications() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if new.request_block_ids is null then return new; end if;
 update public.mob_app_notifications n set archived_at=coalesce(n.archived_at,now())
 where n.company_id=new.company_id and n.event_code='IDFY_INFORMATION_REQUIRED'
 and n.data->>'providerId'=new.provider_id and n.archived_at is null
 and (not new.enabled or not (n.data->>'blockId'=any(new.request_block_ids)) or not exists (
   select 1 from public.connect_idfy_owners o where o.company_id=new.company_id and o.provider_id=new.provider_id
   and o.identity_email=lower(trim(new.identity_email)) and o.account_id=n.recipient_account_id and o.profile_type=n.recipient_profile_type));
 if new.enabled then
 insert into public.mob_app_notifications(company_id,recipient_profile_type,recipient_account_id,event_code,title,body,route,data,source_key,push_status)
 select new.company_id,o.profile_type,o.account_id,'IDFY_INFORMATION_REQUIRED','Complete your background check',
 'IDfy needs a few details from you. Open to fill only the requested information.','idfy',
 jsonb_build_object('providerId',new.provider_id,'blockId',b,'showOnDashboard',false),new.provider_id||':'||b,'not_configured'
 from public.connect_idfy_owners o cross join unnest(new.request_block_ids) b
 where o.company_id=new.company_id and o.provider_id=new.provider_id and o.identity_email=lower(trim(new.identity_email))
 on conflict(company_id,event_code,source_key,recipient_account_id) do update
 set archived_at=null,read_at=case when mob_app_notifications.archived_at is not null then null else mob_app_notifications.read_at end,
 created_at=case when mob_app_notifications.archived_at is not null then now() else mob_app_notifications.created_at end;
 end if;
 return new;
end; $$;
create trigger sync_connect_idfy_notifications after insert or update of request_block_ids,enabled,identity_email on public.amazon_da_detail_snapshots for each row execute function public.sync_connect_idfy_notifications();
revoke all on function public.sync_connect_idfy_notifications() from public,anon,authenticated;
