-- DropX One resolves a login by mobile number alone, across every company, on
-- each API call. The existing (company_id, mobile_country_code, mobile) indexes
-- cannot serve a lookup that does not filter by company, so each call scanned
-- these tables in full. Plain mobile indexes make the lookups index scans.
begin;

create index if not exists profiles_mobile_idx on public.profiles (mobile);
create index if not exists employees_mobile_idx on public.employees (mobile);
create index if not exists workforce_mobile_idx on public.workforce (mobile);
create index if not exists contractors_mobile_idx on public.contractors (mobile);
create index if not exists vendors_mobile_idx on public.vendors (mobile);

commit;
