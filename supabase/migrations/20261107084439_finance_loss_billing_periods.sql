-- Extend the existing audited Finance master; no source or financial amounts change.
begin;
alter table public.finance_business_master drop constraint finance_business_master_kind_check;
alter table public.finance_business_master add constraint finance_business_master_kind_check
 check(kind in ('now_rate','now_store','cost_head','contract','overhead','insight','reporting_region','billing_period','shipment_reporting','loss_period'));
create unique index if not exists finance_loss_period_unique on public.finance_business_master(company_id,(data->>'report'),(data->>'period')) where kind='loss_period' and deleted_at is null;
commit;
