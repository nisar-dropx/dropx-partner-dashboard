-- Request tracking is part of Payment Approvals and inherits its access and location scope.
-- Retain the old grants for history; do not grant or change approval authority.
begin;
update public.app_pages
set is_active = false
where code = 'payment_oversight';
commit;
