begin;

-- Lets oversight (Program Manager / Owner / National Head / Tech / Cluster-AOM-filter
-- holders) explicitly hand edit access back to the original (first-stage) CM/AOM reviewer
-- after oversight has edited a review themselves. Scoped to editing only (RCA, connections,
-- actions) — never grants completion/bypass/proxy authority, and is neutralized the moment
-- the review closes (see reviewCapabilities()'s `!closed` guard on the app side, and the
-- close path below on the SQL side).
alter table public.ops_performance_reviews
  add column if not exists reviewer_edit_reopened boolean not null default false;

comment on column public.ops_performance_reviews.reviewer_edit_reopened is
  'When true, the original (first-stage) CM/AOM reviewer can edit RCA/connections/actions again even though they are no longer the current pending step. Set/cleared only by oversight via ops_reopen_reviewer_edit_access / ops_close_reopened_reviewer_edit_access.';

-- Same role-check block as ops_bypass_review_level (20260904170001), so this is defense in
-- depth alongside the server action's own access.canAccessBypass check, not a replacement.
create or replace function public.ops_reopen_reviewer_edit_access(
  p_company uuid, p_actor uuid, p_review uuid, p_reopened boolean, p_expected_version timestamptz
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare
  v_review ops_performance_reviews; v_profile profiles; v_role user_roles;
  v_people_labels text[]; v_allowed boolean=false;
begin
  select * into v_profile from profiles where id=p_actor and company_id=p_company and is_active;
  if not found then raise exception 'Your account is unavailable.'; end if;
  select * into v_role from user_roles where id=v_profile.role_id and company_id=p_company and is_active;
  select array_agg(upper(regexp_replace(concat_ws(' ',d.code,d.name,a.position_title),'[^a-zA-Z0-9]+',' ','g')))
    into v_people_labels
  from hr_user_person_links l join hr_engagements e on e.person_id=l.person_id and e.company_id=l.company_id and e.status='active'
  join hr_work_assignments a on a.engagement_id=e.id and a.company_id=e.company_id and a.is_primary
    and a.effective_from <= (now() at time zone 'Asia/Kolkata')::date
    and (a.effective_to is null or a.effective_to >= (now() at time zone 'Asia/Kolkata')::date)
  left join designations d on d.id=a.designation_id and d.company_id=a.company_id
  where l.company_id=p_company and l.user_id=p_actor and l.status='active';
  v_allowed := coalesce(v_profile.is_master_owner,false)
    or coalesce(v_role.code in ('OWNER','TECH','OPERATIONS_TECH'),false)
    or coalesce(upper(concat_ws(' ',v_role.code,v_role.name)) ~ 'MANAGING[ _]PARTNER',false)
    or exists(select 1 from unnest(coalesce(v_people_labels,array[upper(regexp_replace(concat_ws(' ',v_role.code,v_role.name),'[^a-zA-Z0-9]+',' ','g'))])) label
      where label ~ '(^| )(PGM|PROGRAM MANAGER|PROGRAM HEAD|NH|NATIONAL HEAD|FSD|TECH|FULL STACK DEVELOPER)( |$)')
    -- Cluster/AOM filter role grant (role_page_permissions.can_view for the
    -- performance_review_cluster_filter page) — mirrors access.canAccessBypass's
    -- hasClusterFilterAccess check on the TS side; this is defense-in-depth only, the
    -- server action's own access.canAccessBypass check is the primary gate.
    or exists(
      select 1 from role_page_permissions rpp
      join app_pages page on page.id=rpp.page_id and page.company_id=rpp.company_id
      where rpp.company_id=p_company and rpp.role_id=v_role.id
        and page.code='performance_review_cluster_filter' and page.is_active and rpp.can_view
    );
  if not v_allowed then raise exception 'Your role cannot reopen edit access for a review.'; end if;

  select * into v_review from ops_performance_reviews where id=p_review and company_id=p_company for update;
  if not found then raise exception 'This review is unavailable.'; end if;
  if p_expected_version is distinct from v_review.updated_at then raise exception 'This review changed. Refresh before continuing.'; end if;

  update ops_performance_reviews set reviewer_edit_reopened=p_reopened,updated_by=p_actor,updated_at=clock_timestamp()
    where id=p_review;
  insert into ops_performance_review_updates(company_id,review_id,update_type,note,created_by,author_name,author_role,stage_label)
  values(p_company,p_review,'status',
    case when p_reopened then 'Reopened edit access for the station review manager.' else 'Closed reopened edit access.' end,
    p_actor,coalesce(nullif(v_profile.full_name,''),'Authorised reviewer'),coalesce(v_role.name,'Reviewer'),
    case when p_reopened then 'Edit access reopened' else 'Edit access closed' end);
  return jsonb_build_object('reviewerEditReopened',p_reopened);
end $$;

revoke all on function public.ops_reopen_reviewer_edit_access(uuid,uuid,uuid,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.ops_reopen_reviewer_edit_access(uuid,uuid,uuid,boolean,timestamptz) to service_role;

-- Closing a review neutralizes any reopened edit access, so a review that is later
-- reopened (e.g. via undo-bypass) never carries a stale flag from before it closed.
-- ops_bypass_review_level and ops_mutate_manager_review's own close-paths are left as-is;
-- this trigger is the single place that guarantees the invariant regardless of which path
-- closes the review.
create or replace function public.ops_performance_review_clear_reopen_on_close()
returns trigger language plpgsql as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then
    new.reviewer_edit_reopened := false;
  end if;
  return new;
end $$;

drop trigger if exists ops_performance_review_clear_reopen_on_close_trg on public.ops_performance_reviews;
create trigger ops_performance_review_clear_reopen_on_close_trg
before update on public.ops_performance_reviews
for each row execute function public.ops_performance_review_clear_reopen_on_close();

commit;
