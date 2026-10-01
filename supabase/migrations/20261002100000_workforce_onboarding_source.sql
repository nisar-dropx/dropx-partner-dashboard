-- Keep the operational channel entered at invitation time alongside the
-- technical portal that created the Workforce record. This makes Recruit,
-- referral, agency, walk-in and other onboarding sources auditable.
alter table public.workforce
  add column if not exists onboarding_source_detail text;

alter table public.workforce
  drop constraint if exists workforce_onboarding_source_detail_length;

alter table public.workforce
  add constraint workforce_onboarding_source_detail_length
  check (
    onboarding_source_detail is null
    or char_length(trim(onboarding_source_detail)) between 1 and 160
  );
