-- Auto-seed copied station-audit responder roles into siRoles, which locked out
-- floor users who had the SI Handover page but not those roles. Empty allowlist
-- = anyone with page add/edit (documented Master behaviour).
begin;
update public.ops_si_handover_master
set
  settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{siRoles}', '[]'::jsonb),
  updated_at = now()
where coalesce(jsonb_typeof(settings->'siRoles'), 'null') = 'array'
  and jsonb_array_length(settings->'siRoles') > 0;
notify pgrst, 'reload schema';
commit;
