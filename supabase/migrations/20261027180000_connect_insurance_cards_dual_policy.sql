-- Allow GMC + GPA cards per person (unique includes policy_type).
alter table public.connect_insurance_cards
  add column if not exists policy_type text,
  add column if not exists membership_no text,
  add column if not exists pan text,
  add column if not exists drive_web_view_link text;

update public.connect_insurance_cards
set policy_type = 'GMC'
where policy_type is null;

alter table public.connect_insurance_cards
  alter column policy_type set default 'GMC';

alter table public.connect_insurance_cards
  alter column policy_type set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'connect_insurance_cards_policy_type_check'
  ) then
    alter table public.connect_insurance_cards
      add constraint connect_insurance_cards_policy_type_check
      check (policy_type in ('GMC', 'GPA'));
  end if;
end $$;

alter table public.connect_insurance_cards
  drop constraint if exists connect_insurance_cards_company_id_profile_type_profile_id_key;

alter table public.connect_insurance_cards
  drop constraint if exists connect_insurance_cards_company_profile_uidx;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'connect_insurance_cards_person_policy_uidx'
  ) then
    alter table public.connect_insurance_cards
      add constraint connect_insurance_cards_person_policy_uidx
      unique (company_id, profile_type, profile_id, policy_type);
  end if;
end $$;
