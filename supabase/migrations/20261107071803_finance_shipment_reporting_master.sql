-- Explicit shipment reporting coverage for final P&L HO delivery weights.
-- No station data is seeded. Existing audited service-only save RPC is retained.
begin;
alter table public.finance_business_master drop constraint finance_business_master_kind_check;
alter table public.finance_business_master add constraint finance_business_master_kind_check
 check(kind in ('now_rate','now_store','cost_head','contract','overhead','insight','reporting_region','billing_period','shipment_reporting'));
commit;
