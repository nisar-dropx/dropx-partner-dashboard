-- Remap Fleet-related payment approvals from UJJAL DUTTA (Business Head)
-- to INAYATH SHAIK (Head Operations - Last Mile), per Abdul/Ujjal 2026-10-31.
-- Ujjal keeps OPERATIONS_BH for non-fleet business approvals (CPO/CPS etc.).
--
-- Scope:
--   - FLEET portal membership: promote Inayath FLEET_HLM -> FLEET_BH; deactivate Ujjal FLEET_BH
--   - Fleet payment heads BH step -> HLM (VAN_FUEL, VEHICLE_SERVICE, VEHICLE_REPAIR, VAN_ADHOC)
--   - In-flight open fleet requests currently with Ujjal / still snapping BH
--   - Ad-hoc reason rules that still name OPERATIONS_BH
begin;

do $$
declare
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  ujjal uuid := '76348675-71b5-43eb-84b3-dfa7bb260877';
  inayath uuid := '2b2310ce-ffef-4b6c-8386-00a77dd724b7';
  bh_ops uuid := 'd3fa37d9-8c99-40f4-86cd-2aa147d2b8e7'; -- OPERATIONS_BH
  hlm_ops uuid := '0a1e5edb-5e55-4777-b1bc-254b82caba1c'; -- OPERATIONS_HLM
  fleet_bh uuid := '9a972cc2-1b72-4624-a554-b52565bc5568'; -- FLEET_BH
  reason text := 'Fleet now reports to Inayath; fleet payment approvals remapped from Ujjal (BH) to Inayath (HLM)';
  n int;
  ujjal_scopes uuid[];
  inayath_fleet_id uuid;
begin
  -- 1) Promote Inayath's Fleet membership to FLEET_BH (BH menus are the fleet final-approver surface).
  select location_scope_ids into ujjal_scopes
  from public.company_product_memberships
  where company_id = company and user_id = ujjal and role_id = fleet_bh and product_code = 'fleet'
  limit 1;

  select id into inayath_fleet_id
  from public.company_product_memberships
  where company_id = company and user_id = inayath and product_code = 'fleet'
  order by is_active desc, updated_at desc nulls last
  limit 1;

  if inayath_fleet_id is null then
    insert into public.company_product_memberships (
      company_id, user_id, role_id, product_code, is_active,
      has_all_location_access, location_scope_ids, created_at, updated_at
    ) values (
      company, inayath, fleet_bh, 'fleet', true,
      false, coalesce(ujjal_scopes, '{}'::uuid[]), now(), now()
    );
    raise notice 'created FLEET_BH membership for Inayath';
  else
    update public.company_product_memberships m
    set role_id = fleet_bh,
        is_active = true,
        location_scope_ids = (
          select coalesce(array_agg(distinct loc), '{}'::uuid[])
          from unnest(coalesce(m.location_scope_ids, '{}'::uuid[]) || coalesce(ujjal_scopes, '{}'::uuid[])) as loc
        ),
        updated_at = now()
    where m.id = inayath_fleet_id;
    get diagnostics n = row_count;
    raise notice 'promoted Inayath fleet membership to FLEET_BH: %', n;
  end if;

  update public.company_product_memberships
  set is_active = false,
      updated_at = now()
  where company_id = company
    and user_id = ujjal
    and product_code = 'fleet'
    and role_id = fleet_bh
    and is_active;
  get diagnostics n = row_count;
  raise notice 'deactivated Ujjal FLEET_BH: %', n;

  -- 2) Fleet payment heads: final manager step OPERATIONS_BH -> OPERATIONS_HLM
  --    (keep National Head as fallback when present).
  update public.payment_head_approval_steps s
  set candidates = (
        select jsonb_agg(
          case
            when (c->>'role_id')::uuid = bh_ops
              then jsonb_build_object('role_id', hlm_ops, 'scope', coalesce(c->>'scope', 'company'))
            else c
          end
          order by ord
        )
        from jsonb_array_elements(s.candidates) with ordinality as t(c, ord)
      ),
      updated_at = now()
  where s.company_id = company
    and s.payment_head_id in (
      select id from public.payment_heads
      where company_id = company
        and code in ('VAN_FUEL', 'VEHICLE_SERVICE', 'VEHICLE_REPAIR', 'VAN_ADHOC')
        and is_active
    )
    and s.candidates::text like '%' || bh_ops::text || '%';
  get diagnostics n = row_count;
  raise notice 'payment_head_approval_steps BH->HLM rows: %', n;

  -- 3) Ad-hoc reason master workflows that still point at Business Head.
  update public.fleet_adhoc_reason_rules r
  set approval_steps = (
        select jsonb_agg(
          jsonb_set(
            step,
            '{candidates}',
            (
              select coalesce(jsonb_agg(
                case
                  when (c->>'role_id')::uuid = bh_ops
                    then jsonb_build_object('role_id', hlm_ops, 'scope', coalesce(c->>'scope', 'company'))
                  else c
                end
                order by cord
              ), '[]'::jsonb)
              from jsonb_array_elements(coalesce(step->'candidates', '[]'::jsonb)) with ordinality as ct(c, cord)
            )
          )
          order by sord
        )
        from jsonb_array_elements(coalesce(r.approval_steps, '[]'::jsonb)) with ordinality as st(step, sord)
      )
  where r.company_id = company
    and r.approval_steps::text like '%' || bh_ops::text || '%';
  get diagnostics n = row_count;
  raise notice 'fleet_adhoc_reason_rules BH->HLM rows: %', n;

  -- 4) Open in-flight fleet requests: replace BH in frozen snapshots / adhoc steps,
  --    and move any currently sitting with Ujjal to Inayath + HLM.
  update public.payment_requests r
  set approval_steps_snapshot = case
        when r.approval_steps_snapshot is null then null
        else replace(r.approval_steps_snapshot::text, bh_ops::text, hlm_ops::text)::jsonb
      end,
      adhoc_approval_steps = case
        when r.adhoc_approval_steps is null then null
        else replace(r.adhoc_approval_steps::text, bh_ops::text, hlm_ops::text)::jsonb
      end,
      current_approver_user_id = case
        when r.current_approver_user_id = ujjal then inayath
        else r.current_approver_user_id
      end,
      current_approver_role_id = case
        when r.current_approver_user_id = ujjal or r.current_approver_role_id = bh_ops
          then hlm_ops
        else r.current_approver_role_id
      end,
      current_approver_role_ids = case
        when r.current_approver_user_id = ujjal or r.current_approver_role_id = bh_ops
          then array[hlm_ops]
        else r.current_approver_role_ids
      end,
      approval_routing_reason = case
        when coalesce(r.approval_routing_reason, '') = '' then reason
        when position(reason in r.approval_routing_reason) > 0 then r.approval_routing_reason
        else r.approval_routing_reason || ' · ' || reason
      end,
      updated_at = now()
  where r.company_id = company
    and r.payment_head_id in (
      select id from public.payment_heads
      where company_id = company
        and code in ('VAN_FUEL', 'VEHICLE_SERVICE', 'VEHICLE_REPAIR', 'VAN_ADHOC')
    )
    and lower(coalesce(r.status, '')) not in ('paid', 'rejected', 'cancelled', 'processed')
    and upper(coalesce(r.approval_status, '')) not in ('REJECTED', 'CANCELLED', 'PROCESSED', 'PAID', 'FINAL_APPROVED')
    and (
      r.current_approver_user_id = ujjal
      or r.current_approver_role_id = bh_ops
      or r.approval_steps_snapshot::text like '%' || bh_ops::text || '%'
      or r.adhoc_approval_steps::text like '%' || bh_ops::text || '%'
    );
  get diagnostics n = row_count;
  raise notice 'open fleet payment_requests remapped: %', n;
end $$;

commit;
