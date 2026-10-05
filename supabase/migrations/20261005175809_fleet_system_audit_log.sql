create table public.fleet_system_logs (
 id uuid primary key default gen_random_uuid(),company_id uuid references public.companies(id),
 created_at timestamptz not null default now(),request_id text,event_kind text not null check(event_kind in ('change','request')),
 entity text not null,entity_id text,subject text,station_code text,action text not null,outcome text not null default 'success' check(outcome in ('success','failed','denied')),
 actor_user_id uuid,actor_label text not null default 'System / actor not supplied',viewer_user_id uuid,
 route text,http_status integer,before_values jsonb not null default '{}',after_values jsonb not null default '{}'
);
create index fleet_system_logs_company_date on public.fleet_system_logs(company_id,created_at desc,id);
create index fleet_system_logs_request on public.fleet_system_logs(request_id) where request_id is not null;
alter table public.fleet_system_logs enable row level security;
revoke all on public.fleet_system_logs from public,anon,authenticated,service_role;
grant select,insert on public.fleet_system_logs to service_role;

create function public.fleet_system_change_log() returns trigger language plpgsql security definer set search_path='' as $$
declare
 a jsonb:=coalesce(to_jsonb(new),'{}');b jsonb:=coalesce(to_jsonb(old),'{}');r jsonb;
 old_values jsonb:='{}';new_values jsonb:='{}';k text;ctx jsonb:='{}';hdr jsonb:='{}';company uuid;actor uuid;actor_name text;station text;head text;
 fields text[]:=array['response_value','passed','comments','caption','media_type','checklist_item_id','expected_completion_date','resolved_at','owner_user_id','provider','transaction_id','transaction_date','fuel_quantity','fuel_amount','rate','odometer','file_name','file_size','cadence_days','applies_to_statuses','is_default','is_enabled','subject_template','body_template','to_recipients','cc_recipients','custom_to_emails','custom_cc_emails','role_id','has_all_location_access','location_scope_ids','access_level','user_id','vehicle_no','station_code','ownership_type','source_id','deployment_status','deployment_date','current_location_type','current_location_code','current_location_label','rent_amount','rent_period','status','status_reason_key','status_reason_label','status_comment','non_operational_since','expected_operational_date','model','fuel_type','registration_expiry','insurance_expiry','puc_expiry','fitness_expiry','tax_expiry','is_active','label','helper_text','status_key','reason_key','requires_reason','requires_expected_date','is_operational','is_terminal','tone','ownership_types','sort_order','designation_id','scheduled_for','scheduled_reason','assigned_to','started_at','completed_at','completed_by','score','summary','email_status','odometer_km','service_date','service_type','amount','description','next_service_date','next_service_odometer_km','downtime_hours','response_type','response_config','is_required','failure_severity','category','guidance','finding','severity','action_required','due_date','resolution_note','document_type','expiry_date','request_no','amount_requested','amount_approved','approval_status','current_step_order','current_approver_user_id','payment_head_id','payment_mode','processed_at','paid_at','rejection_reason','remarks','reviewed_at','reviewed_by_name','reason','daily_status_email_enabled','daily_status_send_time','daily_status_only_affected','daily_status_email_config','risk_weights','station_codes','source','name','monthly_rent','daily_rent','effective_from','effective_to','default_audit_cadence_days','document_warning_days','service_warning_days','audit_email_enabled','auto_suggest_audits','breakdown_vehicle_link_required','audit_video_required'];
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
revoke all on function public.fleet_system_change_log() from public,anon,authenticated;
-- Triggers also capture database and other-portal changes, not just clicks in Fleet.
do $$ declare t text;begin
 foreach t in array array['fleet_vehicles','fleet_vehicle_sources','fleet_vehicle_status_master','fleet_vehicle_status_reason_master','fleet_vehicle_documents','fleet_service_history','fleet_audits','fleet_audit_checklist_items','fleet_audit_templates','fleet_audit_findings','fleet_audit_responses','fleet_audit_evidence','fleet_fuel_transactions','fleet_portal_memberships','fleet_document_notification_templates','fleet_gps_exception_reviews','fleet_control_settings','fleet_status_report_recipients','fleet_vehicle_rent_rates','payment_requests'] loop
  if to_regclass('public.'||t) is not null then execute format('create trigger fleet_system_audit after insert or update or delete on public.%I for each row execute function public.fleet_system_change_log()',t);end if;
 end loop;
end; $$;
