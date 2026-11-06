-- Fix overlapping KDJE provider payment methods blocking AKSHAY P October Workforce Payouts.
-- Three associates had open-ended Packet/Per Packet schemes overlapping Oct Fuel-by-KM periods
-- added 2026-11-06 without closing the prior rows.
--
-- Repair:
--   1) Close prior schemes at 2026-09-30
--   2) Mark bounded Oct Fuel-by-KM rows closed
--   3) Resume prior schemes from 2026-11-01 (idempotent)
--
-- Applied on uimajyffojydenqsegjv. Safe to re-run.

begin;

update public.field_executive_provider_mappings
set effective_to = date '2026-09-30',
    status = 'closed',
    updated_at = now(),
    reason = case
      when nullif(btrim(coalesce(reason, '')), '') is null then 'Closed before October Fuel-by-KM period'
      else reason
    end
where id in (
  '87c38e40-e555-482d-9280-8c59524e15eb', -- ROHIT KUMAR GUPTA Packet
  '3c067c92-cd0a-4d6b-a94f-5f6ca84c70af', -- DURGASHIS DAS Packet
  '8dbedae2-c5a2-4aaf-bd15-aee8e850463a'  -- JAY KARMAKAR Per Packet
)
and (
  status <> 'closed'
  or effective_to is distinct from date '2026-09-30'
);

update public.field_executive_provider_mappings
set status = 'closed',
    updated_at = now()
where id in (
  'dfd030d1-6e8d-4939-8ff5-877635b57333', -- ROHIT Oct KM
  '780e5530-378c-4404-8566-046e527797aa', -- DURGASHIS Oct KM
  'f969e1ba-41e2-4502-bdaf-9cf3e435a78d'  -- JAY Oct KM
)
and effective_to = date '2026-10-31'
and status <> 'closed';

insert into public.field_executive_provider_mappings (
  company_id, station_id, provider_id, provider_member_id,
  workforce_id, contractor_id, employee_id, field_executive_id,
  payment_method_id, payment_values, production_threshold_config,
  pay_type, delivery_rate, pickup_rate, mfn_rate, mfn_return_rate,
  guarantee_amount, guarantee_schedule, fuel_rate,
  effective_from, effective_to, status, reason, created_by, created_at, updated_at
)
select
  src.company_id, src.station_id, src.provider_id, src.provider_member_id,
  src.workforce_id, src.contractor_id, src.employee_id, src.field_executive_id,
  src.payment_method_id, src.payment_values, src.production_threshold_config,
  src.pay_type, src.delivery_rate, src.pickup_rate, src.mfn_rate, src.mfn_return_rate,
  src.guarantee_amount, src.guarantee_schedule, src.fuel_rate,
  date '2026-11-01', null, 'active',
  'Resumed after October Fuel-by-KM period',
  src.created_by, now(), now()
from public.field_executive_provider_mappings src
where src.id in (
  '87c38e40-e555-482d-9280-8c59524e15eb',
  '3c067c92-cd0a-4d6b-a94f-5f6ca84c70af',
  '8dbedae2-c5a2-4aaf-bd15-aee8e850463a'
)
and not exists (
  select 1
  from public.field_executive_provider_mappings existing
  where existing.company_id = src.company_id
    and existing.station_id = src.station_id
    and existing.provider_id = src.provider_id
    and upper(btrim(existing.provider_member_id)) = upper(btrim(src.provider_member_id))
    and existing.payment_method_id is not distinct from src.payment_method_id
    and existing.effective_from = date '2026-11-01'
    and existing.effective_to is null
    and existing.status = 'active'
    and coalesce(existing.workforce_id, existing.contractor_id, existing.employee_id, existing.field_executive_id)
      = coalesce(src.workforce_id, src.contractor_id, src.employee_id, src.field_executive_id)
);

-- Expect 0 overlapping different-method periods for these KDJE members.
with maps as (
  select m.*
  from public.field_executive_provider_mappings m
  join public.stations s on s.id = m.station_id and s.station_code = 'KDJE'
  where m.status in ('active', 'closed')
    and m.payment_method_id is not null
    and m.provider_member_id in ('2000050797865', '2000079184020', '2000067606210')
)
select count(*)::int as remaining_overlaps
from maps a
join maps b
  on a.id < b.id
 and a.provider_member_id = b.provider_member_id
 and a.station_id = b.station_id
 and a.effective_from <= coalesce(b.effective_to, current_date)
 and b.effective_from <= coalesce(a.effective_to, current_date)
 and a.payment_method_id is distinct from b.payment_method_id;

commit;
