-- Configurable billing/reporting transitions; no station or customer data is seeded.
-- Existing service-only RPC, permissions, optimistic revision and audit trail are retained.
begin;
alter table public.finance_business_master drop constraint finance_business_master_kind_check;
alter table public.finance_business_master add constraint finance_business_master_kind_check
 check(kind in ('now_rate','now_store','cost_head','contract','overhead','insight','reporting_region','billing_period'));
commit;
