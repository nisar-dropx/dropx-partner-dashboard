alter table public.fleet_daily_km
 add column idle_minutes integer check(idle_minutes>=0),
 add column stopped_minutes integer check(stopped_minutes>=0),
 add column stop_unknown_minutes integer check(stop_unknown_minutes>=0),
 add column unknown_minutes integer check(unknown_minutes>=0);
create table public.fleet_day_assignments (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 vehicle_id uuid not null references public.fleet_vehicles(id), vehicle_no text not null, station_code text not null,
 work_date date not null, provider_employee_id text, workforce_id uuid references public.workforce(id),
 name text not null check(length(name) between 1 and 160), source text not null check(source in ('workforce','shipment','manual')),
 purpose text not null check(purpose in ('delivery','shipment_drop','other')),
 remarks text not null default '', is_active boolean not null default true,
 created_by uuid not null, created_at timestamptz not null default now(),updated_by uuid not null,updated_at timestamptz not null default now(),
 check(purpose<>'delivery' or provider_employee_id is not null)
);
-- A DA's complete daily package count can belong to only one vehicle. No duplicated packages.
create unique index fleet_day_assignment_person on public.fleet_day_assignments(company_id,work_date,upper(trim(provider_employee_id))) where is_active and provider_employee_id is not null;
create index fleet_day_assignment_report on public.fleet_day_assignments(company_id,work_date,vehicle_no) where is_active;
alter table public.fleet_day_assignments enable row level security;
revoke all on public.fleet_day_assignments from public,anon,authenticated;
grant select,insert,update on public.fleet_day_assignments to service_role;
create function public.fleet_day_assignment_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from public.fleet_vehicles where id=new.vehicle_id and company_id=new.company_id and vehicle_no=new.vehicle_no) then raise exception 'Vehicle company mismatch';end if;
 if new.workforce_id is not null and not exists(select 1 from public.workforce where id=new.workforce_id and company_id=new.company_id) then raise exception 'Associate company mismatch';end if;
 if not exists(select 1 from public.stations where company_id=new.company_id and station_code=new.station_code) then raise exception 'Station company mismatch';end if;
 if tg_op='UPDATE' and (new.company_id<>old.company_id or new.vehicle_id<>old.vehicle_id or new.work_date<>old.work_date or new.provider_employee_id is distinct from old.provider_employee_id or new.station_code<>old.station_code) then raise exception 'Cancel and replace an assignment to change its identity';end if;
 return new;
end;$$;
create trigger fleet_day_assignment_guard before insert or update on public.fleet_day_assignments for each row execute function public.fleet_day_assignment_guard();
create trigger fleet_system_audit after insert or update or delete on public.fleet_day_assignments for each row execute function public.fleet_system_change_log();

create or replace function public.fleet_system_change_log() returns trigger language plpgsql security definer set search_path='' as $$
declare
 a jsonb:=coalesce(to_jsonb(new),'{}');b jsonb:=coalesce(to_jsonb(old),'{}');r jsonb;
 old_values jsonb:='{}';new_values jsonb:='{}';k text;ctx jsonb:='{}';hdr jsonb:='{}';company uuid;actor uuid;actor_name text;station text;head text;
 fields text[]:=array['work_date','provider_employee_id','workforce_id','purpose','response_value','passed','comments','caption','media_type','checklist_item_id','expected_completion_date','resolved_at','owner_user_id','provider','transaction_id','transaction_date','fuel_quantity','fuel_amount','rate','odometer','file_name','file_size','cadence_days','applies_to_statuses','is_default','is_enabled','subject_template','body_template','to_recipients','cc_recipients','custom_to_emails','custom_cc_emails','role_id','has_all_location_access','location_scope_ids','access_level','user_id','vehicle_no','station_code','ownership_type','source_id','deployment_status','deployment_date','current_location_type','current_location_code','current_location_label','rent_amount','rent_period','status','status_reason_key','status_reason_label','status_comment','non_operational_since','expected_operational_date','model','fuel_type','registration_expiry','insurance_expiry','puc_expiry','fitness_expiry','tax_expiry','is_active','label','helper_text','status_key','reason_key','requires_reason','requires_expected_date','is_operational','is_terminal','tone','ownership_types','sort_order','designation_id','scheduled_for','scheduled_reason','assigned_to','started_at','completed_at','completed_by','score','summary','email_status','odometer_km','service_date','service_type','amount','description','next_service_date','next_service_odometer_km','downtime_hours','response_type','response_config','is_required','failure_severity','category','guidance','finding','severity','action_required','due_date','resolution_note','document_type','expiry_date','request_no','amount_requested','amount_approved','approval_status','current_step_order','current_approver_user_id','payment_head_id','payment_mode','processed_at','paid_at','rejection_reason','remarks','reviewed_at','reviewed_by_name','reason','daily_status_email_enabled','daily_status_send_time','daily_status_only_affected','daily_status_email_config','risk_weights','station_codes','source','name','monthly_rent','daily_rent','effective_from','effective_to','default_audit_cadence_days','document_warning_days','service_warning_days','audit_email_enabled','auto_suggest_audits','breakdown_vehicle_link_required','audit_video_required'];
begin
 r:=case when tg_op='DELETE' then b else a end;company:=(r->>'company_id')::uuid;
 if company is null then return coalesce(new,old);end if;
 begin hdr:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if current_setting('request.jwt.claim.role',true)='service_role' or coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'='service_role' then ctx:=coalesce((hdr->>'x-fleet-audit')::jsonb,'{}');end if;
 exception when others then ctx:='{}';end;
 if tg_table_name='payment_requests' then
  select upper(code||'_'||name) into head from public.payment_heads where id=(r->>'payment_head_id')::uuid and company_id=company;
  if coalesce(head,'') !~ '(VEHICLE|VAN|FLEET|TYRE|TIRE|PUC)' then return coalesce(new,old);end if;
 end if;
 foreach k in array fields loop
  if (a?k or b?k) and (tg_op<>'UPDATE' or a->k is distinct from b->k) then
   if b?k then old_values:=old_values||jsonb_build_object(k,b->k);end if;
   if a?k then new_values:=new_values||jsonb_build_object(k,a->k);end if;
  end if;
 end loop;
 if old_values='{}' and new_values='{}' then return coalesce(new,old);end if;
 begin actor:=nullif(ctx->>'actorId','')::uuid;exception when others then actor:=null;end;
 -- Do not attribute automated updates to a historical created_by / updated_by value.
 if actor is null and tg_op='UPDATE' and a->>'updated_by' is distinct from b->>'updated_by' then
  begin actor:=nullif(a->>'updated_by','')::uuid;exception when others then actor:=null;end;
 end if;
 if actor is not null then select full_name into actor_name from public.profiles where id=actor and company_id=company;end if;
 station:=coalesce(r->>'station_code',r->>'location_code');
 if station is null and r->>'vehicle_no' is not null then select station_code into station from public.fleet_vehicles where vehicle_no=r->>'vehicle_no' and company_id=company limit 1;end if;
 if station is null and r->>'vehicle_id' is not null then select station_code into station from public.fleet_vehicles where id=(r->>'vehicle_id')::uuid and company_id=company;end if;
 insert into public.fleet_system_logs(company_id,request_id,event_kind,entity,entity_id,subject,station_code,action,actor_user_id,actor_label,viewer_user_id,route,before_values,after_values)
 values(company,ctx->>'requestId','change',tg_table_name,r->>'id',coalesce(r->>'vehicle_no',r->>'request_no',r->>'label',r->>'name',r->>'status_key',r->>'id'),station,lower(tg_op),actor,coalesce(actor_name,'System / actor not supplied'),nullif(ctx->>'viewerId','')::uuid,ctx->>'route',old_values,new_values);
 return coalesce(new,old);
end; $$;
