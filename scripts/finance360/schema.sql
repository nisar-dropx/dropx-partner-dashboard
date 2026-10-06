-- Isolated accounting workspace. Existing operational/payment tables are not changed.
create table public.finance360_books (
 company_id uuid primary key references public.companies(id),
 locked_through date, coverage_from date, coverage_through date,
 updated_at timestamptz not null default now(), check (coverage_from <= coverage_through)
);
create table public.finance360_imports (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 kind text not null check(kind in ('journal','bank','loan','manual','reversal')),
 filename text not null, sha256 text not null, created_by uuid not null, created_at timestamptz not null default now(),
 unique(company_id,sha256), unique(company_id,id)
);
create table public.finance360_accounts (
 company_id uuid not null references public.companies(id), code text not null check(length(code) between 1 and 80),
 name text not null check(length(name) between 1 and 200), type text not null check(type in ('asset','liability','equity','income','expense')),
 primary key(company_id,code)
);
create table public.finance360_journals (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 reference text not null check(length(reference) between 1 and 150), date date not null,
 narration text not null check(length(narration) between 1 and 1000), import_id uuid not null,
 insert_txid bigint not null default txid_current(), reversal_of uuid, created_by uuid not null, created_at timestamptz not null default now(),
 unique(company_id,reference), unique(company_id,id), unique(reversal_of),
 foreign key(company_id,import_id) references public.finance360_imports(company_id,id),
 foreign key(company_id,reversal_of) references public.finance360_journals(company_id,id)
);
create index finance360_journals_date on public.finance360_journals(company_id,date,id);
create index finance360_journals_import on public.finance360_journals(company_id,import_id);
create table public.finance360_lines (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, journal_id uuid not null, account_code text not null,
 debit numeric(18,2) not null default 0, credit numeric(18,2) not null default 0,
 check((debit > 0 and credit = 0) or (credit > 0 and debit = 0)),
 foreign key(company_id,journal_id) references public.finance360_journals(company_id,id),
 foreign key(company_id,account_code) references public.finance360_accounts(company_id,code), unique(company_id,id)
);
create index finance360_lines_journal on public.finance360_lines(company_id,journal_id);
create index finance360_lines_account on public.finance360_lines(company_id,account_code,journal_id);
create table public.finance360_bank_statements (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, import_id uuid not null,
 account_code text not null, period_start date not null, period_end date not null, opening numeric(18,2) not null, closing numeric(18,2) not null,
 check(period_start <= period_end), unique(company_id,id), unique(import_id),
 foreign key(company_id,account_code) references public.finance360_accounts(company_id,code),
 foreign key(company_id,import_id) references public.finance360_imports(company_id,id)
);
create index finance360_bank_period on public.finance360_bank_statements(company_id,account_code,period_start,period_end);
create table public.finance360_bank_rows (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, statement_id uuid not null, row_number int not null,
 date date not null, description text not null, reference text not null default '', debit numeric(18,2) not null, credit numeric(18,2) not null, balance numeric(18,2) not null,
 matched_line_id uuid unique, matched_by uuid, matched_at timestamptz,
 check((debit > 0 and credit = 0) or (credit > 0 and debit = 0)),
 foreign key(company_id,statement_id) references public.finance360_bank_statements(company_id,id),
 foreign key(company_id,matched_line_id) references public.finance360_lines(company_id,id), unique(statement_id,row_number)
);
create index finance360_bank_rows_scope on public.finance360_bank_rows(company_id,statement_id,row_number);
create table public.finance360_loans (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, import_id uuid not null,
 facility text not null, lender text not null, account_code text not null, as_of date not null,
 principal numeric(18,2) not null check(principal >= 0), interest_due numeric(18,2) not null check(interest_due >= 0),
 emi numeric(18,2) not null check(emi >= 0), next_due date, note text not null, created_at timestamptz not null default now(),
 foreign key(company_id,import_id) references public.finance360_imports(company_id,id),
 foreign key(company_id,account_code) references public.finance360_accounts(company_id,code)
);
create index finance360_loans_asof on public.finance360_loans(company_id,as_of,facility);
create index finance360_loans_account on public.finance360_loans(company_id,account_code);
create index finance360_loans_import on public.finance360_loans(company_id,import_id);
create table public.finance360_audit (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id), actor_id uuid not null,
 action text not null, detail jsonb not null, created_at timestamptz not null default now()
);
create index finance360_audit_time on public.finance360_audit(company_id,created_at desc);
-- Fail closed: all access is through authenticated, company-scoped server code.
do $$ declare t text; begin foreach t in array array['books','imports','accounts','journals','lines','bank_statements','bank_rows','loans','audit'] loop
 execute format('alter table public.%I enable row level security','finance360_'||t);
 execute format('revoke all on public.%I from anon, authenticated','finance360_'||t);
 execute format('grant select,insert,update on public.%I to service_role','finance360_'||t);
end loop; end $$;
create function public.finance360_immutable() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Posted accounting records are immutable. Use a reversal.'; end $$;
create trigger finance360_journals_immutable before update or delete on public.finance360_journals for each row execute function public.finance360_immutable();
create trigger finance360_lines_immutable before update or delete on public.finance360_lines for each row execute function public.finance360_immutable();
create trigger finance360_accounts_immutable before update or delete on public.finance360_accounts for each row execute function public.finance360_immutable();
create trigger finance360_imports_immutable before update or delete on public.finance360_imports for each row execute function public.finance360_immutable();
create trigger finance360_loans_immutable before update or delete on public.finance360_loans for each row execute function public.finance360_immutable();
create trigger finance360_audit_immutable before update or delete on public.finance360_audit for each row execute function public.finance360_immutable();
create trigger finance360_statements_immutable before update or delete on public.finance360_bank_statements for each row execute function public.finance360_immutable();
create function public.finance360_line_insert() returns trigger language plpgsql set search_path='' as $$ begin
 if not exists(select 1 from public.finance360_journals where company_id=new.company_id and id=new.journal_id and insert_txid=txid_current()) then raise exception 'Cannot append to a posted voucher'; end if;
 return new;
end $$;
create trigger finance360_line_insert before insert on public.finance360_lines for each row execute function public.finance360_line_insert();
-- Deferred constraints enforce balanced vouchers even if a future writer bypasses the RPC.
create function public.finance360_check_balance() returns trigger language plpgsql set search_path='' as $$
declare target uuid; n bigint; d numeric; c numeric;
begin
 if tg_table_name='finance360_journals' then target:=new.id; else target:=new.journal_id; end if;
 select count(*),coalesce(sum(debit),0),coalesce(sum(credit),0) into n,d,c from public.finance360_lines where company_id=new.company_id and journal_id=target;
 if n < 2 or d <> c then raise exception 'Voucher must have at least two balanced lines'; end if;
 return null;
end $$;
create constraint trigger finance360_journal_balanced after insert on public.finance360_journals deferrable initially deferred for each row execute function public.finance360_check_balance();
create constraint trigger finance360_lines_balanced after insert on public.finance360_lines deferrable initially deferred for each row execute function public.finance360_check_balance();
create function public.finance360_write(p_company uuid,p_actor uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare imp uuid; j uuid; v jsonb; l jsonb; acc public.finance360_accounts; b public.finance360_books; st uuid; idx int:=0; running numeric; previous date; original public.finance360_journals; rowdata public.finance360_bank_rows; line public.finance360_lines; result jsonb;
begin
 insert into public.finance360_books(company_id) values(p_company) on conflict do nothing;
 select * into strict b from public.finance360_books where company_id=p_company for update;
 if p_action in ('journal','manual','bank','loan','reversal') then
   insert into public.finance360_imports(company_id,kind,filename,sha256,created_by) values(p_company,p_action,p_data->>'filename',p_data->>'sha256',p_actor) returning id into imp;
 end if;
 if p_action='account' then
 insert into public.finance360_accounts(company_id,code,name,type) values(p_company,p_data->>'code',p_data->>'name',p_data->>'type');
 elsif p_action in ('journal','manual') then
   if jsonb_array_length(p_data->'vouchers') not between 1 and 2500 then raise exception 'Invalid voucher count'; end if;
   for v in select value from jsonb_array_elements(p_data->'vouchers') loop
     if (v->>'date')::date <= b.locked_through then raise exception 'Period is locked'; end if;
     insert into public.finance360_journals(company_id,reference,date,narration,import_id,created_by) values(p_company,v->>'reference',(v->>'date')::date,v->>'narration',imp,p_actor) returning id into j;
     for l in select value from jsonb_array_elements(v->'lines') loop
       insert into public.finance360_accounts(company_id,code,name,type) values(p_company,l->>'code',l->>'name',l->>'type') on conflict do nothing;
       select * into strict acc from public.finance360_accounts where company_id=p_company and code=l->>'code';
       if acc.name <> l->>'name' or acc.type <> l->>'type' then raise exception 'Account % conflicts with the existing chart',acc.code; end if;
       insert into public.finance360_lines(company_id,journal_id,account_code,debit,credit) values(p_company,j,acc.code,(l->>'debit')::numeric,(l->>'credit')::numeric);
     end loop;
     idx:=idx+1;
   end loop;
 elsif p_action='bank' then
   if (p_data->>'start')::date > (p_data->>'end')::date then raise exception 'Invalid statement period'; end if;
   if exists(select 1 from public.finance360_bank_statements where company_id=p_company and account_code=p_data->>'account_code' and period_start <= (p_data->>'end')::date and period_end >= (p_data->>'start')::date) then raise exception 'Statement overlaps an imported period. Upload only dates not already imported.'; end if;
   if exists(select 1 from public.finance360_bank_statements where company_id=p_company and account_code=p_data->>'account_code' and ((period_end=(p_data->>'start')::date-1 and closing<>(p_data->>'opening')::numeric) or (period_start=(p_data->>'end')::date+1 and opening<>(p_data->>'closing')::numeric))) then raise exception 'Balance does not join to the adjacent imported statement'; end if;
   if not exists(select 1 from public.finance360_accounts where company_id=p_company and code=p_data->>'account_code' and type in ('asset','liability')) then raise exception 'Select an existing bank asset or overdraft liability ledger'; end if;
   insert into public.finance360_bank_statements(company_id,import_id,account_code,period_start,period_end,opening,closing) values(p_company,imp,p_data->>'account_code',(p_data->>'start')::date,(p_data->>'end')::date,(p_data->>'opening')::numeric,(p_data->>'closing')::numeric) returning id into st;
   running:=(p_data->>'opening')::numeric; previous:=(p_data->>'start')::date;
   if jsonb_array_length(p_data->'rows') not between 1 and 5000 then raise exception 'Invalid transaction count'; end if;
   for v in select value from jsonb_array_elements(p_data->'rows') loop
     if (v->>'date')::date < previous or (v->>'date')::date > (p_data->>'end')::date then raise exception 'Invalid transaction date order'; end if;
     previous:=(v->>'date')::date; idx:=idx+1; running:=running+(v->>'credit')::numeric-(v->>'debit')::numeric;
     if running <> (v->>'balance')::numeric then raise exception 'Statement running balance mismatch'; end if;
     insert into public.finance360_bank_rows(company_id,statement_id,row_number,date,description,reference,debit,credit,balance) values(p_company,st,idx,previous,v->>'description',v->>'reference',(v->>'debit')::numeric,(v->>'credit')::numeric,running);
   end loop;
   if running <> (p_data->>'closing')::numeric then raise exception 'Statement closing balance mismatch'; end if;
 elsif p_action='loan' then
   if not exists(select 1 from public.finance360_accounts where company_id=p_company and code=p_data->>'account_code' and type='liability') then raise exception 'Select an existing liability ledger'; end if;
   insert into public.finance360_loans(company_id,import_id,facility,lender,account_code,as_of,principal,interest_due,emi,next_due,note)
   values(p_company,imp,p_data->>'facility',p_data->>'lender',p_data->>'account_code',(p_data->>'as_of')::date,(p_data->>'principal')::numeric,(p_data->>'interest_due')::numeric,(p_data->>'emi')::numeric,nullif(p_data->>'next_due','')::date,p_data->>'note');
 elsif p_action='reversal' then
   select * into strict original from public.finance360_journals where company_id=p_company and id=(p_data->>'journal_id')::uuid;
   if (p_data->>'date')::date <= b.locked_through or (p_data->>'date')::date < original.date then raise exception 'Reversal date must be in an open period, on or after original'; end if;
   insert into public.finance360_journals(company_id,reference,date,narration,import_id,reversal_of,created_by) values(p_company,p_data->>'reference',(p_data->>'date')::date,p_data->>'narration',imp,original.id,p_actor) returning id into j;
   insert into public.finance360_lines(company_id,journal_id,account_code,debit,credit) select company_id,j,account_code,credit,debit from public.finance360_lines where company_id=p_company and journal_id=original.id;
 update public.finance360_bank_rows set matched_line_id=null,matched_by=null,matched_at=null where company_id=p_company and matched_line_id in (select id from public.finance360_lines where company_id=p_company and journal_id=original.id);
 elsif p_action='match' then
   select * into strict rowdata from public.finance360_bank_rows where company_id=p_company and id=(p_data->>'row_id')::uuid for update;
   select * into strict line from public.finance360_lines where company_id=p_company and id=(p_data->>'line_id')::uuid;
   if rowdata.matched_line_id is not null then raise exception 'Transaction is already reconciled'; end if;
   if exists(select 1 from public.finance360_journals where company_id=p_company and (reversal_of=line.journal_id or (id=line.journal_id and reversal_of is not null))) then raise exception 'Reversed vouchers cannot be matched'; end if;
   if line.debit <> rowdata.credit or line.credit <> rowdata.debit or not exists(select 1 from public.finance360_bank_statements where company_id=p_company and id=rowdata.statement_id and account_code=line.account_code) then raise exception 'Match must use the same bank ledger, amount and direction'; end if;
   update public.finance360_bank_rows set matched_line_id=line.id,matched_by=p_actor,matched_at=now() where company_id=p_company and id=rowdata.id;
 elsif p_action='unmatch' then
   update public.finance360_bank_rows set matched_line_id=null,matched_by=null,matched_at=null where company_id=p_company and id=(p_data->>'row_id')::uuid;
 elsif p_action='lock' then
   if b.locked_through is not null and (p_data->>'date')::date < b.locked_through then raise exception 'A locked period cannot be reopened here'; end if;
   update public.finance360_books set locked_through=(p_data->>'date')::date,updated_at=now() where company_id=p_company;
 elsif p_action='coverage' then
   update public.finance360_books set coverage_from=(p_data->>'start')::date,coverage_through=(p_data->>'end')::date,updated_at=now() where company_id=p_company;
 else raise exception 'Unknown accounting action';
 end if;
 if p_action in ('journal','manual','reversal') and b.coverage_through is not null and exists(select 1 from public.finance360_journals where company_id=p_company and import_id=imp and date<=b.coverage_through) then
 update public.finance360_books set coverage_from=null,coverage_through=null,updated_at=now() where company_id=p_company;
 end if;
 result:=jsonb_build_object('import_id',imp,'count',idx);
 insert into public.finance360_audit(company_id,actor_id,action,detail) values(p_company,p_actor,p_action,(p_data-'vouchers'-'rows') || result);
 return result;
end $$;
create function public.finance360_trial(p_company uuid,p_start date,p_end date)
returns table(code text,name text,type text,opening text,debit text,credit text,closing text)
language sql stable security invoker set search_path='' as $$
 select a.code,a.name,a.type,
 coalesce(sum(l.debit-l.credit) filter(where j.date < p_start),0)::text,
 coalesce(sum(l.debit) filter(where j.date between p_start and p_end),0)::text,
 coalesce(sum(l.credit) filter(where j.date between p_start and p_end),0)::text,
 coalesce(sum(l.debit-l.credit),0)::text
 from public.finance360_accounts a
 join public.finance360_lines l on l.company_id=a.company_id and l.account_code=a.code
 join public.finance360_journals j on j.company_id=l.company_id and j.id=l.journal_id and j.date<=p_end
 where a.company_id=p_company group by a.code,a.name,a.type order by a.code
$$;
revoke all on function public.finance360_write(uuid,uuid,text,jsonb), public.finance360_trial(uuid,date,date), public.finance360_immutable(), public.finance360_check_balance(), public.finance360_line_insert() from public,anon,authenticated;
grant execute on function public.finance360_write(uuid,uuid,text,jsonb), public.finance360_trial(uuid,date,date) to service_role;
insert into public.app_pages(company_id,code,name,sort_order,is_active)
 select distinct company_id,'finance_books','Accounting, Banks & Loans',45,true from public.company_product_memberships where lower(product_code)='finance'
 on conflict(company_id,code) do update set name=excluded.name,is_active=true;
-- Owners receive existing owner privileges; other roles require an explicit new permission grant.
create function public.finance360_summary(p_company uuid,p_end date) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
  'journals',(select count(*) from public.finance360_journals where company_id=p_company and date<=p_end),
  'accounts',(select count(*) from public.finance360_accounts where company_id=p_company),
  'imports',(select count(*) from public.finance360_imports where company_id=p_company),
  'unmatched',(select count(*) from public.finance360_bank_rows where company_id=p_company and date<=p_end and matched_line_id is null),
  'banks',coalesce((select jsonb_agg(to_jsonb(s)) from (select distinct on(account_code) account_code,period_end,closing::text,id from public.finance360_bank_statements where company_id=p_company and period_end<=p_end order by account_code,period_end desc) s),'[]'::jsonb),
  'loans',coalesce((select jsonb_agg(to_jsonb(s)) from (select distinct on(facility) facility,lender,account_code,as_of,principal::text,interest_due::text,emi::text,next_due,note from public.finance360_loans where company_id=p_company and as_of<=p_end order by facility,as_of desc,created_at desc,id desc) s),'[]'::jsonb),
  'settings',(select to_jsonb(b) from public.finance360_books b where company_id=p_company)
 );
$$;
revoke all on function public.finance360_summary(uuid,date) from public,anon,authenticated;
grant execute on function public.finance360_summary(uuid,date) to service_role;

create function public.finance360_candidates(p_company uuid,p_row uuid)
returns table(id uuid,date date,reference text,narration text,amount text)
language sql stable security invoker set search_path='' as $$
 select l.id,j.date,j.reference,j.narration,(l.debit+l.credit)::text
 from public.finance360_bank_rows r
 join public.finance360_bank_statements s on s.company_id=r.company_id and s.id=r.statement_id
 join public.finance360_lines l on l.company_id=s.company_id and l.account_code=s.account_code and l.debit=r.credit and l.credit=r.debit
 join public.finance360_journals j on j.company_id=l.company_id and j.id=l.journal_id
 where r.company_id=p_company and r.id=p_row and j.reversal_of is null
 and not exists(select 1 from public.finance360_journals rev where rev.company_id=p_company and rev.reversal_of=j.id)
 and not exists(select 1 from public.finance360_bank_rows used where used.company_id=p_company and used.matched_line_id=l.id)
 order by abs(j.date-r.date),j.date,j.id limit 100
$$;
revoke all on function public.finance360_candidates(uuid,uuid) from public,anon,authenticated;
grant execute on function public.finance360_candidates(uuid,uuid) to service_role;
create function public.finance360_bank_row_guard() returns trigger language plpgsql set search_path='' as $$ begin
 if (to_jsonb(new)-'matched_line_id'-'matched_by'-'matched_at') is distinct from (to_jsonb(old)-'matched_line_id'-'matched_by'-'matched_at') then raise exception 'Imported bank transaction details are immutable'; end if;
 return new;
end $$;
create trigger finance360_bank_row_guard before update on public.finance360_bank_rows for each row execute function public.finance360_bank_row_guard();
revoke all on function public.finance360_bank_row_guard() from public,anon,authenticated;
