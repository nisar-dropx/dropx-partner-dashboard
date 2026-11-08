create or replace function public.sync_connect_idfy_notifications() returns trigger language plpgsql security invoker set search_path=public as $$
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
 jsonb_build_object('providerId',new.provider_id,'blockId',b,'showOnDashboard',false),new.provider_id||':'||b||':'||o.profile_type,'not_configured'
 from public.connect_idfy_owners o cross join unnest(new.request_block_ids) b
 where o.company_id=new.company_id and o.provider_id=new.provider_id and o.identity_email=lower(trim(new.identity_email))
 on conflict(company_id,event_code,source_key,recipient_account_id) do update
 set archived_at=null,read_at=case when mob_app_notifications.archived_at is not null then null else mob_app_notifications.read_at end,
 created_at=case when mob_app_notifications.archived_at is not null then now() else mob_app_notifications.created_at end;
 end if;
 return new;
end; $$;
