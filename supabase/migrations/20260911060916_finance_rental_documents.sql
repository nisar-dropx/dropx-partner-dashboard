-- Private, immutable versions; attachment writes never change financial values.
create table public.finance_rent_documents (
  id uuid primary key,
  company_id uuid not null,
  rent_id uuid not null references public.finance_rent_master(id),
  file_name text not null check (length(file_name) between 1 and 180),
  content_type text not null check (content_type in ('application/pdf','image/jpeg','image/png')),
  file_size integer not null check (file_size between 1 and 4194304),
  storage_path text not null unique,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_by uuid not null,
  uploaded_at timestamptz not null default now()
);
create index finance_rent_documents_history
  on public.finance_rent_documents(company_id, rent_id, uploaded_at desc, id);
alter table public.finance_rent_documents enable row level security;
revoke all on public.finance_rent_documents from public, anon, authenticated;
grant select, insert on public.finance_rent_documents to service_role;

alter table public.finance_rent_master add column agreement_document_id uuid
  references public.finance_rent_documents(id);
create index finance_rent_master_document on public.finance_rent_master(agreement_document_id)
  where agreement_document_id is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('finance-rental-agreements', 'finance-rental-agreements', false, 4194304,
  array['application/pdf','image/jpeg','image/png']);
-- No browser/anonymous storage policies: only the authorized Finance server handles files.

create function public.finance_attach_rent_document(
  p_company uuid, p_actor uuid, p_rent uuid, p_expected_updated_at timestamptz,
  p_allocation text, p_document jsonb
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  rent_row public.finance_rent_master;
  document_id uuid := (p_document->>'id')::uuid;
  extension text;
begin
  if p_company is null or p_actor is null or document_id is null then
    raise exception 'Invalid rental document.';
  end if;
  select * into rent_row from public.finance_rent_master
  where id = p_rent and company_id = p_company and deleted_at is null for update;
  if not found or rent_row.updated_at is distinct from p_expected_updated_at
    or rent_row.allocation_station_code is distinct from p_allocation then
    raise exception 'Rent changed or was deleted. Refresh and review the latest record.';
  end if;
  extension := case p_document->>'content_type'
    when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' end;
  if extension is null or p_document->>'storage_path' is distinct from
    p_company::text || '/' || p_rent::text || '/' || document_id::text || '.' || extension then
    raise exception 'Invalid rental document path.';
  end if;
  insert into public.finance_rent_documents(id, company_id, rent_id, file_name,
    content_type, file_size, storage_path, sha256, uploaded_by)
  values (document_id, p_company, p_rent, p_document->>'file_name',
    p_document->>'content_type', (p_document->>'file_size')::integer,
    p_document->>'storage_path', p_document->>'sha256', p_actor);
  update public.finance_rent_master
    set agreement_document_id = document_id, updated_at = clock_timestamp(), updated_by = p_actor
    where id = p_rent and company_id = p_company;
  return document_id;
end;
$$;
revoke all on function public.finance_attach_rent_document(uuid,uuid,uuid,timestamptz,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.finance_attach_rent_document(uuid,uuid,uuid,timestamptz,text,jsonb)
  to service_role;
