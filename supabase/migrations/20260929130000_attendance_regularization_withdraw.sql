-- Workers can withdraw their own attendance correction in DropX One before any approver has
-- approved it (like a leave withdrawal). Withdrawn requests are stored as 'cancelled'; their open
-- approval steps become 'skipped', which the steps check already allows.
begin;

alter table public.attendance_regularization_requests
  drop constraint if exists attendance_regularization_requests_status_check;
alter table public.attendance_regularization_requests
  add constraint attendance_regularization_requests_status_check
  check (status in ('pending', 'pending_manager', 'pending_hr', 'approved', 'returned', 'rejected', 'cancelled'));

commit;
