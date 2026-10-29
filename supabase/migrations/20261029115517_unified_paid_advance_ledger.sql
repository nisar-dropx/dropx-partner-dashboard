-- Additive foundation only. Do not enable payment/payroll consumers until the
-- legacy reconciliation and coordinated People + Dashboard cutover are complete.
-- Approval requests and bank instructions remain separate business records.
begin;

create table if not exists public.pay_advances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  worker_type text not null check (worker_type in ('employee','contractor','workforce')),
  worker_id uuid,
  worker_code text,
  request_id uuid,
  payment_request_id uuid,
  amount numeric(14,2) not null check (amount > 0 and amount <> 'NaN'::numeric),
  paid_at timestamptz not null,
  first_due_period date not null check (extract(day from first_due_period)=1),
  installments integer not null default 1 check (installments between 1 and 12),
  evidence_type text not null check (evidence_type in ('bank_confirmed','legacy_recorded')),
  bank_reference text,
  source_key text not null,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(company_id,id),
  unique(company_id,source_key),
  unique(company_id,request_id),
  unique(company_id,payment_request_id),
  check (worker_id is not null or (worker_type='workforce' and evidence_type='legacy_recorded' and nullif(trim(worker_code),'') is not null)),
  check (evidence_type<>'bank_confirmed' or (request_id is not null and payment_request_id is not null and nullif(trim(bank_reference),'') is not null))
);
create index if not exists pay_advances_worker_idx on public.pay_advances(company_id,worker_type,worker_id,paid_at,id);

create table if not exists public.pay_advance_deductions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  advance_id uuid not null,
  target_kind text not null check (target_kind in ('people','workforce','legacy')),
  target_key text not null check (length(target_key)>0),
  period_start date not null check (extract(day from period_start)=1),
  amount numeric(14,2) not null check (amount>0 and amount <> 'NaN'::numeric),
  status text not null check (status in ('reserved','confirmed','reversed','waived')),
  source_key text not null,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(company_id,advance_id) references public.pay_advances(company_id,id),
  unique(company_id,source_key),
  unique(company_id,advance_id,target_kind,target_key),
  check (status<>'waived' or target_kind='legacy')
);
create index if not exists pay_advance_deductions_target_idx on public.pay_advance_deductions(company_id,target_kind,target_key);
create index if not exists pay_advance_deductions_advance_idx on public.pay_advance_deductions(company_id,advance_id,status);

alter table public.pay_advances enable row level security;
alter table public.pay_advance_deductions enable row level security;
revoke all on public.pay_advances,public.pay_advance_deductions from public,anon,authenticated;
grant select,insert,update on public.pay_advances,public.pay_advance_deductions to service_role;

-- Every writer, including imports, is subject to the same principal ceiling.
-- Lock the principal before testing the sum to serialize concurrent payrolls.
create or replace function public.pay_advance_check_deduction() returns trigger
language plpgsql security invoker set search_path='' as $$
declare principal numeric; used numeric;
begin
  if tg_op='UPDATE' and (new.company_id,new.advance_id,new.target_kind,new.target_key,new.source_key)
     is distinct from (old.company_id,old.advance_id,old.target_kind,old.target_key,old.source_key) then
    raise exception 'Advance deduction identity cannot change';
  end if;
  if tg_op='UPDATE' and old.status in ('confirmed','waived') and new is distinct from old then
    raise exception 'Final advance deductions are immutable';
  end if;
  select amount into principal from public.pay_advances
    where company_id=new.company_id and id=new.advance_id for update;
  if principal is null then raise exception 'Advance does not belong to this company'; end if;
  select coalesce(sum(amount),0) into used from public.pay_advance_deductions
    where company_id=new.company_id and advance_id=new.advance_id and id<>new.id
      and status in ('reserved','confirmed','waived');
  if new.status in ('reserved','confirmed','waived') and used+new.amount>principal then
    raise exception 'Advance recovery exceeds its remaining principal';
  end if;
  return new;
end $$;
drop trigger if exists pay_advance_deduction_guard on public.pay_advance_deductions;
create trigger pay_advance_deduction_guard before insert or update on public.pay_advance_deductions
for each row execute function public.pay_advance_check_deduction();

-- Once imported/paid, money and identity cannot be silently reassigned.
create or replace function public.pay_advance_check_principal() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new is distinct from old then raise exception 'Paid advances are immutable; use a reconciled correction'; end if;
  return new;
end $$;
drop trigger if exists pay_advance_principal_guard on public.pay_advances;
create trigger pay_advance_principal_guard before update on public.pay_advances
for each row execute function public.pay_advance_check_principal();

-- Service-only: callers must first establish ownership or approval visibility.
-- Outstanding means unpaid principal, while reserved is only in a draft payout.
create or replace function public.pay_advance_worker_summary(
  p_company uuid,p_worker_type text,p_worker uuid,p_month date
) returns jsonb language sql stable security invoker set search_path='' as $$
  with balances as (
    select a.*,coalesce(d.confirmed,0) confirmed,coalesce(d.waived,0) waived,coalesce(d.reserved,0) reserved
    from public.pay_advances a
    left join lateral (
      select sum(amount) filter(where status='confirmed') confirmed,
             sum(amount) filter(where status='waived') waived,
             sum(amount) filter(where status='reserved') reserved
      from public.pay_advance_deductions where company_id=a.company_id and advance_id=a.id
    ) d on true
    where a.company_id=p_company and a.worker_type=p_worker_type and a.worker_id=p_worker
  ) select jsonb_build_object(
    'month',date_trunc('month',p_month)::date,
    'monthPaidCount',count(*) filter(where timezone('Asia/Kolkata',paid_at)::date>=date_trunc('month',p_month)::date
      and timezone('Asia/Kolkata',paid_at)::date<(date_trunc('month',p_month)+interval '1 month')::date),
    'monthPaidAmount',coalesce(sum(amount) filter(where timezone('Asia/Kolkata',paid_at)::date>=date_trunc('month',p_month)::date
      and timezone('Asia/Kolkata',paid_at)::date<(date_trunc('month',p_month)+interval '1 month')::date),0),
    'outstandingAdvance',coalesce(sum(amount-confirmed-waived),0),
    'reservedRecovery',coalesce(sum(reserved),0),
    'recoveredAmount',coalesce(sum(confirmed),0)
  ) from balances;
$$;

-- Recalculating a target includes its own reserved/confirmed lines. Other
-- targets' reservations consume capacity. Never round installments upward.
create or replace function public.pay_advance_due(
  p_company uuid,p_worker_type text,p_worker uuid,p_period date,
  p_target_kind text default null,p_target_key text default null
) returns table(advance_id uuid,worker_type text,worker_id uuid,paid_at timestamptz,amount numeric)
language sql stable security invoker set search_path='' as $$
  select a.id,a.worker_type,a.worker_id,a.paid_at,
    coalesce(own.amount,greatest(0,least(a.amount,
      case when m.matured>=a.installments then a.amount
        else trunc(a.amount/a.installments,2)*m.matured end
    )-coalesce(d.used,0))) amount
  from public.pay_advances a
  cross join lateral(select greatest(0,least(a.installments,
    (extract(year from p_period)::int-extract(year from a.first_due_period)::int)*12
    +extract(month from p_period)::int-extract(month from a.first_due_period)::int+1)) matured) m
  left join lateral(select sum(r.amount) used from public.pay_advance_deductions r
    where r.company_id=a.company_id and r.advance_id=a.id and r.status in ('reserved','confirmed','waived')
      and not(coalesce(r.target_kind=p_target_kind and r.target_key=p_target_key,false))) d on true
  left join public.pay_advance_deductions own on own.company_id=a.company_id and own.advance_id=a.id
    and own.target_kind=p_target_kind and own.target_key=p_target_key and own.status='confirmed'
  where a.company_id=p_company and a.worker_type=p_worker_type and a.worker_id=p_worker
    and a.first_due_period<=date_trunc('month',p_period)::date
    and (own.amount is not null or greatest(0,least(a.amount,case when m.matured>=a.installments then a.amount
      else trunc(a.amount/a.installments,2)*m.matured end)-coalesce(d.used,0))>0)
  order by a.paid_at,a.id;
$$;

-- Called inside the transaction that saves a payroll/publication. Payloads
-- contain advance_id and amount. The server determines target, worker and month.
create or replace function public.pay_advance_reserve(
  p_company uuid,p_worker_type text,p_worker uuid,p_period date,
  p_target_kind text,p_target_key text,p_lines jsonb
) returns void language plpgsql security invoker set search_path='' as $$
declare line record; available numeric; requested_count integer;
begin
  if p_company is null or p_worker is null or p_worker_type is null or p_worker_type not in ('employee','contractor','workforce')
    or p_period is null or extract(day from p_period)<>1
    or p_target_kind is null or p_target_kind not in ('people','workforce') or nullif(trim(p_target_key),'') is null
    or jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Invalid advance allocation'; end if;
  if (p_worker_type='workforce') is distinct from (p_target_kind='workforce') then
    raise exception 'Advance payroll target does not match worker category';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text||':'||p_worker_type||':'||p_worker::text||':paid-advances',0));
  perform 1 from public.pay_advances where company_id=p_company and worker_type=p_worker_type and worker_id=p_worker order by id for update;
  select count(distinct x.advance_id) into requested_count
    from jsonb_to_recordset(p_lines) x(advance_id uuid,amount numeric);
  if requested_count<>jsonb_array_length(p_lines) then raise exception 'Duplicate or missing advance identity'; end if;
  if exists(select 1 from public.pay_advance_deductions d join public.pay_advances a on a.id=d.advance_id and a.company_id=d.company_id
    where d.company_id=p_company and d.target_kind=p_target_kind and d.target_key=p_target_key
      and (a.worker_type<>p_worker_type or a.worker_id is distinct from p_worker or d.period_start<>p_period)) then
    raise exception 'Advance allocation target already belongs to another worker or period';
  end if;
  -- A frozen target may be saved unchanged, but never reduced or removed.
  if exists(select 1 from public.pay_advance_deductions d
    where d.company_id=p_company and d.target_kind=p_target_kind and d.target_key=p_target_key and d.status='confirmed'
      and not exists(select 1 from jsonb_to_recordset(p_lines) x(advance_id uuid,amount numeric)
        where x.advance_id=d.advance_id and x.amount=d.amount)) then
    raise exception 'Confirmed advance recovery cannot be changed';
  end if;
  update public.pay_advance_deductions set status='reversed',updated_at=now()
    where company_id=p_company and target_kind=p_target_kind and target_key=p_target_key and status='reserved';
  for line in select * from jsonb_to_recordset(p_lines) x(advance_id uuid,amount numeric) order by advance_id loop
    if line.amount is null or line.amount='NaN'::numeric or line.amount<=0 or line.amount<>round(line.amount,2) then raise exception 'Invalid recovery amount'; end if;
    select d.amount into available from public.pay_advance_due(p_company,p_worker_type,p_worker,p_period,p_target_kind,p_target_key) d where d.advance_id=line.advance_id;
    if available is null or line.amount>available then raise exception 'Advance allocation is stale, ineligible or exceeds the balance'; end if;
    if exists(select 1 from public.pay_advance_deductions d where d.company_id=p_company and d.advance_id=line.advance_id
      and d.target_kind=p_target_kind and d.target_key=p_target_key and d.status='confirmed' and d.amount=line.amount) then continue; end if;
    insert into public.pay_advance_deductions(company_id,advance_id,target_kind,target_key,period_start,amount,status,source_key)
      values(p_company,line.advance_id,p_target_kind,p_target_key,p_period,line.amount,'reserved',p_target_kind||':'||p_target_key||':'||line.advance_id::text)
    on conflict(company_id,advance_id,target_kind,target_key) do update
      set amount=excluded.amount,status='reserved',updated_at=now()
      where pay_advance_deductions.status in ('reserved','reversed');
  end loop;
end $$;

-- Only a bank-confirmed instruction can create a new paid principal. This
-- function does not send money and is not attached to a trigger until cutover.
create or replace function public.pay_advance_record_bank_payment(p_company uuid,p_payment uuid)
returns uuid language plpgsql security invoker set search_path='' as $$
declare p public.payment_requests%rowtype; r public.hr_pay_advance_requests%rowtype; result uuid; n integer;
begin
  select * into p from public.payment_requests where company_id=p_company and id=p_payment for update;
  if not found or p.source_type is distinct from 'pay_advance' or p.bank_status is distinct from 'Paid'
    or nullif(trim(p.utr_cin),'') is null then raise exception 'Bank confirmation and UTR are required'; end if;
  select * into r from public.hr_pay_advance_requests where company_id=p_company and id=p.source_id and payment_request_id=p.id for update;
  if not found then raise exception 'Approved advance is not linked to this bank payment'; end if;
  select id into result from public.pay_advances where company_id=p_company and payment_request_id=p.id;
  if result is not null then return result; end if;
  if r.status not in ('approved','disbursed','partially_recovered','recovered')
    or r.approved_amount is null or r.approved_amount<=0 or r.approved_amount is distinct from p.amount then
    raise exception 'Bank payment does not match the approved advance';
  end if;
  n:=case when r.recovery_mode='installments' then coalesce(r.approved_installments,r.requested_installments,1) else 1 end;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text||':'||r.worker_type||':'||r.worker_id::text||':paid-advances',0));
  insert into public.pay_advances(company_id,worker_type,worker_id,worker_code,request_id,payment_request_id,
    amount,paid_at,first_due_period,installments,evidence_type,bank_reference,source_key,provenance)
    values(p_company,r.worker_type,r.worker_id,r.worker_code,r.id,p.id,r.approved_amount,now(),
      date_trunc('month',timezone('Asia/Kolkata',now()))::date,n,'bank_confirmed',trim(p.utr_cin),'payment:'||p.id::text,
      jsonb_build_object('request_number',r.request_number,'payment_request_no',p.request_no)) returning id into result;
  return result;
end $$;

revoke all on function public.pay_advance_check_principal(),public.pay_advance_check_deduction(),
  public.pay_advance_worker_summary(uuid,text,uuid,date),public.pay_advance_due(uuid,text,uuid,date,text,text),
  public.pay_advance_reserve(uuid,text,uuid,date,text,text,jsonb),public.pay_advance_record_bank_payment(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.pay_advance_worker_summary(uuid,text,uuid,date),
  public.pay_advance_due(uuid,text,uuid,date,text,text),public.pay_advance_reserve(uuid,text,uuid,date,text,text,jsonb),
  public.pay_advance_record_bank_payment(uuid,uuid) to service_role;
-- Bulk calculation endpoint; never exposed to an end-user database role.
create or replace function public.pay_advance_period_due(p_company uuid,p_period date,p_target text,p_run uuid default null)
returns table(advance_id uuid,worker_type text,worker_id uuid,paid_at timestamptz,amount numeric)
language sql stable security invoker set search_path='' as $$
  select d.* from (select distinct a.worker_type,a.worker_id from public.pay_advances a
    where a.company_id=p_company and a.worker_id is not null
      and ((p_target='workforce' and a.worker_type='workforce') or (p_target='people' and a.worker_type in ('employee','contractor') and p_run is not null))) w
  cross join lateral public.pay_advance_due(p_company,w.worker_type,w.worker_id,p_period,p_target,
    case when p_target='workforce' then w.worker_id::text||':'||p_period::text
      else p_run::text||':'||w.worker_type||':'||w.worker_id::text end) d;
$$;
revoke all on function public.pay_advance_period_due(uuid,date,text,uuid) from public,anon,authenticated;
grant execute on function public.pay_advance_period_due(uuid,date,text,uuid) to service_role;
commit;
