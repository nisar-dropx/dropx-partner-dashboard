-- Add Finance reporting region overrides without modifying operational station masters.
-- Existing company scope, permissions, optimistic revisions and audit RPC are retained.
alter table public.finance_business_master drop constraint finance_business_master_kind_check;
alter table public.finance_business_master add constraint finance_business_master_kind_check
 check (kind in ('now_rate','now_store','cost_head','contract','overhead','insight','reporting_region'));
