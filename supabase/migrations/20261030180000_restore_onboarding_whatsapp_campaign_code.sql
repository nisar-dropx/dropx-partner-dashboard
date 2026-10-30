-- Onboarding WhatsApp inserts into whatsapp_campaigns with campaign_code ONBOARD-N.
-- The generator RPC/sequence from scripts/whatsapp_auto_trigger_campaigns_v1.sql
-- was never applied on this project, so the app fell back to COUNT(*)+1. After
-- deletions/gaps that reuses an existing code and every invite fails with
-- whatsapp_campaigns_campaign_code_key — so DropX ID / biometric WhatsApps stop.

create sequence if not exists public.whatsapp_onboarding_campaign_seq;

select setval(
  'public.whatsapp_onboarding_campaign_seq',
  greatest(
    coalesce((
      select max(nullif(regexp_replace(campaign_code, '\D', '', 'g'), '')::bigint)
      from public.whatsapp_campaigns
      where campaign_code ~ '^ONBOARD-[0-9]+$'
    ), 0),
    1
  ),
  true
);

create or replace function public.next_onboarding_campaign_code()
returns text
language sql
security definer
set search_path = public
as $$
  select 'ONBOARD-' || nextval('public.whatsapp_onboarding_campaign_seq')::text;
$$;

revoke all on function public.next_onboarding_campaign_code() from public, anon, authenticated;
grant execute on function public.next_onboarding_campaign_code() to service_role;
