begin;

create table if not exists public.mob_app_notification_campaigns (
  id uuid primary key,
  company_id uuid not null,
  event_code text not null,
  campaign_code text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint mob_app_notification_campaigns_event_code_check
    check (nullif(btrim(event_code), '') is not null),
  constraint mob_app_notification_campaigns_company_id_unique
    unique (company_id, id),
  constraint mob_app_notification_campaigns_company_code_unique
    unique (company_id, campaign_code)
);

comment on table public.mob_app_notification_campaigns is
  'Tenant-scoped App notification batches. One payout publication click creates one campaign regardless of recipient count.';

alter table public.mob_app_notification_campaigns enable row level security;
alter table public.mob_app_notification_campaigns force row level security;
revoke all on table public.mob_app_notification_campaigns from public, anon, authenticated;
grant select, insert, update on table public.mob_app_notification_campaigns to service_role;

drop policy if exists service_role_mob_app_notification_campaigns_all
  on public.mob_app_notification_campaigns;
create policy service_role_mob_app_notification_campaigns_all
  on public.mob_app_notification_campaigns
  for all
  to service_role
  using (true)
  with check (true);

alter table public.mob_app_notifications
  add column if not exists campaign_id uuid;

-- Existing payout notifications were created in one database transaction per
-- Send Notification click. now() is transaction-stable, so identical tenant,
-- actor and timestamp values safely reconstruct their original batches.
with payout_groups as (
  select
    (
      pg_catalog.md5(
        notification.company_id::text || ':' ||
        notification.created_at::text || ':' ||
        coalesce(notification.created_by::text, 'system') || ':' ||
        notification.event_code
      )
    )::uuid as id,
    notification.company_id,
    notification.event_code,
    'APP-PAYOUT-' || upper(pg_catalog.md5(
      notification.company_id::text || ':' ||
      notification.created_at::text || ':' ||
      coalesce(notification.created_by::text, 'system') || ':' ||
      notification.event_code
    )) as campaign_code,
    notification.created_by,
    notification.created_at
  from public.mob_app_notifications notification
  where notification.event_code = 'workforce_payout_review'
    and notification.campaign_id is null
  group by
    notification.company_id,
    notification.event_code,
    notification.created_by,
    notification.created_at
)
insert into public.mob_app_notification_campaigns (
  id, company_id, event_code, campaign_code, created_by, created_at
)
select id, company_id, event_code, campaign_code, created_by, created_at
from payout_groups
on conflict (id) do nothing;

with payout_groups as (
  select
    (
      pg_catalog.md5(
        notification.company_id::text || ':' ||
        notification.created_at::text || ':' ||
        coalesce(notification.created_by::text, 'system') || ':' ||
        notification.event_code
      )
    )::uuid as id,
    notification.company_id,
    notification.event_code,
    notification.created_by,
    notification.created_at
  from public.mob_app_notifications notification
  where notification.event_code = 'workforce_payout_review'
    and notification.campaign_id is null
  group by
    notification.company_id,
    notification.event_code,
    notification.created_by,
    notification.created_at
)
update public.mob_app_notifications notification
set
  campaign_id = payout_group.id,
  data = coalesce(notification.data, '{}'::jsonb) || pg_catalog.jsonb_build_object(
    'batchId', payout_group.id::text,
    'campaignCode', 'APP-PAYOUT-' || upper(replace(payout_group.id::text, '-', ''))
  )
from payout_groups payout_group
where notification.company_id = payout_group.company_id
  and notification.event_code = payout_group.event_code
  and notification.created_at = payout_group.created_at
  and notification.created_by is not distinct from payout_group.created_by
  and notification.campaign_id is null;

-- Keep the recipient label as it was when the campaign was created. This also
-- lets history remain useful after a Workforce profile is renamed or removed.
update public.mob_app_notifications notification
set data = coalesce(notification.data, '{}'::jsonb) || pg_catalog.jsonb_build_object(
  'dropxId', coalesce(nullif(notification.data ->> 'dropxId', ''), workforce.dropx_id, ''),
  'dropxName', coalesce(nullif(notification.data ->> 'dropxName', ''), workforce.full_name, 'Workforce account')
)
from public.workforce workforce
where notification.event_code = 'workforce_payout_review'
  and notification.recipient_profile_type = 'workforce'
  and workforce.company_id = notification.company_id
  and workforce.id = notification.recipient_account_id;

alter table public.mob_app_notifications
  drop constraint if exists mob_app_notifications_campaign_id_fkey;
alter table public.mob_app_notifications
  add constraint mob_app_notifications_campaign_id_fkey
  foreign key (company_id, campaign_id)
  references public.mob_app_notification_campaigns(company_id, id)
  on delete restrict;

create index if not exists mob_app_notification_campaigns_company_created_idx
  on public.mob_app_notification_campaigns (company_id, event_code, created_at desc);
create index if not exists mob_app_notifications_campaign_idx
  on public.mob_app_notifications (campaign_id, created_at, id)
  where campaign_id is not null;

create or replace function public.mob_app_assign_payout_campaign()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  batch_id uuid;
  batch_code text;
  recipient_dropx_id text;
  recipient_name text;
begin
  if new.event_code <> 'workforce_payout_review' or new.campaign_id is not null then
    return new;
  end if;

  batch_id := (
    pg_catalog.md5(
      new.company_id::text || ':' ||
      pg_catalog.txid_current()::text || ':' ||
      new.event_code
    )
  )::uuid;
  batch_code := 'APP-PAYOUT-' || upper(replace(batch_id::text, '-', ''));

  insert into public.mob_app_notification_campaigns (
    id, company_id, event_code, campaign_code, created_by, created_at
  ) values (
    batch_id, new.company_id, new.event_code, batch_code, new.created_by, now()
  )
  on conflict (id) do nothing;

  new.campaign_id := batch_id;
  new.data := coalesce(new.data, '{}'::jsonb) || pg_catalog.jsonb_build_object(
    'batchId', batch_id::text,
    'campaignCode', batch_code
  );

  if new.recipient_profile_type = 'workforce' then
    select workforce.dropx_id, workforce.full_name
    into recipient_dropx_id, recipient_name
    from public.workforce workforce
    where workforce.company_id = new.company_id
      and workforce.id = new.recipient_account_id;

    new.data := new.data || pg_catalog.jsonb_build_object(
      'dropxId', coalesce(nullif(new.data ->> 'dropxId', ''), recipient_dropx_id, ''),
      'dropxName', coalesce(recipient_name, 'Workforce account')
    );
  end if;
  return new;
end
$function$;

revoke all on function public.mob_app_assign_payout_campaign()
  from public, anon, authenticated;
grant execute on function public.mob_app_assign_payout_campaign()
  to service_role;

drop trigger if exists mob_app_notifications_assign_payout_campaign
  on public.mob_app_notifications;
create trigger mob_app_notifications_assign_payout_campaign
before insert on public.mob_app_notifications
for each row
execute function public.mob_app_assign_payout_campaign();

notify pgrst, 'reload schema';

commit;
