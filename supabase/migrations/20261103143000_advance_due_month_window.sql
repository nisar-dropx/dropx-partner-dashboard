-- Each payroll month only pulls that month's advance installment.
-- Unpaid earlier months no longer pile into later live/payroll estimates.
-- Once recovery has started (reserved/confirmed used > 0), any remainder can
-- still finish in a later month (take-home limited partial recovery).
begin;

create or replace function public.pay_advance_due(
  p_company uuid,p_worker_type text,p_worker uuid,p_period date,
  p_target_kind text default null,p_target_key text default null
) returns table(advance_id uuid,worker_type text,worker_id uuid,paid_at timestamptz,amount numeric)
language sql stable security invoker set search_path='' as $$
  select a.id,a.worker_type,a.worker_id,a.paid_at,
    coalesce(own.amount,
      greatest(0,
        least(a.amount,
          case when m.idx >= a.installments then a.amount
            when m.idx <= 0 then 0
            else trunc(a.amount/a.installments,2)*m.idx end)
        - coalesce(d.used,0)
      )
      -
      greatest(0,
        case when coalesce(d.used,0) > 0 then 0
        else least(a.amount,
          case when m.idx-1 >= a.installments then a.amount
            when m.idx-1 <= 0 then 0
            else trunc(a.amount/a.installments,2)*(m.idx-1) end)
        - coalesce(d.used,0) end
      )
    ) amount
  from public.pay_advances a
  cross join lateral(
    select (extract(year from p_period)::int-extract(year from a.first_due_period)::int)*12
      +extract(month from p_period)::int-extract(month from a.first_due_period)::int+1 as idx
  ) m
  left join lateral(select sum(r.amount) used from public.pay_advance_deductions r
    where r.company_id=a.company_id and r.advance_id=a.id and r.status in ('reserved','confirmed','waived')
      and not(coalesce(r.target_kind=p_target_kind and r.target_key=p_target_key,false))) d on true
  left join public.pay_advance_deductions own on own.company_id=a.company_id and own.advance_id=a.id
    and own.target_kind=p_target_kind and own.target_key=p_target_key and own.status='confirmed'
  where a.company_id=p_company and a.worker_type=p_worker_type and a.worker_id=p_worker
    and a.first_due_period<=date_trunc('month',p_period)::date
    and (
      (m.idx between 1 and a.installments)
      or coalesce(d.used,0) > 0
      or own.amount is not null
    )
    and (own.amount is not null or greatest(0,
        least(a.amount,
          case when m.idx >= a.installments then a.amount
            when m.idx <= 0 then 0
            else trunc(a.amount/a.installments,2)*m.idx end)
        - coalesce(d.used,0)
      )
      -
      greatest(0,
        case when coalesce(d.used,0) > 0 then 0
        else least(a.amount,
          case when m.idx-1 >= a.installments then a.amount
            when m.idx-1 <= 0 then 0
            else trunc(a.amount/a.installments,2)*(m.idx-1) end)
        - coalesce(d.used,0) end
      ) > 0)
  order by a.paid_at,a.id;
$$;

comment on function public.pay_advance_due(uuid,text,uuid,date,text,text) is
  'Advance amount due for one payroll month. Each installment stays with its month; unpaid earlier months do not auto-pile into later estimates unless recovery already started.';

revoke all on function public.pay_advance_due(uuid,text,uuid,date,text,text) from public,anon,authenticated;
grant execute on function public.pay_advance_due(uuid,text,uuid,date,text,text) to service_role;

commit;
