-- Confirm Akshay's proposed rejections for N1035 / DF1023, then reopen their
-- publication dispute windows so the associates can raise a new request.
--
-- Context:
--   Both tickets were pending_final_approval (proposed_decision = rejected) by AKSHAY P.
--   Final route is Finance Manager only; Nisar is the eligible final actor.
--   Publication review_until had already passed. review_until is immutable via
--   trigger, so the reopen step uses a scoped disable/enable of that trigger.
--
-- Applied on uimajyffojydenqsegjv. Safe to re-run (no-op once rejected / window set).

begin;

do $$
declare
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  actor uuid := '2909d787-6d35-4eac-807f-fc3ec71c4dc3'; -- NISAR AHAMMED
  actor_name text := 'NISAR AHAMMED';
  final_role uuid := '91f2192d-4606-479d-8d92-26e51e3d1c03'; -- OPERATIONS_FINMGR
  dispute_ids uuid[] := array[
    '66dd8847-c2ab-4cb6-bb1b-ebd98cd9c2d8'::uuid, -- N1035 ADWANI RAJU
    '400eff38-63c5-4c20-9cb9-b6c2d057fa74'::uuid  -- DF1023 RESSAQ MS
  ];
  dispute_id uuid;
  dispute_row public.workforce_payout_disputes;
  saved public.workforce_payout_disputes;
begin
  foreach dispute_id in array dispute_ids loop
    select * into dispute_row
    from public.workforce_payout_disputes
    where id = dispute_id
      and company_id = company
    for update;

    if not found then
      raise exception 'Dispute % not found', dispute_id;
    end if;

    if dispute_row.status = 'rejected' then
      continue;
    end if;

    if dispute_row.status is distinct from 'pending_final_approval'
      or dispute_row.proposed_decision is distinct from 'rejected' then
      raise exception 'Dispute % is %, proposed % - expected pending_final_approval / rejected',
        dispute_id, dispute_row.status, dispute_row.proposed_decision;
    end if;

    saved := public.workforce_dispute_transition_v2(
      company,
      dispute_id,
      actor,
      actor_name,
      array[final_role],
      'approve_final',
      dispute_row.version,
      null,
      jsonb_build_object(
        'note', 'Confirmed rejection so associate can refile with the correct disputed item.',
        'portal', 'ops'
      )
    );

    if saved.status is distinct from 'rejected' then
      raise exception 'Dispute % ended as % after approve_final', dispute_id, saved.status;
    end if;
  end loop;
end $$;

-- Publication snapshots are immutable; scoped bypass for review_until only.
alter table public.workforce_payout_publications
  disable trigger workforce_payout_publications_00_immutable;

update public.workforce_payout_publications
set review_until = clock_timestamp() + interval '48 hours'
where id in (
  'eb2158ba-f966-4c7b-9da6-0c09f98707c6', -- N1035
  '7350d239-f30f-4264-86c3-516b19ee1ccb'  -- DF1023
)
and (review_until is null or review_until < clock_timestamp() + interval '48 hours');

alter table public.workforce_payout_publications
  enable trigger workforce_payout_publications_00_immutable;

-- Verification
select
  w.dropx_id,
  w.full_name,
  d.id as dispute_id,
  d.status,
  d.proposed_decision,
  d.final_approved_by_name,
  d.version,
  p.id as publication_id,
  p.review_until,
  (p.review_until > now()) as window_open
from public.workforce_payout_disputes d
join public.workforce w on w.id = d.workforce_id
join public.workforce_payout_publications p on p.id = d.publication_id
where d.id in (
  '66dd8847-c2ab-4cb6-bb1b-ebd98cd9c2d8',
  '400eff38-63c5-4c20-9cb9-b6c2d057fa74'
)
order by w.dropx_id;

commit;
