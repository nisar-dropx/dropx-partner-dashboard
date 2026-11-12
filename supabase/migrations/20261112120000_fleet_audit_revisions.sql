-- Controlled amendment of completed fleet audits.
-- Apply alone to the shared Supabase project after app tests pass.

begin;

alter table public.fleet_audits
  add column if not exists revision_draft jsonb not null default '{}'::jsonb,
  add column if not exists revised_at timestamptz,
  add column if not exists revised_by uuid references public.profiles(id),
  add column if not exists revision_count integer not null default 0;

alter table public.fleet_audit_findings drop constraint if exists fleet_audit_findings_status_check;
alter table public.fleet_audit_findings
  add constraint fleet_audit_findings_status_check
  check (status in ('open','in_progress','resolved','accepted','superseded'));

create table if not exists public.fleet_audit_revisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  audit_id uuid not null references public.fleet_audits(id) on delete cascade,
  revision_no integer not null check (revision_no > 0),
  actor_user_id uuid references public.profiles(id),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (audit_id, revision_no)
);

create index if not exists fleet_audit_revisions_audit_idx
  on public.fleet_audit_revisions(company_id, audit_id, revision_no desc);

alter table public.fleet_audit_revisions enable row level security;
revoke all on public.fleet_audit_revisions from anon, authenticated;
grant select, insert on public.fleet_audit_revisions to service_role;

-- Allow fleet_revise_audit_v1 to adjust findings without interactive closure proof.
create or replace function public.fleet_finding_update_guard() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_setting('fleet.audit_revision', true) = '1' then
    return new;
  end if;
  if row(new.status,new.resolution_note,new.action_required,new.expected_completion_date,new.severity,new.responsible_name,new.resolved_at,new.owner_user_id)
     is distinct from row(old.status,old.resolution_note,old.action_required,old.expected_completion_date,old.severity,old.responsible_name,old.resolved_at,old.owner_user_id) then
    if new.last_update_id is null or new.last_update_id is not distinct from old.last_update_id or not exists (
      select 1 from public.fleet_audit_finding_updates u
      where u.id=new.last_update_id and u.finding_id=new.id and u.company_id=new.company_id
        and u.status=new.status and u.note=new.resolution_note and u.action_required=new.action_required
        and u.due_date=new.expected_completion_date and u.severity=new.severity and u.responsible_name=new.responsible_name
        and (new.status<>'resolved' or jsonb_array_length(u.proofs)>0)
    ) then
      raise exception 'Use the audit action tracker. Closure requires uploaded proof and a recorded update.';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.fleet_revise_audit_v1(p_company uuid, p_audit uuid, p_user uuid, p_data jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  a public.fleet_audits;
  r jsonb;
  f public.fleet_audit_findings%rowtype;
  item_id uuid;
  new_finding_id uuid;
  next_rev integer;
  keep_ids uuid[] := array[]::uuid[];
begin
  select * into a from public.fleet_audits where id = p_audit and company_id = p_company for update;
  if not found then raise exception 'Audit was not found.'; end if;
  if a.status not in ('passed','failed') then raise exception 'Only a completed audit can be amended.'; end if;

  select coalesce(max(revision_no), 0) + 1 into next_rev
  from public.fleet_audit_revisions where audit_id = p_audit and company_id = p_company;

  insert into public.fleet_audit_revisions(company_id, audit_id, revision_no, actor_user_id, snapshot)
  values (
    p_company,
    p_audit,
    next_rev,
    p_user,
    jsonb_build_object(
      'status', a.status,
      'score', a.score,
      'summary', a.summary,
      'odometer_km', a.odometer_km,
      'completed_at', a.completed_at,
      'completed_by', a.completed_by,
      'revised_at', a.revised_at,
      'revised_by', a.revised_by,
      'revision_count', a.revision_count,
      'responses', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.responded_at, x.id)
        from public.fleet_audit_responses x
        where x.audit_id = p_audit and x.company_id = p_company
      ), '[]'::jsonb),
      'evidence', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.created_at, x.id)
        from public.fleet_audit_evidence x
        where x.audit_id = p_audit and x.company_id = p_company
      ), '[]'::jsonb),
      'findings', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.created_at, x.id)
        from public.fleet_audit_findings x
        where x.audit_id = p_audit and x.company_id = p_company
      ), '[]'::jsonb)
    )
  );

  for r in select * from jsonb_array_elements(coalesce(p_data->'responses', '[]'::jsonb)) loop
    insert into public.fleet_audit_responses(company_id, audit_id, checklist_item_id, response_value, passed, comments, responded_by)
    values (
      p_company,
      p_audit,
      (r->>'itemId')::uuid,
      r->'snapshot',
      (r->>'passed')::boolean,
      r->>'comments',
      p_user
    )
    on conflict (audit_id, checklist_item_id) do update
      set response_value = excluded.response_value,
          passed = excluded.passed,
          comments = excluded.comments,
          responded_by = p_user,
          responded_at = now();
  end loop;

  delete from public.fleet_audit_evidence where company_id = p_company and audit_id = p_audit;
  for r in select * from jsonb_array_elements(coalesce(p_data->'evidence', '[]'::jsonb)) loop
    insert into public.fleet_audit_evidence(company_id, audit_id, checklist_item_id, media_type, media_url, caption, uploaded_by)
    values (
      p_company,
      p_audit,
      nullif(r->>'itemId', '')::uuid,
      r->>'type',
      r->>'url',
      r->>'caption',
      p_user
    );
  end loop;

  perform set_config('fleet.audit_revision', '1', true);

  for r in select * from jsonb_array_elements(coalesce(p_data->'findings', '[]'::jsonb)) loop
    item_id := nullif(r->>'itemId', '')::uuid;
    if item_id is not null then
      select * into f
      from public.fleet_audit_findings
      where company_id = p_company
        and audit_id = p_audit
        and checklist_item_id = item_id
        and status in ('open', 'in_progress')
      order by created_at desc
      limit 1;
      if found then
        update public.fleet_audit_findings
          set category = r->>'category',
              finding = r->>'finding',
              severity = r->>'severity',
              action_required = r->>'actionRequired',
              expected_completion_date = nullif(r->>'expectedCompletionDate', '')::date,
              resolution_note = case
                when coalesce(nullif(trim(resolution_note), ''), '') = '' then 'Amended by audit revision'
                when resolution_note like '%Amended by audit revision%' then resolution_note
                else resolution_note || E'\nAmended by audit revision'
              end,
              updated_at = now()
        where id = f.id;
        keep_ids := array_append(keep_ids, f.id);
        continue;
      end if;

      select * into f
      from public.fleet_audit_findings
      where company_id = p_company
        and audit_id = p_audit
        and checklist_item_id = item_id
        and status = 'resolved'
      order by created_at desc
      limit 1;
      if found then
        update public.fleet_audit_findings
          set resolution_note = case
                when coalesce(nullif(trim(resolution_note), ''), '') = '' then 'Checklist amended while this finding stayed resolved'
                when resolution_note like '%Checklist amended while this finding stayed resolved%' then resolution_note
                else resolution_note || E'\nChecklist amended while this finding stayed resolved'
              end,
              updated_at = now()
        where id = f.id;
        keep_ids := array_append(keep_ids, f.id);
        continue;
      end if;
    end if;

    insert into public.fleet_audit_findings(
      company_id, audit_id, checklist_item_id, category, finding, severity, action_required, expected_completion_date, owner_user_id
    ) values (
      p_company,
      p_audit,
      item_id,
      r->>'category',
      r->>'finding',
      r->>'severity',
      r->>'actionRequired',
      nullif(r->>'expectedCompletionDate', '')::date,
      p_user
    ) returning id into new_finding_id;
    keep_ids := array_append(keep_ids, new_finding_id);
  end loop;

  for f in
    select *
    from public.fleet_audit_findings
    where company_id = p_company
      and audit_id = p_audit
      and status in ('open', 'in_progress')
      and checklist_item_id is not null
      and not (id = any (keep_ids))
  loop
    if exists (
      select 1
      from jsonb_array_elements(coalesce(p_data->'responses', '[]'::jsonb)) x
      where (x.value->>'itemId')::uuid = f.checklist_item_id
        and (x.value->>'passed')::boolean is true
    ) then
      update public.fleet_audit_findings
        set status = 'superseded',
            resolution_note = case
              when coalesce(nullif(trim(resolution_note), ''), '') = '' then 'Cleared by audit amendment'
              when resolution_note like '%Cleared by audit amendment%' then resolution_note
              else resolution_note || E'\nCleared by audit amendment'
            end,
            updated_at = now()
      where id = f.id;
    end if;
  end loop;

  perform set_config('fleet.audit_revision', '0', true);

  update public.fleet_audits
    set status = p_data->>'status',
        score = (p_data->>'score')::numeric,
        summary = p_data->>'summary',
        odometer_km = (p_data->>'odometerKm')::numeric,
        revision_draft = '{}'::jsonb,
        revision_count = next_rev,
        revised_at = now(),
        revised_by = p_user,
        updated_at = now(),
        email_status = case when coalesce((p_data->>'sendEmail')::boolean, false) then 'not_sent' else email_status end
  where id = p_audit and company_id = p_company;
end;
$$;

revoke all on function public.fleet_revise_audit_v1(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fleet_revise_audit_v1(uuid, uuid, uuid, jsonb) to service_role;

commit;
