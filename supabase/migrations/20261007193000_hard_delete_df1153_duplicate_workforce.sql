-- Permanently remove the duplicate pending Workforce profile DF1153.
--
-- The valid profile JDBD1077 already owns the active provider mapping for the
-- same person and provider member. Keep the valid profile and its replacement
-- audit event; remove only DF1153 and business records owned by DF1153.

do $cleanup$
declare
  target public.workforce%rowtype;
  replacement public.workforce%rowtype;
  target_campaign_id uuid;
  reference record;
  reference_count bigint;
  affected bigint;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('hard-delete-workforce:DF1153', 0)
  );

  if (
    select count(*)
    from public.workforce workforce
    where upper(btrim(workforce.dropx_id)) = 'DF1153'
  ) > 1 then
    raise exception 'DF1153 cleanup aborted: more than one Workforce row uses this DropX ID';
  end if;

  select workforce.*
  into target
  from public.workforce workforce
  where upper(btrim(workforce.dropx_id)) = 'DF1153'
  for update;

  -- Idempotent replay after the guarded cleanup is a no-op.
  if not found then
    return;
  end if;

  if upper(btrim(target.full_name)) <> 'BHUWANESWAR BHARADWAJ'
     or btrim(coalesce(target.biometric_id, '')) <> '500427'
     or lower(coalesce(target.onboarding_status, '')) <> 'pending'
     or target.is_active is distinct from false
     or target.deleted_at is not null then
    raise exception 'DF1153 cleanup aborted: the target profile no longer matches the audited duplicate';
  end if;

  if (
    select count(*)
    from public.workforce workforce
    where workforce.company_id = target.company_id
      and upper(btrim(workforce.dropx_id)) = 'JDBD1077'
      and upper(btrim(workforce.full_name)) = upper(btrim(target.full_name))
      and regexp_replace(coalesce(workforce.mobile, ''), '\D', '', 'g')
        = regexp_replace(coalesce(target.mobile, ''), '\D', '', 'g')
      and workforce.deleted_at is null
  ) <> 1 then
    raise exception 'DF1153 cleanup aborted: expected exactly one valid JDBD1077 replacement profile';
  end if;

  select workforce.*
  into replacement
  from public.workforce workforce
  where workforce.company_id = target.company_id
    and upper(btrim(workforce.dropx_id)) = 'JDBD1077'
    and upper(btrim(workforce.full_name)) = upper(btrim(target.full_name))
    and regexp_replace(coalesce(workforce.mobile, ''), '\D', '', 'g')
      = regexp_replace(coalesce(target.mobile, ''), '\D', '', 'g')
    and workforce.deleted_at is null
  for update;

  if not found then
    raise exception 'DF1153 cleanup aborted: valid replacement Workforce profile JDBD1077 was not found';
  end if;

  if (
    select count(*)
    from public.field_executive_provider_mappings mapping
    where mapping.workforce_id = target.id
      and lower(mapping.status) = 'cancelled'
      and exists (
        select 1
        from public.field_executive_provider_mappings active_mapping
        where active_mapping.workforce_id = replacement.id
          and active_mapping.company_id = mapping.company_id
          and active_mapping.provider_id = mapping.provider_id
          and upper(btrim(active_mapping.provider_member_id))
            = upper(btrim(mapping.provider_member_id))
          and active_mapping.effective_from = mapping.effective_from
          and lower(active_mapping.status) = 'active'
      )
  ) <> 1 then
    raise exception 'DF1153 cleanup aborted: the cancelled mapping is not safely replaced by JDBD1077';
  end if;

  -- A new FK-backed business record must stop this cleanup instead of being
  -- silently removed. Only the records audited for this duplicate are allowed.
  for reference in
    select distinct
      child_namespace.nspname as child_schema,
      child.relname as child_table,
      child_attribute.attname as child_column
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class child
      on child.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace child_namespace
      on child_namespace.oid = child.relnamespace
    join lateral unnest(constraint_row.conkey) with ordinality child_key(attnum, ord)
      on true
    join lateral unnest(constraint_row.confkey) with ordinality parent_key(attnum, ord)
      on parent_key.ord = child_key.ord
    join pg_catalog.pg_attribute child_attribute
      on child_attribute.attrelid = constraint_row.conrelid
     and child_attribute.attnum = child_key.attnum
    join pg_catalog.pg_attribute parent_attribute
      on parent_attribute.attrelid = constraint_row.confrelid
     and parent_attribute.attnum = parent_key.attnum
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.workforce'::regclass
      and parent_attribute.attname = 'id'
  loop
    execute format(
      'select count(*) from %I.%I where %I = $1',
      reference.child_schema,
      reference.child_table,
      reference.child_column
    )
    into reference_count
    using target.id;

    if reference_count > 0
       and (reference.child_table, reference.child_column) not in (
         ('field_executive_provider_mappings', 'workforce_id'),
         ('whatsapp_message_logs', 'field_executive_id'),
         ('workforce_joining_events', 'workforce_id'),
         ('workforce_onboarding_events', 'workforce_id'),
         ('workforce_payment_policy_history', 'workforce_id')
       ) then
      raise exception
        'DF1153 cleanup aborted: unexpected dependency %.% has % row(s)',
        reference.child_table,
        reference.child_column,
        reference_count;
    end if;
  end loop;

  if (select count(*) from public.field_executive_provider_mappings where workforce_id = target.id) <> 1
     or (select count(*) from public.whatsapp_message_logs where field_executive_id = target.id) <> 1
     or (select count(*) from public.workforce_joining_events where workforce_id = target.id) <> 2
     or (select count(*) from public.workforce_onboarding_events where workforce_id = target.id) <> 1
     or (select count(*) from public.workforce_payment_policy_history where workforce_id = target.id) <> 1
     or (
       select count(*)
       from public.mob_app_device_tokens device_token
       where device_token.account_id = target.id
         and device_token.profile_type = 'workforce'
     ) <> 1 then
    raise exception 'DF1153 cleanup aborted: audited dependent-row counts changed';
  end if;

  if (
    select count(*)
    from public.whatsapp_campaign_recipients recipient
    where recipient.source_id = target.id::text
      and recipient.source = 'field_executive'
      and upper(btrim(coalesce(recipient.recipient_payload ->> 'dropx_id', ''))) = 'DF1153'
  ) <> 1 then
    raise exception 'DF1153 cleanup aborted: onboarding campaign recipient count changed';
  end if;

  select recipient.campaign_id
  into target_campaign_id
  from public.whatsapp_campaign_recipients recipient
  where recipient.source_id = target.id::text
    and recipient.source = 'field_executive'
    and upper(btrim(coalesce(recipient.recipient_payload ->> 'dropx_id', ''))) = 'DF1153';

  if (
    select count(*)
    from public.whatsapp_campaign_recipients recipient
    where recipient.campaign_id = target_campaign_id
  ) <> 1
     or not exists (
       select 1
       from public.whatsapp_campaigns campaign
       where campaign.id = target_campaign_id
         and campaign.source_mode = 'auto_onboarding'
         and campaign.total_count = 1
     )
     or exists (
       select 1
       from public.workforce_partner_reminder_events reminder
       where reminder.campaign_id = target_campaign_id
     ) then
    raise exception 'DF1153 cleanup aborted: onboarding campaign is not exclusive to this duplicate';
  end if;

  -- The campaign contains only DF1153; recipients are removed by cascade.
  delete from public.whatsapp_campaigns campaign
  where campaign.id = target_campaign_id;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'DF1153 cleanup aborted: onboarding campaign delete count was %', affected;
  end if;

  delete from public.mob_app_device_tokens device_token
  where device_token.account_id = target.id
    and device_token.profile_type = 'workforce';
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'DF1153 cleanup aborted: mobile device-token delete count was %', affected;
  end if;

  delete from public.whatsapp_message_logs message_log
  where message_log.field_executive_id = target.id;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'DF1153 cleanup aborted: WhatsApp log delete count was %', affected;
  end if;

  delete from public.field_executive_provider_mappings mapping
  where mapping.workforce_id = target.id;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'DF1153 cleanup aborted: provider mapping delete count was %', affected;
  end if;

  delete from public.workforce_joining_events joining_event
  where joining_event.workforce_id = target.id;
  get diagnostics affected = row_count;
  if affected <> 2 then
    raise exception 'DF1153 cleanup aborted: joining-event delete count was %', affected;
  end if;

  delete from public.workforce_onboarding_events onboarding_event
  where onboarding_event.workforce_id = target.id;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'DF1153 cleanup aborted: onboarding-event delete count was %', affected;
  end if;

  delete from public.workforce_payment_policy_history policy
  where policy.workforce_id = target.id;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'DF1153 cleanup aborted: payment-policy delete count was %', affected;
  end if;

  delete from public.workforce workforce
  where workforce.id = target.id
    and upper(btrim(workforce.dropx_id)) = 'DF1153';
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'DF1153 cleanup aborted: Workforce delete count was %', affected;
  end if;

  if exists (
    select 1
    from public.workforce workforce
    where workforce.id = target.id
       or upper(btrim(workforce.dropx_id)) = 'DF1153'
  ) then
    raise exception 'DF1153 cleanup aborted: Workforce row still exists after delete';
  end if;
end
$cleanup$;
