insert into public.payment_field_provider_metrics (company_id, payment_field_id, provider_id, provider_metric_id)
select pf.company_id, pf.id, ppm.provider_id, ppm.id
from public.payment_fields pf
join public.provider_production_metrics ppm
  on ppm.company_id = pf.company_id
 and ppm.source_key = coalesce(pf.provider_calculation_sources ->> 'amazon', pf.calculation_source)
join public.providers p on p.id = ppm.provider_id
where (lower(p.code) = 'amazon' or lower(p.name) = 'amazon')
  and coalesce(pf.provider_calculation_sources ->> 'amazon', pf.calculation_source) is not null
on conflict (company_id, payment_field_id, provider_id)
do update set provider_metric_id = excluded.provider_metric_id, updated_at = now();
