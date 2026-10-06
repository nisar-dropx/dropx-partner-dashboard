-- Follow-up history is append-only. Only the authorized Fleet server may write it.
alter table public.fleet_audit_findings add column if not exists responsible_name text;
alter table public.fleet_audit_findings add column if not exists last_update_id uuid;
create table public.fleet_audit_finding_updates (
 id uuid primary key,
 company_id uuid not null references public.companies(id),
 finding_id uuid not null references public.fleet_audit_findings(id),
 actor_id uuid not null references public.profiles(id),
 actor_name text not null,
 status text not null check(status in ('open','in_progress','resolved')),
 note text not null check(length(trim(note)) between 1 and 4000),
 action_required text not null,
 responsible_name text not null,
 due_date date not null,
 severity text not null check(severity in ('low','medium','high','critical')),
 before_state jsonb not null,
 proofs jsonb not null default '[]'::jsonb check(jsonb_typeof(proofs)='array' and jsonb_array_length(proofs)<=10),
 created_at timestamptz not null default clock_timestamp(),
 check(status <> 'resolved' or jsonb_array_length(proofs)>0)
);
create index fleet_finding_updates_lookup on public.fleet_audit_finding_updates(company_id,finding_id,created_at);
create table public.fleet_audit_finding_uploads (
 id uuid primary key,
 company_id uuid not null references public.companies(id),
 finding_id uuid not null references public.fleet_audit_findings(id),
 actor_id uuid not null references public.profiles(id),
 storage_path text not null unique,
 media_type text not null check(media_type in ('photo','document')),
 caption text not null,
 update_id uuid references public.fleet_audit_finding_updates(id),
 created_at timestamptz not null default now()
);
create index fleet_finding_uploads_lookup on public.fleet_audit_finding_uploads(company_id,finding_id);
create index fleet_finding_uploads_event on public.fleet_audit_finding_uploads(update_id);
alter table public.fleet_audit_finding_updates enable row level security;
alter table public.fleet_audit_finding_uploads enable row level security;
revoke all on public.fleet_audit_finding_updates, public.fleet_audit_finding_uploads from anon,authenticated;
grant select,insert on public.fleet_audit_finding_updates to service_role;
grant select,insert,update on public.fleet_audit_finding_uploads to service_role;

create function public.fleet_finding_history_immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'Finding history cannot be changed or deleted.'; end $$;
create trigger fleet_finding_history_immutable before update or delete on public.fleet_audit_finding_updates for each row execute function public.fleet_finding_history_immutable();

-- Prevent the old note-only endpoint (or any direct update) bypassing proof/history.
create function public.fleet_finding_update_guard() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if row(new.status,new.resolution_note,new.action_required,new.expected_completion_date,new.severity,new.responsible_name,new.resolved_at,new.owner_user_id)
    is distinct from row(old.status,old.resolution_note,old.action_required,old.expected_completion_date,old.severity,old.responsible_name,old.resolved_at,old.owner_user_id) then
  if new.last_update_id is null or new.last_update_id is not distinct from old.last_update_id or not exists (
   select 1 from public.fleet_audit_finding_updates u where u.id=new.last_update_id and u.finding_id=new.id and u.company_id=new.company_id
    and u.status=new.status and u.note=new.resolution_note and u.action_required=new.action_required and u.due_date=new.expected_completion_date
    and u.severity=new.severity and u.responsible_name=new.responsible_name
    and (new.status<>'resolved' or jsonb_array_length(u.proofs)>0)
  ) then raise exception 'Use the audit action tracker. Closure requires uploaded proof and a recorded update.'; end if;
 end if;
 return new;
end $$;
create trigger fleet_finding_update_guard before update on public.fleet_audit_findings for each row execute function public.fleet_finding_update_guard();

create function public.fleet_save_finding_update(p_company uuid,p_finding uuid,p_actor uuid,p_event uuid,p_expected timestamptz,p_status text,p_note text,p_action text,p_owner text,p_due date,p_severity text,p_uploads uuid[])
returns uuid language plpgsql security invoker set search_path='' as $$
declare f public.fleet_audit_findings%rowtype; v_proofs jsonb; v_actor text; v_time timestamptz; n integer;
begin
 select * into f from public.fleet_audit_findings where id=p_finding and company_id=p_company for update;
 if not found then raise exception 'Finding not found.'; end if;
 select coalesce(full_name,'Fleet user') into v_actor from public.profiles where id=p_actor and company_id=p_company;
 if not found then raise exception 'Actor is outside this company.'; end if;
 if exists(select 1 from public.fleet_audit_finding_updates where id=p_event and finding_id=p_finding and company_id=p_company and actor_id=p_actor) then return p_event; end if;
 if p_expected is null or f.updated_at is distinct from p_expected then raise exception 'This action changed. Reload the report before saving.'; end if;
 if p_event is null or p_status is null or p_status not in ('open','in_progress','resolved') or p_severity is null or p_severity not in ('low','medium','high','critical') then raise exception 'Choose a valid status and priority.'; end if;
 if coalesce(length(trim(p_note)),0) not between 1 and 4000 or coalesce(length(trim(p_action)),0) not between 1 and 2000 or coalesce(length(trim(p_owner)),0) not between 1 and 160 or p_due is null then raise exception 'Action, responsible person, due date and update remarks are required.'; end if;
 n:=coalesce(cardinality(p_uploads),0);
 if n>10 or n<>(select count(distinct x) from unnest(p_uploads) x) then raise exception 'Choose up to 10 distinct proof files.'; end if;
 if p_status='resolved' and n=0 then raise exception 'Upload closure proof before resolving this action.'; end if;
 -- Lock uploads too; files must be fresh uploads by this actor for this finding.
 perform 1 from public.fleet_audit_finding_uploads where id=any(p_uploads) order by id for update;
 if n<>(select count(*) from public.fleet_audit_finding_uploads u where u.id=any(p_uploads) and u.company_id=p_company and u.finding_id=p_finding and u.actor_id=p_actor and u.update_id is null
   and u.storage_path like p_company::text||'/audits/'||f.audit_id::text||'/%'
   and exists(select 1 from storage.objects o where o.bucket_id='fleet-documents' and o.name=u.storage_path)) then raise exception 'Proof is missing or belongs to another action. Upload it again.'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'path',storage_path,'type',media_type,'caption',caption) order by created_at),'[]'::jsonb) into v_proofs from public.fleet_audit_finding_uploads where id=any(p_uploads);
 v_time:=clock_timestamp();
 insert into public.fleet_audit_finding_updates(id,company_id,finding_id,actor_id,actor_name,status,note,action_required,responsible_name,due_date,severity,before_state,proofs,created_at)
 values(p_event,p_company,p_finding,p_actor,v_actor,p_status,trim(p_note),trim(p_action),trim(p_owner),p_due,p_severity,to_jsonb(f),v_proofs,v_time);
 update public.fleet_audit_finding_uploads set update_id=p_event where id=any(p_uploads);
 update public.fleet_audit_findings set status=p_status,resolution_note=trim(p_note),action_required=trim(p_action),responsible_name=trim(p_owner),expected_completion_date=p_due,severity=p_severity,
 resolved_at=case when p_status='resolved' then coalesce(f.resolved_at,v_time) else null end,updated_at=v_time,last_update_id=p_event where id=p_finding and company_id=p_company;
 return p_event;
end $$;
revoke all on function public.fleet_finding_history_immutable(),public.fleet_finding_update_guard(),public.fleet_save_finding_update(uuid,uuid,uuid,uuid,timestamptz,text,text,text,text,date,text,uuid[]) from public,anon,authenticated;
grant execute on function public.fleet_save_finding_update(uuid,uuid,uuid,uuid,timestamptz,text,text,text,text,date,text,uuid[]) to service_role;
