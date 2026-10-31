-- Requeue only untouched, still-open Amazon Now fleet requests after the
-- approval master changed from Fleet Manager -> National Head to the normal
-- Amazon Now Operations hierarchy. Requests with an approval action are not
-- rewound; their recorded lifecycle remains authoritative.

update public.payment_requests request
set current_step_order = 1,
    current_approver_user_id = null,
    current_approver_role_id = null,
    current_approver_role_ids = '{}'::uuid[],
    approval_status = 'PENDING',
    approval_routing_reason =
      'Amazon Now fleet request requeued to the current Operations hierarchy from the approval master',
    email_next_reminder_at = null,
    updated_at = now()
from public.payment_heads head,
     public.stations station,
     public.location_models model
where request.company_id = head.company_id
  and request.payment_head_id = head.id
  and station.company_id = request.company_id
  and station.id = request.location_id
  and model.company_id = station.company_id
  and model.id = station.location_model_id
  and model.code = 'NOW'
  and upper(head.code) in
    ('VAN_ADHOC', 'VAN_FUEL', 'VEHICLE_REPAIR', 'VEHICLE_SERVICE')
  and request.adhoc_approval_steps is null
  and upper(coalesce(request.status, '')) not in
    ('APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED')
  and upper(coalesce(request.approval_status, request.status, 'PENDING')) in
    ('PENDING', 'NO_APPROVER_CONFIGURED', 'RESUBMITTED', 'RE_PENDING')
  and not exists (
    select 1
    from public.payment_request_approvals approval
    where approval.company_id = request.company_id
      and approval.payment_request_id = request.id
      and lower(approval.action) = 'approved'
  );
