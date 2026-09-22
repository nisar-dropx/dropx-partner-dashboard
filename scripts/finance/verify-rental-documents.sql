begin;
do $$
declare
  company uuid := gen_random_uuid();
  actor uuid := gen_random_uuid();
  rent_id uuid := gen_random_uuid();
  first_id uuid := gen_random_uuid();
  second_id uuid := gen_random_uuid();
  before_row public.finance_rent_master;
  after_row public.finance_rent_master;
  stamp timestamptz;
  item jsonb;
  denied boolean;
begin
  insert into public.finance_rent_master(id, company_id, site_code, allocation_station_code,
    payee_name, monthly_rent, monthly_maintenance, effective_from, change_reason, updated_by)
  values (rent_id, company, 'RENT-DOC-TEST', 'TEST', 'Rollback-only test', 123.45, 6.78,
    '2026-09-01', 'Rollback-only verification', actor) returning * into before_row;
  item := jsonb_build_object('id',first_id,'file_name','lease.pdf','content_type','application/pdf',
    'file_size',100,'storage_path',company::text||'/'||rent_id::text||'/'||first_id::text||'.pdf','sha256',repeat('a',64));
  perform public.finance_attach_rent_document(company,actor,rent_id,before_row.updated_at,'TEST',item);
  select * into after_row from public.finance_rent_master where id=rent_id;
  assert after_row.agreement_document_id=first_id, 'Attachment not linked';
  assert after_row.monthly_rent=before_row.monthly_rent and after_row.monthly_maintenance=before_row.monthly_maintenance,
    'Financial amounts changed';
  stamp := after_row.updated_at;
  denied := false;
  begin
    perform public.finance_attach_rent_document(company,actor,rent_id,before_row.updated_at,'TEST',item);
  exception when others then denied := true; end;
  assert denied, 'Stale update allowed';
  denied := false;
  begin
    perform public.finance_attach_rent_document(gen_random_uuid(),actor,rent_id,stamp,'TEST',item);
  exception when others then denied := true; end;
  assert denied, 'Cross-company update allowed';
  denied := false;
  begin
    perform public.finance_attach_rent_document(company,actor,rent_id,stamp,'OTHER',item);
  exception when others then denied := true; end;
  assert denied, 'Concurrent allocation change allowed';
  denied := false;
  begin
    perform public.finance_attach_rent_document(company,actor,rent_id,stamp,'TEST',item||jsonb_build_object('storage_path','other/file.pdf'));
  exception when others then denied := true; end;
  assert denied, 'Foreign file path allowed';
  item := item || jsonb_build_object('id',second_id,'storage_path',company::text||'/'||rent_id::text||'/'||second_id::text||'.pdf');
  denied := false;
  begin
    perform public.finance_attach_rent_document(company,actor,rent_id,stamp,'TEST',item||jsonb_build_object('file_size',4194305));
  exception when check_violation then denied := true; end;
  assert denied, 'Oversized document allowed';
  perform public.finance_attach_rent_document(company,actor,rent_id,stamp,'TEST',item);
  assert (select count(*)=2 from public.finance_rent_documents d where d.rent_id=before_row.id and d.company_id=company), 'Previous version lost';
  assert (select agreement_document_id=second_id from public.finance_rent_master where id=rent_id), 'Replacement not current';
  assert (select count(*)=2 from public.finance_rent_audit where company_id=company), 'Attachment audit missing';
  select updated_at into stamp from public.finance_rent_master where id=rent_id;
  update public.finance_rent_master set deleted_at=now() where id=rent_id;
  denied := false;
  begin
    perform public.finance_attach_rent_document(company,actor,rent_id,stamp,'TEST',item);
  exception when others then denied := true; end;
  assert denied, 'Deleted agreement accepted upload';
  assert not has_table_privilege('authenticated','public.finance_rent_documents','SELECT'), 'Authenticated data exposure';
  assert not has_function_privilege('anon','public.finance_attach_rent_document(uuid,uuid,uuid,timestamptz,text,jsonb)','EXECUTE'), 'Anonymous RPC exposure';
  assert not has_function_privilege('authenticated','public.finance_attach_rent_document(uuid,uuid,uuid,timestamptz,text,jsonb)','EXECUTE'), 'Authenticated RPC exposure';
  assert (select not public from storage.buckets where id='finance-rental-agreements'), 'Bucket is public';
end;
$$;
rollback;
