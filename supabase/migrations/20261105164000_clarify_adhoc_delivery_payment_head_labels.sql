begin;

update public.payment_heads
set name = case code
  when 'VAN_ADHOC' then 'Ad hoc Van (Separate DA does delivery)'
  when 'ADHOC_ODCD' then 'Ad hoc ODCD (Driver himself does delivery)'
  else name
end,
updated_at = now()
where code in ('VAN_ADHOC', 'ADHOC_ODCD');

commit;
