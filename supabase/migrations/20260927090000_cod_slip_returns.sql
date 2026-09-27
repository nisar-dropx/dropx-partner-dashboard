-- Return is a request for replacement, never a manual validation override.
alter table public.cod_submissions add column returned_at timestamptz, add column return_reason text, add column returned_by uuid, add column returned_by_name text;
create table public.cod_slip_returns (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 submission_id uuid not null references public.cod_submissions(id), location_id uuid not null references public.stations(id),
 deposit_date date not null, reference text, proof_version integer not null, reason text not null check(length(trim(reason)) between 3 and 300),
 actor_id uuid not null, actor_name text not null, created_at timestamptz not null default now(), resubmitted_at timestamptz,
 mail_status text not null default 'queued' check(mail_status in ('queued','sending','sent','blocked','uncertain')),
 mail_error text, recipients text[], message_id text, mail_started_at timestamptz, mail_sent_at timestamptz, mail_attempts integer not null default 0,
 unique(submission_id,proof_version)
);
create index cod_return_mail_queue on public.cod_slip_returns(mail_status,created_at);
create index cod_return_station_queue on public.cod_slip_returns(company_id,location_id,mail_status);
create table public.cod_return_threads (
 company_id uuid not null references public.companies(id), location_id uuid not null references public.stations(id),
 subject text not null, root_message_id text not null, last_message_id text not null, last_sent_at timestamptz not null default now(),
 primary key(company_id,location_id)
);
alter table public.cod_slip_returns enable row level security;
alter table public.cod_return_threads enable row level security;
revoke all on public.cod_slip_returns,public.cod_return_threads from public,anon,authenticated;
grant select,insert,update on public.cod_slip_returns,public.cod_return_threads to service_role;

create function public.return_cod_slip(p_company uuid,p_submission uuid,p_version integer,p_actor uuid,p_reason text) returns uuid language plpgsql security invoker set search_path=public as $$
declare s public.cod_submissions; actor_label text; result uuid;
begin
 select coalesce(full_name,email) into actor_label from public.profiles where id=p_actor and company_id=p_company and is_active=true and lower(trim(email)) in ('jamsheer@dropxlogistics.com','ct@dropxlogistics.com','tech@dropxlogistics.com');
 if actor_label is null then raise exception 'Return access denied'; end if;
 if length(trim(p_reason)) not between 3 and 300 then raise exception 'Enter a reason (3–300 characters)'; end if;
 select * into s from public.cod_submissions where id=p_submission and company_id=p_company for update;
 if not found then raise exception 'Submission not found'; end if;
 if s.proof_version<>p_version then raise exception 'Slip changed. Refresh and review the latest upload.'; end if;
 if s.returned_at is not null then raise exception 'This slip has already been returned.'; end if;
 if not exists (select 1 from jsonb_array_elements(coalesce(s.deposit_slip_attachments,s.attachments,'[]')) a where a->>'storage_path' is not null) then raise exception 'No uploaded slip to return'; end if;
 insert into public.cod_slip_returns(company_id,submission_id,location_id,deposit_date,reference,proof_version,reason,actor_id,actor_name) values(p_company,s.id,s.location_id,s.deposit_date,coalesce(s.remittance_code,s.reference_no),s.proof_version,trim(p_reason),p_actor,actor_label) returning id into result;
 update public.cod_submissions set returned_at=now(),return_reason=trim(p_reason),returned_by=p_actor,returned_by_name=actor_label where id=s.id;
 insert into public.cod_proof_history(company_id,submission_id,event,actor_id,actor_name,new_values) values(p_company,s.id,'Returned for re-upload',p_actor,actor_label,jsonb_build_object('reason',trim(p_reason),'proof_version',s.proof_version,'return_id',result));
 return result;
end $$;
-- Replacement clears the return only when proof actually changes. Metadata edits and worker results do not.
create function public.cod_return_guard() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if old.returned_at is not null then
  if new.location_id is distinct from old.location_id or new.deposit_date is distinct from old.deposit_date then raise exception 'Keep the original station and deposit date when replacing a returned slip'; end if;
  if coalesce(new.deposit_slip_attachments,new.attachments,'[]') is distinct from coalesce(old.deposit_slip_attachments,old.attachments,'[]') then
   if not exists(select 1 from jsonb_array_elements(coalesce(new.deposit_slip_attachments,new.attachments,'[]')) a where a->>'storage_path' is not null) then raise exception 'Upload replacement proof'; end if;
   update public.cod_slip_returns set resubmitted_at=now() where submission_id=old.id and resubmitted_at is null;
   insert into public.cod_proof_history(company_id,submission_id,event,actor_id,actor_name,new_values) values(new.company_id,new.id,'Returned slip re-uploaded',new.last_updated_by,new.last_updater_name,jsonb_build_object('reason',old.return_reason,'returned_by',old.returned_by_name));
   new.returned_at:=null;new.return_reason:=null;new.returned_by:=null;new.returned_by_name:=null;
  else
   new.returned_at:=old.returned_at;new.return_reason:=old.return_reason;new.returned_by:=old.returned_by;new.returned_by_name:=old.returned_by_name;
  end if;
 end if;
 return new;
end $$;
create trigger cod_return_guard before update on public.cod_submissions for each row execute function public.cod_return_guard();

create function public.claim_cod_return_mail() returns setof public.cod_slip_returns language plpgsql security invoker set search_path=public as $$
declare candidate public.cod_slip_returns;
begin
 update public.cod_slip_returns set mail_status='uncertain',mail_error='Interrupted delivery; verify before retrying' where mail_status='sending' and mail_started_at<now()-interval '10 minutes';
 for candidate in select * from public.cod_slip_returns where mail_status='queued' or (mail_status='blocked' and mail_attempts<5 and mail_started_at<now()-interval '15 minutes') order by created_at for update skip locked loop
  -- Serialize the lifetime station thread, including concurrent cron executions.
  if not pg_try_advisory_xact_lock(hashtextextended(candidate.company_id::text||candidate.location_id::text,0)) then continue; end if;
  if exists(select 1 from public.cod_slip_returns where company_id=candidate.company_id and location_id=candidate.location_id and (mail_status in ('sending','uncertain') or (created_at<candidate.created_at and mail_status in ('queued','blocked')))) then continue; end if;
  return query update public.cod_slip_returns set mail_status='sending',mail_started_at=now(),mail_attempts=mail_attempts+1 where id=candidate.id returning *;
  return;
 end loop;
end $$;
create function public.finish_cod_return_mail(p_id uuid,p_subject text,p_root text,p_message text,p_recipients text[]) returns void language plpgsql security invoker set search_path=public as $$
declare r public.cod_slip_returns;
begin
 select * into r from public.cod_slip_returns where id=p_id and mail_status='sending' for update;
 if not found then raise exception 'Mail receipt no longer claimable'; end if;
 insert into public.cod_return_threads(company_id,location_id,subject,root_message_id,last_message_id) values(r.company_id,r.location_id,p_subject,p_root,p_message)
 on conflict(company_id,location_id) do update set last_message_id=excluded.last_message_id,last_sent_at=now();
 update public.cod_slip_returns set mail_status='sent',mail_sent_at=now(),message_id=p_message,recipients=p_recipients,mail_error=null where id=r.id;
 insert into public.cod_proof_history(company_id,submission_id,event,actor_name,new_values) values(r.company_id,r.submission_id,'Return email sent','OpsPulse',jsonb_build_object('recipients',p_recipients,'reason',r.reason));
end $$;
revoke all on function public.return_cod_slip(uuid,uuid,integer,uuid,text),public.cod_return_guard(),public.claim_cod_return_mail(),public.finish_cod_return_mail(uuid,text,text,text,text[]) from public,anon,authenticated;
grant execute on function public.return_cod_slip(uuid,uuid,integer,uuid,text),public.claim_cod_return_mail(),public.finish_cod_return_mail(uuid,text,text,text,text[]) to service_role;
