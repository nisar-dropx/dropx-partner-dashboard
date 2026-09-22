-- Blank August 2026 XPT fixed payouts, as requested. No sample-invoice amounts are imported.
-- Relationships come from the existing location master; this never changes operational locations.
insert into public.finance_pricing_revisions(company_id,provider,station_code,effective_month,revision,rates,slabs,slab_mode,reason)
select distinct base.company_id,'Amazon',x.station_code,base.effective_month,1,
  jsonb_build_object('pricing_model','xpt','parent_station_code',p.station_code,
    'mg_amount_including_mhe',null,'delivery_mg_volume',null,'variable_slab',null),
  '[]'::jsonb,'progressive','XPT fixed payout left blank for manual entry; delivery rate inherits the parent station monthly card.'
from public.finance_pricing_revisions base
join public.stations p on p.company_id=base.company_id and p.station_code=base.station_code
join public.stations x on x.company_id=p.company_id and x.parent_station_id=p.id and x.is_active
join public.location_models m on m.id=x.location_model_id
where base.provider='Amazon' and base.effective_month=date '2026-08-01' and upper(m.code)='XPT'
  and base.company_id in (select id from public.companies where code='DROPX_LOGISTICS')
  and not exists (select 1 from public.finance_pricing_revisions existing where existing.company_id=x.company_id
    and existing.provider='Amazon' and existing.station_code=x.station_code and existing.effective_month=base.effective_month)
on conflict(company_id,provider,station_code,effective_month,revision) do nothing;
