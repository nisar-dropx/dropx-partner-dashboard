-- One-time tenant configuration requested by Jamsheer. Runtime policy is stored
-- in Audit Master, not embedded as user names, roles or IDs in application code.
do $$
declare tenant constant uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  approved uuid[] := array['487d09f1-d9b4-4bea-aa2f-c59bb1a9d9ac','2909d787-6d35-4eac-807f-fc3ec71c4dc3']::uuid[];
begin
  if (select count(*) from public.profiles where company_id=tenant and id=any(approved) and is_active)<>2 then
    raise exception 'Both approved users must be active in this company.';
  end if;
  update public.ops_audit_programme_settings set delete_user_ids=approved,updated_by=approved[1] where company_id=tenant;
  if not found then raise exception 'Audit programme settings not found.'; end if;
  update public.ops_audit_types set requires_video_link=true,
    video_link_help='Upload the video-call screen recording and audit photos to one Google Drive folder. Share the folder with Anyone with the link and Viewer access.'
    where company_id=tenant and code='virtual_cod';
  if not found then raise exception 'Virtual COD audit type not found.'; end if;
end $$;
