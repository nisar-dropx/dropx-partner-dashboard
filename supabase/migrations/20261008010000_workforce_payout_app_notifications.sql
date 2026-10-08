begin;

alter table public.whatsapp_notification_configs
  add column if not exists app_notification_enabled boolean not null default false;

comment on column public.whatsapp_notification_configs.app_notification_enabled is
  'When true, publishing a Workforce payout also creates a DropX One inbox notification and attempts a device push.';

-- DropX One Workforce accounts must be able to register both Android and iOS
-- devices before the publication outbox can deliver a push notification.
alter table public.mob_app_device_tokens
  drop constraint if exists mob_app_device_tokens_profile_type_check;
alter table public.mob_app_device_tokens
  add constraint mob_app_device_tokens_profile_type_check
  check (profile_type in (
    'user', 'employee', 'field_executive', 'contractor', 'vendor', 'worker', 'workforce'
  ));

alter table public.mob_app_device_tokens
  drop constraint if exists mob_app_device_tokens_platform_check;
alter table public.mob_app_device_tokens
  add constraint mob_app_device_tokens_platform_check
  check (platform in ('android', 'ios', 'web'));

-- This status remains the WhatsApp delivery state. App-only publications are
-- deliberately marked disabled because their independent push state is stored
-- on mob_app_notifications.
alter table public.workforce_payout_publications
  drop constraint if exists workforce_payout_publications_notification_status_check;
alter table public.workforce_payout_publications
  add constraint workforce_payout_publications_notification_status_check
  check (notification_status in (
    'pending', 'sending', 'sent', 'failed', 'uncertain', 'superseded', 'disabled'
  )) not valid;

create or replace function public.workforce_publish_payout_notifications(
  p_company uuid,
  p_actor uuid,
  p_period_start date,
  p_period_end date,
  p_items jsonb,
  p_locations uuid[] default null,
  p_expected_dependency_hash text default null,
  p_review_until timestamptz default null,
  p_notify_at timestamptz default now(),
  p_notification_config_id uuid default null,
  p_notification_config_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  item jsonb;
  item_subject uuid;
  item_location uuid;
  item_expected_status text;
  item_snapshot jsonb;
  item_snapshot_hash text;
  item_notification_snapshot jsonb;
  item_notification_primary boolean;
  review_id uuid;
  publication_id uuid;
  app_notification_id uuid;
  next_revision integer;
  current_dependency_hash text;
  config_whatsapp_enabled boolean;
  config_app_enabled boolean;
  saved integer := 0;
  changed integer := 0;
  publication_ids jsonb := '[]'::jsonb;
  whatsapp_publication_ids jsonb := '[]'::jsonb;
  app_notification_ids jsonb := '[]'::jsonb;
begin
  if p_company is null or p_actor is null then
    raise exception 'Company and publisher are required';
  end if;
  if p_period_start is null
    or p_period_end is null
    or p_period_start <> date_trunc('month', p_period_start)::date
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Send Notification is available only for one complete calendar month';
  end if;
  if p_review_until is null or p_review_until <= now() then
    raise exception 'A future payout dispute deadline is required';
  end if;
  if p_notify_at is null or p_notify_at >= p_review_until then
    raise exception 'Notification time must precede the payout dispute deadline';
  end if;
  if nullif(btrim(p_expected_dependency_hash), '') is null then
    raise exception 'The payout worksheet version is required';
  end if;
  if p_notification_config_id is null or p_notification_config_updated_at is null then
    raise exception 'The payout notification configuration is required';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one Workforce payout';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'Submit at most 1000 payouts at a time';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) selected
    group by lower(nullif(selected ->> 'subject_id', '')),
      lower(nullif(selected ->> 'location_id', ''))
    having count(*) > 1
  ) then
    raise exception 'The same Workforce payout location was selected more than once';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) selected
    group by lower(nullif(selected ->> 'subject_id', ''))
    having count(*) filter (where coalesce((selected ->> 'notification_primary')::boolean, false)) <> 1
  ) then
    raise exception 'Exactly one notification must be queued for each DropX ID';
  end if;

  -- Lock every selected identity in UUID order before the shared company mutex.
  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company
    and workforce.id in (
      select nullif(selected ->> 'subject_id', '')::uuid
      from jsonb_array_elements(p_items) selected
    )
  order by workforce.id
  for update;

  if (select count(*) from public.workforce workforce
      where workforce.company_id = p_company
        and workforce.deleted_at is null
        and workforce.migration_state <> 'reclassified'
        and workforce.id in (
          select nullif(selected ->> 'subject_id', '')::uuid
          from jsonb_array_elements(p_items) selected
         )) <> (
           select count(distinct nullif(selected ->> 'subject_id', '')::uuid)
           from jsonb_array_elements(p_items) selected
         )
  then
    raise exception 'A selected Workforce payout is no longer available';
  end if;

  perform public.lock_workforce_payment_allocation_company(p_company);
  current_dependency_hash := public.workforce_advance_recovery_snapshot_hash(
    p_company, p_period_start, p_period_end
  );
  if current_dependency_hash is distinct from p_expected_dependency_hash then
    raise exception 'Payout inputs changed after this worksheet was displayed. Refresh the page and review the recalculated amounts.';
  end if;

  select config.is_enabled, coalesce(config.app_notification_enabled, false)
  into config_whatsapp_enabled, config_app_enabled
  from public.whatsapp_notification_configs config
  where config.company_id = p_company
    and config.id = p_notification_config_id
    and config.event_code = 'workforce_payout_review'
    and config.updated_at = p_notification_config_updated_at;
  if not found then
    raise exception 'The payout notification setting changed. Review the setting and try again.';
  end if;
  if not config_whatsapp_enabled and not config_app_enabled then
    raise exception 'Enable App or WhatsApp notifications before publishing payouts.';
  end if;

  if config_whatsapp_enabled and not exists (
    select 1
    from public.whatsapp_notification_configs config
    join public.whatsapp_profiles profile
      on profile.company_id = config.company_id
     and profile.id = config.whatsapp_profile_id
     and profile.is_active is true
     and nullif(btrim(profile.phone_number_id), '') is not null
    join public.whatsapp_template_cache template
      on template.company_id = config.company_id
     and template.whatsapp_profile_id = config.whatsapp_profile_id
     and template.template_id = config.template_id
     and template.name = config.template_name
     and template.language = config.template_language
     and upper(template.status) = 'APPROVED'
    join public.whatsapp_settings settings
      on settings.company_id = config.company_id
     and settings.is_enabled is true
    where config.company_id = p_company
      and config.id = p_notification_config_id
      and config.event_code = 'workforce_payout_review'
      and config.is_enabled is true
      and config.updated_at = p_notification_config_updated_at
      and jsonb_typeof(config.variable_mappings) = 'object'
  ) then
    raise exception 'The payout WhatsApp notification setting changed or is no longer ready. Review the setting and try again.';
  end if;

  -- Supersede only publications from an earlier transaction. All station
  -- snapshots for this request are inserted below and share one notification.
  update public.workforce_payout_publications publication
  set notification_status = 'superseded'
  where publication.company_id = p_company
    and publication.workforce_id in (
      select distinct nullif(selected ->> 'subject_id', '')::uuid
      from jsonb_array_elements(p_items) selected
    )
    and publication.publication_kind = 'worksheet'
    and publication.period_start = p_period_start
    and publication.period_end = p_period_end
    and publication.notification_status in ('pending', 'failed');

  for item in select value from jsonb_array_elements(p_items)
  loop
    if lower(btrim(item ->> 'subject_type')) <> 'workforce' then
      raise exception 'Send Notification is available only for Workforce payouts';
    end if;
    item_subject := nullif(item ->> 'subject_id', '')::uuid;
    item_location := nullif(item ->> 'location_id', '')::uuid;
    item_expected_status := lower(btrim(item ->> 'expected_status'));
    item_snapshot := item -> 'calculation_snapshot';
    item_snapshot_hash := nullif(btrim(item ->> 'snapshot_hash'), '');
    item_notification_snapshot := item -> 'notification_config_snapshot';
    item_notification_primary := coalesce((item ->> 'notification_primary')::boolean, false);

    if item_subject is null or item_location is null
      or item_expected_status not in ('ready', 'returned')
      or jsonb_typeof(item_snapshot) <> 'object'
      or item_snapshot ->> 'schema_version' <> '2'
      or item_snapshot ->> 'source' <> 'workforce_payout_worksheet'
      or item_snapshot #>> '{run,period_start}' <> p_period_start::text
      or item_snapshot #>> '{run,period_end}' <> p_period_end::text
      or item_snapshot #>> '{item,workforce_id}' <> item_subject::text
      or item_snapshot #>> '{item,station_id}' <> item_location::text
      or item_snapshot_hash is null
      or jsonb_typeof(item_notification_snapshot) <> 'object'
      or item_notification_snapshot ->> 'schema_version' <> '1'
      or item_notification_snapshot ->> 'event_code' <> 'workforce_payout_review'
      or jsonb_typeof(item_notification_snapshot -> 'app_notification_enabled') <> 'boolean'
      or jsonb_typeof(item_notification_snapshot -> 'whatsapp_notification_enabled') <> 'boolean'
      or coalesce((item_notification_snapshot ->> 'app_notification_enabled')::boolean, false)
        is distinct from config_app_enabled
      or coalesce((item_notification_snapshot ->> 'whatsapp_notification_enabled')::boolean, false)
        is distinct from config_whatsapp_enabled
      or jsonb_typeof(item_notification_snapshot -> 'resolved_values') <> 'object'
    then
      raise exception 'A selected payout snapshot is invalid';
    end if;
    if (
      select array_agg(key order by key)
      from jsonb_object_keys(item_notification_snapshot -> 'resolved_values') key
    ) is distinct from array[
      'deduction_amount','dropx_id','full_name','gross_amount','net_amount',
      'payment_label','payout_period','payout_url','review_deadline','station_code','work_days'
    ]::text[]
      or exists (
        select 1
        from jsonb_each(item_notification_snapshot -> 'resolved_values') value
        where jsonb_typeof(value.value) <> 'string'
      )
      or item_notification_snapshot #>> '{resolved_values,payout_url}'
        !~ '^https://one[.]dropxlogistics[.]com/payments[?]'
    then
      raise exception 'The payout notification values are incomplete';
    end if;

    if config_whatsapp_enabled then
      if item_notification_snapshot ->> 'whatsapp_profile_id' is null
        or item_notification_snapshot ->> 'template_id' is null
        or nullif(item_notification_snapshot ->> 'recipient', '') is null
        or item_notification_snapshot ->> 'recipient' !~ '^[0-9]{11,15}$'
        or jsonb_typeof(item_notification_snapshot -> 'variable_mappings') <> 'object'
        or jsonb_typeof(item_notification_snapshot -> 'template_components') <> 'array'
      then
        raise exception 'The payout WhatsApp notification snapshot is invalid';
      end if;
      if not exists (
        select 1
        from public.whatsapp_notification_configs config
        join public.whatsapp_template_cache template
          on template.company_id = config.company_id
         and template.whatsapp_profile_id = config.whatsapp_profile_id
         and template.template_id = config.template_id
         and template.name = config.template_name
         and template.language = config.template_language
         and upper(template.status) = 'APPROVED'
        where config.company_id = p_company
          and config.id = p_notification_config_id
          and item_notification_snapshot ->> 'whatsapp_profile_id' = config.whatsapp_profile_id::text
          and item_notification_snapshot ->> 'template_id' = config.template_id
          and item_notification_snapshot ->> 'template_name' = config.template_name
          and item_notification_snapshot ->> 'template_language' = config.template_language
          and item_notification_snapshot -> 'variable_mappings' = config.variable_mappings
          and item_notification_snapshot -> 'template_components' = template.components
      ) then
        raise exception 'The payout WhatsApp notification snapshot does not match the saved setting';
      end if;
      if not exists (
        select 1
        from public.workforce workforce
        where workforce.company_id = p_company
          and workforce.id = item_subject
          and item_notification_snapshot ->> 'recipient' = case
            when length(regexp_replace(coalesce(workforce.mobile, ''), '[^0-9]', '', 'g')) > 10
              and left(
                regexp_replace(coalesce(workforce.mobile, ''), '[^0-9]', '', 'g'),
                length(coalesce(nullif(regexp_replace(coalesce(workforce.mobile_country_code, '91'), '[^0-9]', '', 'g'), ''), '91'))
              ) = coalesce(nullif(regexp_replace(coalesce(workforce.mobile_country_code, '91'), '[^0-9]', '', 'g'), ''), '91')
            then regexp_replace(coalesce(workforce.mobile, ''), '[^0-9]', '', 'g')
            else coalesce(nullif(regexp_replace(coalesce(workforce.mobile_country_code, '91'), '[^0-9]', '', 'g'), ''), '91')
              || regexp_replace(coalesce(workforce.mobile, ''), '[^0-9]', '', 'g')
          end
      ) then
        raise exception 'A selected Workforce member does not have a valid WhatsApp mobile number';
      end if;
    end if;

    if p_locations is not null and not (item_location = any(p_locations)) then
      raise exception 'A selected payout is outside your location scope';
    end if;
    if not exists (
      select 1 from public.stations station
      where station.company_id = p_company and station.id = item_location
    ) then
      raise exception 'A selected payout location is unavailable';
    end if;

    if item_expected_status = 'ready' and exists (
      select 1 from public.workforce_payout_review_submissions existing
      where existing.company_id = p_company
        and existing.subject_type = 'workforce'
        and existing.subject_id = item_subject
        and existing.location_id = item_location
        and existing.period_start = p_period_start
        and existing.period_end = p_period_end
    ) then
      raise exception 'The payout publication state changed. Refresh the worksheet and try again.';
    end if;
    if item_expected_status = 'returned' and not exists (
      select 1 from public.workforce_payout_review_submissions existing
      where existing.company_id = p_company
        and existing.subject_type = 'workforce'
        and existing.subject_id = item_subject
        and existing.location_id = item_location
        and existing.period_start = p_period_start
        and existing.period_end = p_period_end
        and existing.status = 'returned'
    ) then
      raise exception 'The payout publication state changed. Refresh the worksheet and try again.';
    end if;

    insert into public.workforce_payout_review_submissions (
      company_id, subject_type, subject_id, location_id,
      period_start, period_end, status, calculation_snapshot,
      submitted_by, submitted_at, updated_at
    ) values (
      p_company, 'workforce', item_subject, item_location,
      p_period_start, p_period_end, 'under_review', item_snapshot,
      p_actor, now(), now()
    )
    on conflict (company_id, subject_type, subject_id, location_id, period_start, period_end)
    do update set
      status = 'under_review',
      calculation_snapshot = excluded.calculation_snapshot,
      submitted_by = excluded.submitted_by,
      submitted_at = excluded.submitted_at,
      updated_at = now()
    where item_expected_status = 'returned'
      and workforce_payout_review_submissions.status = 'returned'
    returning id into review_id;

    get diagnostics changed = row_count;
    if changed <> 1 or review_id is null then
      raise exception 'The payout publication state changed. Refresh the worksheet and try again.';
    end if;

    select coalesce(max(publication.revision), 0) + 1
    into next_revision
    from public.workforce_payout_publications publication
    where publication.company_id = p_company
      and publication.workforce_id = item_subject
      and publication.publication_kind = 'worksheet'
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end;

    insert into public.workforce_payout_publications (
      company_id, payroll_run_id, workforce_id, station_id, revision,
      snapshot, published_by, published_at, review_until, notify_at,
      source_calculated_at, notification_status, review_submission_id,
      period_start, period_end, snapshot_hash, dependency_hash,
      notification_config_snapshot, publication_kind
    ) values (
      p_company, null, item_subject, item_location, next_revision,
      item_snapshot, p_actor, now(), p_review_until, p_notify_at,
      clock_timestamp(), case
        when not item_notification_primary then 'superseded'
        when config_whatsapp_enabled then 'pending'
        else 'disabled'
      end, review_id,
      p_period_start, p_period_end, item_snapshot_hash,
      p_expected_dependency_hash, item_notification_snapshot, 'worksheet'
    ) returning id into publication_id;

    saved := saved + 1;
    if item_notification_primary then
      publication_ids := publication_ids || jsonb_build_array(publication_id);
      if config_whatsapp_enabled then
        whatsapp_publication_ids := whatsapp_publication_ids || jsonb_build_array(publication_id);
      end if;
      if config_app_enabled then
        app_notification_id := null;
        insert into public.mob_app_notifications (
          company_id, recipient_profile_type, recipient_account_id,
          event_code, title, body, route, data, source_key,
          created_by, push_status
        ) values (
          p_company, 'workforce', item_subject,
          'workforce_payout_review', 'Payment details available',
          format(
            '%s details for %s are now available in DropX One.',
            coalesce(nullif(item_notification_snapshot #>> '{resolved_values,payment_label}', ''), 'Payment'),
            coalesce(nullif(item_notification_snapshot #>> '{resolved_values,payout_period}', ''), to_char(p_period_start, 'Mon YYYY'))
          ),
          item_notification_snapshot #>> '{resolved_values,payout_url}',
          jsonb_build_object(
            'publicationId', publication_id,
            'periodStart', p_period_start,
            'periodEnd', p_period_end,
            'payoutMonth', to_char(p_period_start, 'YYYY-MM'),
            'reviewUntil', p_review_until,
            'tab', 'payouts',
            'dropxId', item_notification_snapshot #>> '{resolved_values,dropx_id}'
          ),
          publication_id::text, p_actor, 'not_configured'
        )
        on conflict (company_id, event_code, source_key, recipient_account_id) do nothing
        returning id into app_notification_id;
        if app_notification_id is null then
          raise exception 'The DropX One payout notification could not be created';
        end if;
        app_notification_ids := app_notification_ids || jsonb_build_array(app_notification_id);
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'published', saved,
    'publication_ids', publication_ids,
    'whatsapp_publication_ids', whatsapp_publication_ids,
    'app_notification_ids', app_notification_ids
  );
end
$function$;

comment on function public.workforce_publish_payout_notifications(
  uuid, uuid, date, date, jsonb, uuid[], text, timestamptz, timestamptz, uuid, timestamptz
) is
  'Atomically revalidates and publishes monthly Workforce payouts, freezes overlapping mappings, and creates the enabled WhatsApp queue and DropX One App outbox records.';

revoke all on function public.workforce_publish_payout_notifications(
  uuid, uuid, date, date, jsonb, uuid[], text, timestamptz, timestamptz, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.workforce_publish_payout_notifications(
  uuid, uuid, date, date, jsonb, uuid[], text, timestamptz, timestamptz, uuid, timestamptz
) to service_role;

grant select, insert, update on table public.mob_app_notifications to service_role;
grant select, insert, update on table public.mob_app_device_tokens to service_role;

notify pgrst, 'reload schema';

commit;
