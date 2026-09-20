-- Workforce associates receive only documents issued against their own Workforce profile.
-- Requests remain in the Workforce support flow; this migration deliberately does not
-- route those confidential conversations through People & Culture.
alter table public.hr_worker_documents
  drop constraint if exists hr_worker_documents_worker_type_check;
alter table public.hr_worker_documents
  add constraint hr_worker_documents_worker_type_check
  check (worker_type = any (array['employee'::text, 'contractor'::text, 'workforce'::text]));

alter table public.hr_document_request_types
  drop constraint if exists hr_document_request_types_worker_types_check;
alter table public.hr_document_request_types
  add constraint hr_document_request_types_worker_types_check
  check (cardinality(worker_types) between 1 and 3 and worker_types <@ array['employee'::text, 'contractor'::text, 'workforce'::text]);

create index if not exists hr_worker_documents_workforce_lookup_idx
  on public.hr_worker_documents (company_id, worker_id, published_at desc)
  where worker_type = 'workforce' and revoked_at is null;
