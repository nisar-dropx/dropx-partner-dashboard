-- Roster shift swap diagnostics (run each block separately in Supabase SQL editor).
-- Optional: set name filter in block 1, or leave blank to list all recent swaps.

-- ---------------------------------------------------------------------------
-- 1) Recent swap requests (all statuses) with worker + approver names
-- ---------------------------------------------------------------------------
with name_filter as (
  select nullif(btrim(''), '') as needle  -- e.g. 'FASNA' or 'JOSEPH'
)
select
  r.id as swap_request_id,
  r.roster_date,
  r.status,
  r.requested_at,
  r.requester_worker_type,
  coalesce(er.full_name, cr.full_name, r.requester_worker_id::text) as requester_name,
  coalesce(er.employee_code, cr.dropx_id, '') as requester_code,
  r.partner_worker_type,
  coalesce(ep.full_name, cp.full_name, r.partner_worker_id::text) as partner_name,
  coalesce(ep.employee_code, cp.dropx_id, '') as partner_code,
  r.approver_user_id,
  coalesce(approver_hp.display_name, approver_prof.email, r.approver_user_id::text) as approver_name,
  approver_prof.email as approver_email
from public.hr_roster_swap_requests r
left join public.employees er on r.requester_worker_type = 'employee' and er.id = r.requester_worker_id
left join public.contractors cr on r.requester_worker_type = 'contractor' and cr.id = r.requester_worker_id
left join public.employees ep on r.partner_worker_type = 'employee' and ep.id = r.partner_worker_id
left join public.contractors cp on r.partner_worker_type = 'contractor' and cp.id = r.partner_worker_id
left join public.profiles approver_prof on approver_prof.id = r.approver_user_id
left join public.hr_user_person_links approver_link
  on approver_link.company_id = r.company_id
 and approver_link.user_id = r.approver_user_id
 and approver_link.status = 'active'
left join public.hr_people approver_hp
  on approver_hp.company_id = r.company_id
 and approver_hp.id = approver_link.person_id
cross join name_filter nf
where nf.needle is null
   or coalesce(er.full_name, cr.full_name, '') ilike '%' || nf.needle || '%'
   or coalesce(ep.full_name, cp.full_name, '') ilike '%' || nf.needle || '%'
order by r.requested_at desc
limit 30;

-- ---------------------------------------------------------------------------
-- 2) Web notifications sent for shift swaps (who was told to approve)
-- ---------------------------------------------------------------------------
select
  n.id,
  n.created_at,
  n.event_code,
  n.title,
  n.body,
  n.href,
  n.source_key as swap_request_id,
  n.recipient_user_id,
  p.email as recipient_email,
  coalesce(hp.display_name, p.email) as recipient_name,
  n.read_at
from public.people_web_notifications n
left join public.profiles p on p.id = n.recipient_user_id
left join public.hr_user_person_links upl
  on upl.company_id = n.company_id and upl.user_id = n.recipient_user_id and upl.status = 'active'
left join public.hr_people hp on hp.company_id = n.company_id and hp.id = upl.person_id
where n.event_code = 'roster_swap_approval_required'
order by n.created_at desc
limit 30;

-- ---------------------------------------------------------------------------
-- 3) Pending manager swaps with no inbox UI (stuck queue)
--    approver_user_id is where the request lives until a manager approves it.
-- ---------------------------------------------------------------------------
select
  r.id as swap_request_id,
  r.roster_date,
  r.status,
  coalesce(er.full_name, cr.full_name) as requester_name,
  coalesce(ep.full_name, cp.full_name) as partner_name,
  r.approver_user_id,
  p.email as approver_login_email,
  coalesce(hp.display_name, p.email) as approver_display_name,
  r.requested_at
from public.hr_roster_swap_requests r
left join public.employees er on r.requester_worker_type = 'employee' and er.id = r.requester_worker_id
left join public.contractors cr on r.requester_worker_type = 'contractor' and cr.id = r.requester_worker_id
left join public.employees ep on r.partner_worker_type = 'employee' and ep.id = r.partner_worker_id
left join public.contractors cp on r.partner_worker_type = 'contractor' and cp.id = r.partner_worker_id
left join public.profiles p on p.id = r.approver_user_id
left join public.hr_user_person_links upl
  on upl.company_id = r.company_id and upl.user_id = r.approver_user_id and upl.status = 'active'
left join public.hr_people hp on hp.company_id = r.company_id and hp.id = upl.person_id
where r.status = 'pending_manager'
order by r.requested_at desc;
