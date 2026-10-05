-- Configurable physical inspection areas and immutable report score snapshots.
alter table public.ops_audit_types add column if not exists scoring_enabled boolean not null default false;
alter table public.ops_audit_checklist_sections add column if not exists score_weight numeric not null default 0 check(score_weight between 0 and 100);
alter table public.ops_audit_checklist_items add column if not exists score_weight numeric not null default 1 check(score_weight>0 and score_weight<=100);
alter table public.ops_audit_checklist_items add column if not exists score_source text not null default 'checklist' check(score_source in ('checklist','cash_match','shipment_match'));
alter table public.ops_station_audits add column if not exists score_snapshot jsonb;
update public.ops_audit_types set scoring_enabled=true where code='physical_station';

with areas(code,name,guidance,weight,seq) as (values
 ('shipment_reconciliation','Shipments & inventory','Compare the ERP ageing list with the complete physical scan. Assess station responsibility for every missing or excess TID; verified prior missing scans and external causes are excluded with evidence.',30,10),
 ('cod_reconciliation','COD & remittance','Record ERP cash with proof, count denominations and explain any difference. Cash accuracy carries most of this area; verify remittance separately.',30,20),
 ('safety_hygiene','Hygiene & welfare','Inspect floors, surfaces, waste and washroom facilities. Photograph every outcome. Verify the cleaning log; do not photograph people in washrooms.',15,30),
 ('security','Security, keys & CCTV','Verify named key custodians, locked cash storage, controlled access and CCTV retention. These controls prevent loss; record evidence rather than assumptions.',10,40),
 ('operations','Handling & returns','Observe unloading CCTV, sorting, RTS/RTSW, damage and orphan processes. Check deliveries are not left at the station.',5,50),
 ('safety','Safety & station layout','Inspect marked walkways and loading/storage zones, clear emergency exits, fire equipment, electrical safety and first aid. Apply practical site controls; no invented Amazon dimensions or colour standard.',5,60),
 ('assets','Assets & equipment','Inspect IT equipment, printers, fans and operational equipment. Check cleanliness and condition with photos.',5,70)
)
insert into public.ops_audit_checklist_sections(company_id,audit_type_id,code,name,guidance,score_weight,sort_order)
select t.company_id,t.id,a.code,a.name,a.guidance,a.weight,a.seq from public.ops_audit_types t cross join areas a where t.code='physical_station'
on conflict(audit_type_id,code) do update set name=excluded.name,guidance=excluded.guidance,score_weight=excluded.score_weight,sort_order=excluded.sort_order;

with moves(code,area) as (values
 ('office_key_custody','security'),('office_key_carried','security'),('cash_key_custody','security'),('cash_lock_control','security'),('cctv_retention','security'),('staff_hygiene','security'),
 ('fire_safety','safety'),('first_aid','safety'),('electrical_safety','safety'),('five_s','safety'),
 ('it_assets_clean','assets'),('fans_clean','assets'),('equipment','assets'))
update public.ops_audit_checklist_items i set section_id=s.id from public.ops_audit_types t,moves m,public.ops_audit_checklist_sections s
where i.audit_type_id=t.id and t.code='physical_station' and i.code=m.code and s.audit_type_id=t.id and s.code=m.area;
update public.ops_audit_checklist_items i set label='Missing/excess shipment findings recorded',guidance='Confirm every detected TID difference has an auditor observation and responsibility assessment. The station records its investigation outcome after submission; a pending station response must not be marked as an auditor failure.' from public.ops_audit_types t where t.id=i.audit_type_id and t.code='physical_station' and i.code='tad_status';
-- Covered by specific key-custody and locker-control questions; preserve prior answers.
update public.ops_audit_checklist_items i set is_active=false from public.ops_audit_types t where t.id=i.audit_type_id and t.code='physical_station' and i.code='cash_security';

with definitions(code,area,label,guidance,photo,weight,source,seq) as (values
 ('cash_accuracy','cod_reconciliation','COD cash accuracy','Automatically scored from ERP cash and the denomination total. Responsibility exclusions require evidence. Open cash differences remain visible regardless of score.',false,4,'cash_match',0),
 ('shipment_accuracy','shipment_reconciliation','Shipment inventory accuracy','Automatically compares unique TIDs. Only chargeable differences deduct points. Pending responsibility keeps the score provisional.',false,4,'shipment_match',0),
 ('walkways_zones','safety','Walkways and loading / storage zones are clearly marked and clear','Inspect pedestrian routes, sorting lanes, loading area and segregated storage. Markings should be visible and routes free of parcels, cables and spills.',true,1,'checklist',10),
 ('emergency_exits','safety','Emergency exits and emergency contact information are accessible','Check routes and exit doors are unobstructed and usable, emergency contacts are displayed and staff can explain evacuation. Photograph the exit route and contact board.',true,2,'checklist',20),
 ('safe_stacking','operations','Parcels are stable, protected and handled safely','Review morning unloading footage and spot-check storage: no throwing parcels, unstable stacks, overloaded bins or heavy items above unsafe reach. Confirm appropriate handling aids / PPE are used.',false,1,'checklist',130),
 ('water_ventilation','safety_hygiene','Drinking water, ventilation and rest facilities are available','Check safe drinking water, functional ventilation and a clean rest area. During heat, confirm water and breaks are accessible. Photograph facilities without identifying individuals.',true,1,'checklist',90)
)
insert into public.ops_audit_checklist_items(company_id,audit_type_id,section_id,code,label,guidance,photo_required,score_weight,score_source,sort_order,is_required,evidence_rule,action_rule,response_options)
select t.company_id,t.id,s.id,d.code,d.label,d.guidance,d.photo,d.weight,d.source,d.seq,d.source='checklist','on_non_compliance','on_non_compliance',
 '[{"value":"pass","label":"Compliant","is_compliant":true,"requires_action":false,"score":100},{"value":"fail","label":"Non-compliant","is_compliant":false,"requires_action":true,"score":0},{"value":"na","label":"Not applicable (explain)","is_compliant":null,"requires_action":false,"score":null}]'::jsonb
from public.ops_audit_types t cross join definitions d join public.ops_audit_checklist_sections s on s.code=d.area where t.code='physical_station' and s.audit_type_id=t.id
on conflict(audit_type_id,code) do nothing;

-- Keep objective / safety controls binary; use a quality scale for inspectable cleanliness.
update public.ops_audit_checklist_items i set response_options=(select jsonb_agg(o || jsonb_build_object('score',case when o->>'value'='na' then null when (o->>'is_compliant')::boolean then 100 else 0 end)) from jsonb_array_elements(i.response_options) o)
from public.ops_audit_types t where i.audit_type_id=t.id and t.code='physical_station';
update public.ops_audit_checklist_items i set response_options='[{"value":"fantastic","label":"Fantastic · clean, complete, consistently maintained","is_compliant":true,"requires_action":false,"score":100},{"value":"great","label":"Great · clean, minor improvement possible","is_compliant":true,"requires_action":false,"score":80},{"value":"fair","label":"Fair · visible gaps; action required","is_compliant":false,"requires_action":true,"score":50},{"value":"poor","label":"Poor · unacceptable condition; action required","is_compliant":false,"requires_action":true,"score":0},{"value":"na","label":"Not applicable (explain with photo)","is_compliant":null,"requires_action":false,"score":null}]'::jsonb
from public.ops_audit_types t where i.audit_type_id=t.id and t.code='physical_station' and i.code in ('wet_mopping','station_dust','it_assets_clean','fans_clean','waste_control','washroom_toilet_clean');

with options(grp,code,label,metadata,seq) as (values
 ('audit_responsibility','controllable','Within station control','{"exclude_from_score":false,"pending":false}'::jsonb,1),
 ('audit_responsibility','prior_reported','Already reported missing by DA before audit','{"exclude_from_score":true,"pending":false,"applies_to":["shipment"]}'::jsonb,2),
 ('audit_responsibility','external','Outside station control - evidence verified','{"exclude_from_score":true,"pending":false}'::jsonb,3),
 ('audit_responsibility','pending','Responsibility pending investigation','{"exclude_from_score":false,"pending":true}'::jsonb,4),
 ('audit_rating_band','fantastic','Fantastic','{"minimum_score":90}'::jsonb,1),
 ('audit_rating_band','great','Great','{"minimum_score":75}'::jsonb,2),
 ('audit_rating_band','fair','Fair','{"minimum_score":50}'::jsonb,3),
 ('audit_rating_band','poor','Poor','{"minimum_score":0}'::jsonb,4))
insert into public.ops_audit_reference_options(company_id,option_group,code,label,metadata,sort_order)
select distinct t.company_id,o.grp,o.code,o.label,o.metadata,o.seq from public.ops_audit_types t cross join options o where t.code='physical_station'
on conflict(company_id,option_group,code) do nothing;

-- Keep the existing atomic save, CAS, permissions and history, adding the score snapshot.
do $$ declare definition text; begin
 select pg_get_functiondef('public.submit_station_audit_report(uuid,uuid,timestamptz,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,text,text)'::regprocedure) into definition;
 if strpos(definition,'system_cash_amount=n.system_cash_amount,')=0 then raise exception 'Audit submit signature changed; review migration'; end if;
 definition=replace(definition,'system_cash_amount=n.system_cash_amount,','score=n.score,score_snapshot=n.score_snapshot,system_cash_amount=n.system_cash_amount,');
 execute definition;
end $$;

-- Review only responsibility attribution; preserve the original scoring inputs and history.
create or replace function public.review_station_audit_score(p_company uuid,p_audit uuid,p_updated_at timestamptz,p_snapshot jsonb,p_actor uuid,p_name text,p_email text,p_role text)
returns void language plpgsql security definer set search_path=public as $$
declare v public.ops_station_audits%rowtype;
begin
 select * into v from public.ops_station_audits where id=p_audit and company_id=p_company and deleted_at is null for update;
 if not found or v.completed_at is null or v.status_code='closed' then raise exception 'Open submitted audit required'; end if;
 if v.updated_at is distinct from p_updated_at then raise exception 'Audit changed. Refresh before reviewing.'; end if;
 if p_snapshot->>'version'<>'1' or p_snapshot->'inputs' is null then raise exception 'Valid score snapshot required'; end if;
 update public.ops_station_audits set score=(p_snapshot->>'percentage')::numeric,score_snapshot=p_snapshot,updated_at=clock_timestamp() where id=v.id;
 insert into public.ops_station_audit_events(company_id,audit_id,event_type,before_data,after_data,actor_user_id,actor_name,actor_email,actor_role)
 values(p_company,v.id,'score_reviewed',jsonb_build_object('score_snapshot',v.score_snapshot),jsonb_build_object('score_snapshot',p_snapshot),p_actor,p_name,p_email,p_role);
end $$;
revoke all on function public.review_station_audit_score(uuid,uuid,timestamptz,jsonb,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.review_station_audit_score(uuid,uuid,timestamptz,jsonb,uuid,text,text,text) to service_role;
