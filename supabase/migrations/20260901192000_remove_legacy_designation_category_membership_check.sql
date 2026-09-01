-- Designations now support multiple categories through onboarding_categories.
-- The old single registration_category membership check rejects valid saves
-- after the Field Executives -> Workforce cutover, so retire only that check.
begin;

alter table public.designations
  drop constraint if exists designations_registration_category_membership_check;

notify pgrst, 'reload schema';

commit;
