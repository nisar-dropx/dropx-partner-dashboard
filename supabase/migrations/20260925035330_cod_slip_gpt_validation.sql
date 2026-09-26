-- Automated slip checks. No human approval fields or workflow.
-- COD writes use company/location-authorized server actions; clients cannot forge results.
revoke insert,update,delete on public.cod_submissions from anon,authenticated;
alter table public.cod_submissions
 add column proof_version integer not null default 1,
 add column proof_check_token uuid,
 add column proof_check_started_at timestamptz,
 add column proof_checked_at timestamptz,
 add column proof_check_attempts integer not null default 0,
 add column last_updated_by uuid,
 add column last_updater_name text;
create table public.cod_daily_exceptions (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 location_id uuid not null references public.stations(id),
 report_date date not null,
 kind text not null check(kind in ('Banker Not Reported','No Cash')),
 reason text not null check(length(trim(reason)) between 3 and 2000),
 email_subject text,
 sender_email text,
 stakeholder_emails text[] not null default '{}',
 client_poc_emails text[] not null default '{}',
 email_cc text[] not null default '{}',
 email_sent_at timestamptz,
 email_check_status text not null default 'Not applicable',
 email_check_reason text,
 email_message_id text,
 email_checked_at timestamptz,
 proof jsonb,
 created_by uuid not null,
 updated_by uuid not null,
 updater_name text not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 version integer not null default 1,
 unique(company_id,location_id,report_date),
 check(coalesce((kind='No Cash' and proof->>'storage_path' is not null and proof->>'storage_bucket'='ops-pulse-documents' and proof->>'storage_path' like company_id::text||'/%') or
 (kind='Banker Not Reported' and length(trim(email_subject)) between 3 and 250 and sender_email is not null and email_sent_at is not null and cardinality(stakeholder_emails)>0 and cardinality(client_poc_emails)>0 and 'cd@dropxlogistics.com'=any(email_cc)),false))
);
create table public.cod_proof_history (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 submission_id uuid references public.cod_submissions(id),
 exception_id uuid references public.cod_daily_exceptions(id),
 event text not null,actor_id uuid,actor_name text,
 created_at timestamptz not null default now(),
 old_values jsonb,new_values jsonb not null,
 check(num_nonnulls(submission_id,exception_id)=1)
);
create index cod_proof_history_submission on public.cod_proof_history(company_id,submission_id,created_at);
create index cod_proof_history_exception on public.cod_proof_history(company_id,exception_id,created_at);
create index cod_proof_queue on public.cod_submissions(ai_status,created_at);
alter table public.cod_daily_exceptions enable row level security;
alter table public.cod_proof_history enable row level security;
revoke all on public.cod_daily_exceptions,public.cod_proof_history from public,anon,authenticated;
grant select,insert,update on public.cod_daily_exceptions to service_role;
grant select,insert on public.cod_proof_history to service_role;

create function public.cod_proof_snapshot(s public.cod_submissions) returns jsonb language sql immutable security invoker set search_path=public as $$
 select jsonb_build_object('location_id',s.location_id,'deposit_date',s.deposit_date,'cod_period_from',s.cod_period_from,'cod_period_to',s.cod_period_to,'station_code',s.station_code,'remittance_code',s.remittance_code,'reference_no',s.reference_no,'deposited_amount',s.deposited_amount,'submitter_name',s.submitter_name,'remarks',s.remarks,'attachments',s.attachments,'deposit_slip_attachments',s.deposit_slip_attachments);
$$;
revoke all on function public.cod_proof_snapshot(public.cod_submissions) from public,anon,authenticated;
grant execute on function public.cod_proof_snapshot(public.cod_submissions) to service_role;
create function public.cod_proof_guard() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if TG_OP='INSERT' then
  new.ai_status:='Validation pending';new.ai_summary:=null;new.ai_result:='{}';new.proof_version:=1;new.proof_check_attempts:=0;new.proof_check_token:=null;new.proof_checked_at:=null;
 elsif public.cod_proof_snapshot(old) is distinct from public.cod_proof_snapshot(new) then
  new.ai_status:='Validation pending';new.ai_summary:=null;new.ai_result:='{}';new.ai_confidence:=null;
  new.proof_version:=old.proof_version+1;new.proof_check_attempts:=0;new.proof_check_token:=null;new.proof_checked_at:=null;new.proof_check_started_at:=null;
 end if;
 return new;
end $$;
revoke all on function public.cod_proof_guard() from public,anon,authenticated;
create trigger cod_proof_guard before insert or update on public.cod_submissions for each row execute function public.cod_proof_guard();
create function public.cod_proof_audit() returns trigger language plpgsql security invoker set search_path=public as $$
declare event_name text; before_values jsonb; actor uuid; actor_label text;
begin
 if TG_OP='INSERT' then event_name:='Uploaded';actor:=new.created_by;actor_label:=new.last_updater_name;
 elsif public.cod_proof_snapshot(old) is distinct from public.cod_proof_snapshot(new) then event_name:='Submission updated';actor:=new.last_updated_by;actor_label:=new.last_updater_name;
 elsif row(new.ai_status,new.ai_summary) is distinct from row(old.ai_status,old.ai_summary) and new.ai_status<>'Checking' then event_name:='Validation completed';actor_label:='Automatic validation';
 else return new;end if;
 if TG_OP='UPDATE' then before_values:=public.cod_proof_snapshot(old)||jsonb_build_object('validation',old.ai_status,'reason',old.ai_summary);end if;
 insert into public.cod_proof_history(company_id,submission_id,event,actor_id,actor_name,old_values,new_values)
 values(new.company_id,new.id,event_name,actor,actor_label,before_values,public.cod_proof_snapshot(new)||jsonb_build_object('validation',new.ai_status,'reason',new.ai_summary));
 return new;
end $$;
revoke all on function public.cod_proof_audit() from public,anon,authenticated;
create trigger cod_proof_audit after insert or update on public.cod_submissions for each row execute function public.cod_proof_audit();
create function public.cod_exception_audit() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if TG_OP='UPDATE' and (to_jsonb(old)-'email_checked_at') is not distinct from (to_jsonb(new)-'email_checked_at') then return new;end if;
 insert into public.cod_proof_history(company_id,exception_id,event,actor_id,actor_name,old_values,new_values)
 values(new.company_id,new.id,case when TG_OP='INSERT' then 'Daily update recorded' when old.email_check_status is distinct from new.email_check_status then 'Email verification updated' else 'Daily update amended' end,case when TG_OP='UPDATE' and old.version=new.version then null else new.updated_by end,case when TG_OP='UPDATE' and old.version=new.version then 'Automatic mailbox check' else new.updater_name end,case when TG_OP='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));
 return new;
end $$;
revoke all on function public.cod_exception_audit() from public,anon,authenticated;
create trigger cod_exception_audit after insert or update on public.cod_daily_exceptions for each row execute function public.cod_exception_audit();
-- Do not invent historical edits. Retain an explicit baseline.
insert into public.cod_proof_history(company_id,submission_id,event,actor_id,actor_name,new_values)
 select s.company_id,s.id,'Existing submission — history tracking started',s.created_by,p.full_name,public.cod_proof_snapshot(s)||jsonb_build_object('original_uploaded_at',s.created_at) from public.cod_submissions s left join public.profiles p on p.id=s.created_by;
update public.cod_submissions set ai_status='Validation pending',ai_summary=null,ai_result='{}';

create function public.claim_cod_proof_check() returns setof public.cod_submissions language plpgsql security invoker set search_path=public as $$
begin
 return query with candidate as (
 select id from public.cod_submissions where ai_status='Validation pending'
 or (ai_status='Validation unavailable' and proof_check_attempts<3 and proof_check_started_at<now()-interval '15 minutes')
 or (ai_status='Checking' and proof_check_started_at<now()-interval '5 minutes')
 order by created_at desc for update skip locked limit 1)
 update public.cod_submissions s set ai_status='Checking',proof_check_token=gen_random_uuid(),proof_check_started_at=now(),proof_check_attempts=s.proof_check_attempts+1
 from candidate c where s.id=c.id returning s.*;
end $$;
revoke all on function public.claim_cod_proof_check() from public,anon,authenticated;
grant execute on function public.claim_cod_proof_check() to service_role;
