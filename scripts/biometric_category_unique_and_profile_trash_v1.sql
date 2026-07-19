-- Allows the same biometric enrolment ID to exist once per worker category.
-- Employees stay unique inside employees; field executives stay unique inside field executives.

drop index if exists public.biometric_enrolments_company_enrolment_active_uidx;

create unique index if not exists biometric_enrolments_company_type_enrolment_active_uidx
  on public.biometric_enrolments(company_id, worker_type, enrolment_id)
  where effective_to is null;

create table if not exists public.profile_document_trash (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  owner_type text not null check (owner_type in ('employee', 'field_executive')),
  owner_id uuid not null,
  document_label text not null,
  file_name text,
  content_type text,
  file_size bigint,
  storage_bucket text not null default 'employee-profile-documents',
  storage_path text not null,
  replaced_by uuid,
  replaced_at timestamptz not null default now(),
  delete_after timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists profile_document_trash_company_delete_after_idx
  on public.profile_document_trash(company_id, delete_after);

alter table public.profile_document_trash enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profile_document_trash'
      and policyname = 'service_role_profile_document_trash_all'
  ) then
    create policy "service_role_profile_document_trash_all"
      on public.profile_document_trash
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;
end $$;

