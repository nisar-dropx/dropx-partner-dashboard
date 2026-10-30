-- Operational data handover, NOT a schema migration. Run with ROLLBACK first.
-- Explicitly limited to the reviewed pilot until the production rollout is approved.
-- No rates, bank approvals, payroll activation or changes to DF1095 are made.
begin;
do $$
declare
 c public.workforce_amazon_email_pilot_candidates;
 r public.workforce_amazon_email_pilot_registrations;
 s public.workforce_beta_verification_snapshots;
 w public.workforce;
 station public.stations;
 designation public.designations;
 v_code text;
 v_provider text := '2000065676540';
begin
 perform pg_advisory_xact_lock(hashtextextended('pilot-handover:4732e7e3-df91-4c8b-8ea4-0ed77f382313',0));
 select * into strict c from public.workforce_amazon_email_pilot_candidates
 where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and id='4732e7e3-df91-4c8b-8ea4-0ed77f382313' for update;
 if c.closed_at is not null or c.continuation_status <> 'continuing' or c.biometric_id <> '500419' then raise exception 'Pilot is not eligible'; end if;
 select * into strict r from public.workforce_amazon_email_pilot_registrations where company_id=c.company_id and candidate_id=c.id;
 if r.status not in ('submitted','confirmed') or r.submitted_at is null then raise exception 'Registration not submitted'; end if;
 select * into strict s from public.workforce_beta_verification_snapshots where company_id=c.company_id and candidate_id=c.id;
 if s.operational_status <> 'ACTIVE' or s.driver_id <> 'A1U57CFZYB2FHH' or lower(s.identity_email) is distinct from lower(c.alias_email)
    or s.lsc_observed_at < now()-interval '24 hours' then raise exception 'Fresh exact Amazon identity required'; end if;
 if not exists(select 1 from public.workforce_amazon_invitation_requests where company_id=c.company_id and email_pilot_candidate_id=c.id and external_reference=s.amazon_profile_id) then raise exception 'Invitation identity mismatch'; end if;
 select * into strict station from public.stations where id=c.station_id and company_id=c.company_id;
 select * into strict designation from public.designations where id=c.designation_id and company_id=c.company_id;
 -- This numeric ID is explicitly identified by the user and verified against
 -- the station's delivery record. Do not generalize this to fuzzy-name matching.
 if not exists(select 1 from public.cps_shipment_daily where company_id=c.company_id and station_code=station.station_code and provider_employee_id=v_provider and work_date='2026-10-29' and total_delivery>0) then raise exception 'Delivery evidence missing'; end if;
 if exists(select 1 from public.workforce where company_id=c.company_id and id<>c.id and provider_employee_id=v_provider)
 or exists(select 1 from public.field_executive_provider_mappings where company_id=c.company_id and provider_member_id=v_provider and status<>'cancelled' and workforce_id is distinct from c.id)
 or exists(select 1 from public.workforce_amazon_portal_links where company_id=c.company_id and transporter_id=s.driver_id and workforce_id<>c.id) then raise exception 'Identity already belongs to another profile'; end if;
 select * into w from public.workforce where company_id=c.company_id and id=c.id;
 if found then
   if w.biometric_id is distinct from c.biometric_id or w.provider_employee_id is distinct from v_provider or w.location_id is distinct from c.station_id or w.dropx_id is null then raise exception 'Existing handover differs; review required'; end if;
 else
   v_code := public.generate_dropx_worker_id(c.company_id,'field_executive',c.station_id,station.location_model_id,c.designation_id);
   if nullif(v_code,'') is null then raise exception 'No configured employee ID generated'; end if;
   insert into public.workforce(id,company_id,full_name,mobile,email,date_of_join,location_id,designation_id,designation,biometric_id,dropx_id,
     source_profile_type,source_profile_id,compatibility_mode,migration_state,is_active,onboarding_status,lifecycle_status,approval_required,
     onboarding_submitted_at,provider_id_status,provider_employee_id,onboarding_application_source,onboarding_source_detail,station_email_exception_note,
     identity_exception_required,identity_exception_context,created_by)
   values(c.id,c.company_id,c.full_name,c.mobile,c.alias_email,c.reported_on,c.station_id,c.designation_id,designation.name,c.biometric_id,v_code,
     'canonical',c.id,false,'canonical',false,'under_review','onboarding',true,
     r.submitted_at,'created',v_provider,'workforce','Amazon email onboarding pilot handover', 'Retain the exact mailbox already registered and verified with Amazon for this pilot.',
     true,jsonb_build_object('candidate_id',c.id,'existing_profile_preserved','DF1095','reason','User requested separate permanent pilot identity for mapping and payout setup testing; production review remains pending'),c.created_by);
   insert into public.workforce_beta_verification_events(company_id,candidate_id,event,detail)
   values(c.company_id,c.id,'workforce_identity_created',jsonb_build_object('workforce_id',c.id,'dropx_id',v_code,'provider_employee_id',v_provider,'driver_id',s.driver_id,'station_id',c.station_id,'payment_scheme','not_configured','registration_review','pending','source','user_requested_beta_handover'));
 end if;
 if exists(select 1 from public.workforce_amazon_portal_links where company_id=c.company_id and workforce_id=c.id and (transporter_id is distinct from s.driver_id or amazon_provider_id is distinct from s.amazon_profile_id or lower(amazon_email) is distinct from lower(c.alias_email))) then raise exception 'Portal identity conflict'; end if;
 insert into public.workforce_amazon_portal_links(company_id,workforce_id,amazon_provider_id,amazon_email,transporter_id,station_mapped,last_synced_at)
 values(c.company_id,c.id,s.amazon_profile_id,c.alias_email,s.driver_id,false,s.lsc_observed_at)
 on conflict(company_id,workforce_id) do nothing;
end $$;
select w.id,w.dropx_id,w.biometric_id,w.provider_employee_id,w.onboarding_status,w.is_active,l.transporter_id,
 (select count(*) from public.field_executive_provider_mappings m where m.company_id=w.company_id and m.workforce_id=w.id) as payment_schemes
from public.workforce w join public.workforce_amazon_portal_links l on l.company_id=w.company_id and l.workforce_id=w.id
where w.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and w.id='4732e7e3-df91-4c8b-8ea4-0ed77f382313';
rollback;
