-- User confirmed Cashbook Advertising Charges are Meta payments, not another expense.
create table public.ops_advertising_settlement_rules (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id),
 source text not null check(source in ('Cashbook','Approved payment requests')),cost_label text not null,
 effective_from date not null,is_active boolean not null default true,updated_at timestamptz not null default now(),updated_by uuid,
 unique(company_id,source,cost_label,effective_from)
);
alter table public.ops_advertising_settlement_rules enable row level security;
revoke all on public.ops_advertising_settlement_rules from anon,authenticated;
grant all on public.ops_advertising_settlement_rules to service_role;
insert into public.ops_advertising_settlement_rules(company_id,source,cost_label,effective_from)
select c.company_id,'Cashbook',c.category,date_trunc('month',min(c.expense_date))::date
from public.cps_cashbook_daily c join public.ops_advertising_settings s on s.company_id=c.company_id
where c.category='Advertising Charges' group by c.company_id,c.category;
