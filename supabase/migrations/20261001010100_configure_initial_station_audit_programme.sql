-- Keep scheduling parameters in Audit Master records, never in application code.
update public.ops_audit_types
set scheduling_config = case code
  when 'virtual_cod' then '{"coverage":"every_active_station","distribution":"round_robin_by_weekday","schedule_time":"21:30","period_slots":[{"code":"weekly","label":"Weekly coverage","start_day":1,"end_day":7}]}'::jsonb
  when 'physical_station' then '{"coverage":"every_active_station","schedule_time":"06:30","period_slots":[{"code":"first_half","label":"First half","start_day":1,"end_day":15},{"code":"second_half","label":"Second half","start_day":16,"end_day":31}]}'::jsonb
  else scheduling_config
end,
updated_at = now()
where company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and code in ('virtual_cod', 'physical_station');

-- Checklist response choices are master data carried on each question.
update public.ops_audit_checklist_items
set response_options = '[{"value":"pass","label":"Pass","is_compliant":true},{"value":"fail","label":"Fail","is_compliant":false,"requires_action":true,"requires_evidence":true},{"value":"na","label":"Not applicable"}]'::jsonb,
updated_at = now()
where company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and response_type = 'pass_fail_na'
  and response_options = '[]'::jsonb;
