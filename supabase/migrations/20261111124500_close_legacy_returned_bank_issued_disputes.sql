-- BUG-021: 9 Nov legacy guided-recalculation repair returned already-approved
-- disputes to open even when October bank instructions were already issued.
-- Close only that returned cohort when a matching processing/paid bank line
-- exists. Preserve history; do not change any payment amount or UTR.
do $$
declare
  actor record;
  item record;
  already integer;
  closed integer := 0;
  expected integer := 10;
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
begin
  select p.id, p.company_id, p.full_name
    into actor
  from public.profiles p
  where lower(p.email) = 'jamsheer@dropxlogistics.com'
    and p.is_active
    and p.company_id = company;
  if not found then
    raise exception 'Managing Partner actor unavailable for BUG-021 closure';
  end if;

  select count(*) into already
  from public.workforce_payout_dispute_events
  where company_id = company
    and event_type = 'legacy_returned_bank_closure_20261111';
  if already = expected then
    return;
  end if;
  if already <> 0 then
    raise exception 'Unexpected partial BUG-021 closure; inspect before continuing (% events)', already;
  end if;

  for item in
    select d.*
    from public.workforce_payout_disputes d
    join public.workforce_payout_publications p
      on p.id = d.publication_id
     and p.company_id = d.company_id
    where d.company_id = company
      and d.status = 'open'
      and exists (
        select 1
        from public.workforce_payout_dispute_events e
        where e.company_id = d.company_id
          and e.dispute_id = d.id
          and e.event_type = 'legacy_approval_returned'
      )
      and exists (
        select 1
        from public.workforce_payout_payment_items i
        where i.company_id = d.company_id
          and i.workforce_id = d.workforce_id
          and i.period_start = p.period_start
          and i.period_end = p.period_end
          and i.status in ('processing', 'paid')
      )
    for update
  loop
    update public.workforce_payout_disputes
    set status = 'resolved',
        resolution = 'Closed: Finance already issued/paid this period. Legacy guided-recalculation return left the ticket open; historical closure only. No payout amount changed.',
        resolved_by = actor.id,
        resolved_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        version = item.version + 1,
        legacy_resolution_unverified = true,
        details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
          'legacy_recalculation_required', false,
          'bank_issued_closure', true
        )
    where id = item.id
      and version = item.version;

    if not found then
      raise exception 'Version conflict closing dispute %', item.id;
    end if;

    insert into public.workforce_payout_dispute_events(
      company_id, dispute_id, actor_id, actor_name, portal, message,
      event_type, from_status, to_status, metadata, dispute_version
    ) values (
      company,
      item.id,
      actor.id,
      actor.full_name,
      'ops',
      'Finance confirmed salary already issued/paid for this period. Ticket cleared from pending after legacy recalculation return. Original history retained. No payout changed.',
      'legacy_returned_bank_closure_20261111',
      item.status,
      'resolved',
      jsonb_build_object('before', to_jsonb(item), 'net_change_verified', false, 'bug', 'BUG-021'),
      item.version + 1
    );

    closed := closed + 1;
  end loop;

  if closed <> expected then
    raise exception 'BUG-021 cohort changed: expected %, closed %', expected, closed;
  end if;
end $$;
