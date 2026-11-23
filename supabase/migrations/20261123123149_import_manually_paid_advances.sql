begin;
create or replace function public.import_manually_paid_advances(
  p_company uuid, p_actor uuid, p_rows jsonb, p_file_hash text,
  p_locations uuid[], p_commit boolean default false
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare r jsonb; person record; matches integer; day date; principal numeric; recovered numeric;
  reference text; mode text; code text; key text; advance uuid; prepared jsonb := '[]';
  issues jsonb := '[]'; item jsonb; seen text[] := '{}';
begin
  if p_company is null or p_actor is null or jsonb_typeof(p_rows)<>'array'
    or jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'Upload between 1 and 500 advances';
  end if;
  -- Serialize preview/commit with other import commits. No payments are issued.
  perform pg_advisory_xact_lock(hashtextextended('manual-advances:'||p_company::text,0));
  for r in select value from jsonb_array_elements(p_rows) loop
    code := upper(regexp_replace(btrim(r->>'dropxId'),'\s+','','g'));
    day := (r->>'advanceDate')::date;
    principal := (r->>'amount')::numeric;
    recovered := coalesce((r->>'deductedAmount')::numeric,0);
    reference := btrim(coalesce(r->>'reference',''));
    mode := r->>'paymentMode';
    if nullif(code,'') is null or principal is null or principal<=0 or principal<>round(principal,2)
      or principal>999999999999.99 or recovered<0 or recovered>principal or recovered<>round(recovered,2)
      or day is null or day>(now() at time zone 'Asia/Kolkata')::date
      or mode is null or mode not in ('bank_transfer','upi','cash','other') then
      issues := issues || jsonb_build_object('rowNumber',r->'rowNumber','dropxId',code,'message','Check the paid date, amount, deducted amount and payment mode.');
      continue;
    end if;
    -- Workforce is canonical for migrated People profiles sharing the same ID.
    with candidates as (
      select id,'workforce'::text kind,full_name,location_id,0 priority from public.workforce
        where company_id=p_company and upper(btrim(dropx_id))=code
      union all select id,'employee',full_name,location_id,1 from public.employees
        where company_id=p_company and upper(btrim(employee_code))=code
      union all select id,'contractor',full_name,location_id,1 from public.contractors
        where company_id=p_company and upper(btrim(dropx_id))=code
    ) select count(*) into matches from candidates where priority=(select min(priority) from candidates);
    if matches<>1 then
      issues := issues || jsonb_build_object('rowNumber',r->'rowNumber','dropxId',code,'message','DropX ID must match one registered person in your company.'); continue;
    end if;
    select * into person from (
      select id,'workforce'::text kind,full_name,location_id,0 priority from public.workforce where company_id=p_company and upper(btrim(dropx_id))=code
      union all select id,'employee',full_name,location_id,1 from public.employees where company_id=p_company and upper(btrim(employee_code))=code
      union all select id,'contractor',full_name,location_id,1 from public.contractors where company_id=p_company and upper(btrim(dropx_id))=code
    ) people order by priority limit 1;
    if p_locations is not null and (person.location_id is null or not person.location_id=any(p_locations)) then
      issues := issues || jsonb_build_object('rowNumber',r->'rowNumber','dropxId',code,'message','Person is outside your location access.'); continue;
    end if;
    key := 'manual-paid:' || md5(code||'|'||case when reference<>'' then 'ref|'||upper(reference)
      else 'date|'||day::text||'|'||principal::numeric(14,2)::text||'|'||mode end);
    if key=any(seen) or exists(select 1 from public.pay_advances a where a.company_id=p_company
      and (a.source_key=key or ((a.worker_type=person.kind and a.worker_id=person.id or upper(btrim(a.worker_code))=code)
        and ((reference<>'' and upper(btrim(a.bank_reference))=upper(reference)) or
          (reference='' and (a.paid_at at time zone 'Asia/Kolkata')::date=day and a.amount=principal))))) then
      issues := issues || jsonb_build_object('rowNumber',r->'rowNumber','dropxId',code,'message','This paid advance already exists or is repeated in this file.'); continue;
    end if;
    seen := array_append(seen,key);
    prepared := prepared || (r || jsonb_build_object('workerId',person.id,'workerType',person.kind,
      'dropxId',code,'fullName',person.full_name,'stationId',person.location_id,
      'location',coalesce((select station_code from public.stations where id=person.location_id and company_id=p_company),'—'),
      'sourceKey',key,'linkStatus','linked','pendingAmount',principal-recovered));
  end loop;
  if p_commit and jsonb_array_length(issues)=0 then
    for item in select value from jsonb_array_elements(prepared) loop
      insert into public.pay_advances(company_id,worker_type,worker_id,worker_code,amount,paid_at,first_due_period,evidence_type,bank_reference,source_key,provenance)
      values(p_company,item->>'workerType',(item->>'workerId')::uuid,item->>'dropxId',(item->>'amount')::numeric,
        (item->>'advanceDate')::date::timestamp at time zone 'Asia/Kolkata',date_trunc('month',(item->>'advanceDate')::date)::date,
        'legacy_recorded',nullif(item->>'reference',''),item->>'sourceKey',jsonb_build_object(
          'source','manual_paid_bulk_upload','actor_user_id',p_actor,'file_sha256',p_file_hash,
          'source_row',item->'rowNumber','station_id',item->>'stationId','payment_mode',item->>'paymentMode','remark',item->>'remark')) returning id into advance;
      if (item->>'deductedAmount')::numeric>0 then
        insert into public.pay_advance_deductions(company_id,advance_id,target_kind,target_key,period_start,amount,status,source_key,provenance)
        values(p_company,advance,'legacy','opening',date_trunc('month',(item->>'advanceDate')::date)::date,
          (item->>'deductedAmount')::numeric,'confirmed',item->>'sourceKey'||':opening',
          jsonb_build_object('source','manual_paid_bulk_upload','actor_user_id',p_actor,'file_sha256',p_file_hash));
      end if;
    end loop;
  end if;
  return jsonb_build_object('rows',prepared,'issues',issues,'totalRows',jsonb_array_length(p_rows),
    'matchedRows',jsonb_array_length(prepared),'pendingRows',0,'canCommit',jsonb_array_length(issues)=0,
    'importId',case when p_commit and jsonb_array_length(issues)=0 then p_file_hash else null end,
    'message',case when p_commit and jsonb_array_length(issues)=0 then jsonb_array_length(prepared)||' manually paid advances imported.' else null end);
end $$;
revoke all on function public.import_manually_paid_advances(uuid,uuid,jsonb,text,uuid[],boolean) from public,anon,authenticated;
grant execute on function public.import_manually_paid_advances(uuid,uuid,jsonb,text,uuid[],boolean) to service_role;
notify pgrst,'reload schema';
commit;
