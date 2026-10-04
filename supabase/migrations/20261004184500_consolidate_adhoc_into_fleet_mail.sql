-- Ad hoc Van and Driver activity is included in the DropX Daily Fleet Update.
-- Keep the legacy Ops digest disabled so recipients do not receive duplicates.
update public.portal_notification_controls
set state = 'disabled',
    config = jsonb_set(coalesce(config, '{}'::jsonb), '{delivery_ready}', 'false'::jsonb, true),
    updated_at = now()
where portal = 'ops'
  and event_key = 'adhoc_usage_digest';
