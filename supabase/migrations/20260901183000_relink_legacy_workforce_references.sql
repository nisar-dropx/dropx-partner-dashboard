-- public.field_executives was retired in favor of the canonical Workforce register.
-- Keep the legacy column names for compatibility, but point their integrity
-- constraints at public.workforce. NOT VALID preserves any historical rows
-- while enforcing the relationship for new and changed records.
begin;

do $$
declare
  relation record;
begin
  for relation in
    select * from (values
      ('biometric_enrolments', 'field_executive_id', 'set null'),
      ('attendance_punches', 'field_executive_id', 'set null'),
      ('attendance_daily', 'field_executive_id', 'set null'),
      ('biometric_alerts', 'field_executive_id', 'set null'),
      ('field_executive_provider_mappings', 'field_executive_id', 'restrict'),
      ('ops_route_roster', 'field_executive_id', 'cascade'),
      ('ops_route_roster', 'replacement_for_id', 'set null'),
      ('ops_network_backup_pool', 'field_executive_id', 'cascade'),
      ('ops_vehicle_incidents', 'field_executive_id', 'set null'),
      ('ops_vehicle_incidents', 'replacement_field_executive_id', 'set null'),
      ('whatsapp_message_logs', 'field_executive_id', 'set null'),
      ('workforce_agreement_acceptances', 'field_executive_id', 'cascade'),
      ('workforce_onboarding_checklist_results', 'field_executive_id', 'cascade'),
      ('workforce_onboarding_events', 'field_executive_id', 'cascade'),
      ('workforce_lifecycle_cases', 'field_executive_id', 'restrict'),
      ('workforce_lifecycle_events', 'field_executive_id', 'restrict')
    ) as dependency(table_name, column_name, delete_action)
  loop
    if to_regclass(format('public.%I', relation.table_name)) is not null
       and exists (
         select 1
         from information_schema.columns
         where table_schema = 'public'
           and table_name = relation.table_name
           and column_name = relation.column_name
       ) then
      execute format(
        'alter table public.%I drop constraint if exists %I',
        relation.table_name,
        relation.table_name || '_' || relation.column_name || '_fkey'
      );
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references public.workforce(id) on delete %s not valid',
        relation.table_name,
        relation.table_name || '_' || relation.column_name || '_fkey',
        relation.column_name,
        relation.delete_action
      );
    end if;
  end loop;
end
$$;

commit;
