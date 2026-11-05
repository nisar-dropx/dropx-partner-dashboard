begin;

update public.payment_heads
set name = 'Ad hoc ODCD Van (Driver himself does delivery)',
    updated_at = now()
where code = 'ADHOC_ODCD';

commit;
