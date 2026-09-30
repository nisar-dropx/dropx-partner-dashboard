-- Outcome behaviour belongs to Audit Master. The application reads these JSON
-- fields to determine compliance, CAPA and evidence requirements.
update public.ops_audit_checklist_items
set response_options = '[{"value":"pass","label":"Pass","is_compliant":true},{"value":"fail","label":"Fail","is_compliant":false,"requires_action":true,"requires_evidence":true},{"value":"na","label":"Not applicable"}]'::jsonb,
    updated_at = now()
where company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and response_type = 'pass_fail_na';

-- Discrepancy counters and default CAPA severity are also master values rather
-- than code-defined shipment labels.
update public.ops_audit_reference_options
set metadata = case code
  when 'missing' then '{"count_as":"missing","default_severity_code":"high"}'::jsonb
  when 'excess' then '{"count_as":"excess","default_severity_code":"high"}'::jsonb
  when 'left_station' then '{"default_severity_code":"medium"}'::jsonb
  when 'status_mismatch' then '{"default_severity_code":"medium"}'::jsonb
  when 'damaged' then '{"default_severity_code":"high"}'::jsonb
  else metadata
end,
updated_at = now()
where company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and option_group = 'shipment_discrepancy';
