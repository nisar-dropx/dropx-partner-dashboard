-- Apply only after the committed Worker, OpsPulse and DropX One releases
-- are ready. Does not modify mappings, published statements or payment records.
begin;
select public.lock_workforce_payment_allocation_company('b63603e9-36e2-4656-9b87-c421489a64a9');
update public.workforce_route_distance_settings set enabled=true,updated_at=now()
where company_id='b63603e9-36e2-4656-9b87-c421489a64a9';
commit;
select enabled,effective_from from public.workforce_route_distance_settings
where company_id='b63603e9-36e2-4656-9b87-c421489a64a9';
