drop index if exists public.mob_app_notifications_campaign_idx;

create index mob_app_notifications_campaign_idx
  on public.mob_app_notifications (company_id, campaign_id, created_at, id)
  where campaign_id is not null;

notify pgrst, 'reload schema';
