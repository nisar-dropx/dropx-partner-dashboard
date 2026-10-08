-- Workforce station emails: bring the database rule in line with the register.
--
-- 1. Digits after the station code are allowed (name.peua123@gmail.com), as the
--    register has accepted since 2026-10-07; the plain mailbox name is often taken.
--    The database check still required the code to be the very last characters,
--    so the register accepted these addresses and the insert then rejected them.
-- 2. A mailbox that breaks the rule can be saved when a written reason is
--    recorded, for an associate who has already completed partner onboarding
--    with that mailbox. The register asks for the reason and audit-logs it.
--
-- workforce_station_email_valid and workforce_validate_partner_email were
-- created by the Workforce product (20260928200000_configurable_partner_onboarding).
begin;

alter table public.workforce add column if not exists station_email_exception_note text;

alter table public.workforce drop constraint if exists workforce_station_email_exception_note_check;
alter table public.workforce add constraint workforce_station_email_exception_note_check
  check (station_email_exception_note is null or length(btrim(station_email_exception_note)) between 10 and 500);

create or replace function public.workforce_station_email_valid(p_email text,p_station_code text)
returns boolean language sql immutable set search_path='' as $$
 with parts as (
  select regexp_replace(lower(split_part(btrim(p_email),'@',1)),'[0-9]+$','') as local_part,
         '.'||lower(btrim(p_station_code)) as suffix
 )
 select coalesce(length(btrim(p_email))<=254 and btrim(p_email) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
 and length(local_part) > length(suffix)
 and right(local_part,length(suffix))=suffix,false)
 from parts
$$;

create or replace function public.workforce_validate_partner_email() returns trigger language plpgsql set search_path='' as $$
declare rule public.workforce_partner_onboarding_rules; station public.stations;
begin
 if coalesce(new.compatibility_mode,false) or new.migration_state<>'canonical' then return new; end if;
 if tg_op='UPDATE' and new.email is not distinct from old.email and new.location_id is not distinct from old.location_id and new.designation_id is not distinct from old.designation_id then return new; end if;
 select * into station from public.stations where id=new.location_id and company_id=new.company_id;
 select * into rule from public.workforce_partner_onboarding_rules where company_id=new.company_id and provider_id=station.provider_id and model_id=station.location_model_id and designation_id=new.designation_id and is_active;
 if rule.require_station_email
  and not public.workforce_station_email_valid(new.email,station.station_code)
  and nullif(btrim(coalesce(new.station_email_exception_note,'')),'') is null then
  raise exception 'Email must end with .% before @ (numbers after it are allowed), for example name.%123@gmail.com. To use a mailbox already registered with the partner, submit it with a reason.',lower(station.station_code),lower(station.station_code);
 end if;
 return new;
end $$;

commit;

notify pgrst, 'reload schema';
