insert into public.app_pages (company_id, code, name, sort_order, is_active, created_at, updated_at)
select companies.id, 'ops_workforce_payouts', 'Workforce & Helper Payments', 90, true, now(), now()
from public.companies
where not exists (
  select 1
  from public.app_pages pages
  where pages.company_id = companies.id
    and pages.code = 'ops_workforce_payouts'
);
