-- Apply only after the committed Worker, OpsPulse and DropX One releases
-- are ready. Does not modify mappings, published statements or payment records.
begin;
select public.lock_workforce_payment_allocation_company('43866344-b550-4e8a-9a2d-9d23f3d8a997');
update public.workforce_route_distance_settings set enabled=true,updated_at=now()
where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997';
commit;
select enabled,effective_from from public.workforce_route_distance_settings
where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997';
