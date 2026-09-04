begin;

-- Discussion feed should only record human comments / stage completions.
-- RCA item saves and takeaway saves already live on the review / items tables.
create or replace function public.ops_mutate_manager_review(p_company uuid,p_actor uuid,p_review uuid,p_action text,p_data jsonb)
returns void language plpgsql security invoker set search_path=public as $$
declare v_review ops_performance_reviews; v_step ops_performance_review_steps; v_item ops_performance_review_items;
  v_item_id uuid; v_note text; v_type text='review'; v_next integer; v_log boolean=false;
begin
  if not exists(select 1 from profiles where id=p_actor and company_id=p_company and is_active) then raise exception 'Your account is unavailable.'; end if;
  select * into v_review from ops_performance_reviews where id=p_review and company_id=p_company for update;
  if not found then raise exception 'Review unavailable.'; end if;
  select * into v_step from ops_performance_review_steps where review_id=p_review and step_order=v_review.current_step_order;
  if p_action in ('item','summary','comment') and nullif(p_data->>'expected_review_version','')::timestamptz is distinct from v_review.updated_at then
    raise exception 'This review was updated by someone else. Refresh and try again.';
  end if;
  if p_action='summary' then
    update ops_performance_reviews set review_summary=nullif(p_data->>'summary',''),updated_at=clock_timestamp(),updated_by=p_actor where id=p_review;
  elsif p_action='item' then
    select * into v_item from ops_performance_review_items where review_id=p_review and metric_key=p_data->>'metric_key' for update;
    insert into ops_performance_review_items(company_id,review_id,metric_key,metric_label,root_cause,corrective_action,action_owner,due_date,status,severity,actual_value,target_value,target_direction,created_by,updated_by,updated_at,closed_by,closed_at)
    values(p_company,p_review,p_data->>'metric_key',p_data->>'metric_label',p_data->>'root_cause',p_data->>'corrective_action',p_data->>'action_owner',
      (p_data->>'due_date')::date,p_data->>'status',p_data->>'severity',nullif(p_data->>'actual_value','')::numeric,nullif(p_data->>'target_value','')::numeric,p_data->>'target_direction',p_actor,p_actor,clock_timestamp(),
      case when p_data->>'status'='done' then p_actor end,case when p_data->>'status'='done' then now() end)
    on conflict(review_id,metric_key) do update set root_cause=excluded.root_cause,corrective_action=excluded.corrective_action,action_owner=excluded.action_owner,
      due_date=excluded.due_date,status=excluded.status,updated_by=p_actor,updated_at=excluded.updated_at,closed_by=excluded.closed_by,closed_at=excluded.closed_at
    returning id into v_item_id;
    update ops_performance_reviews set updated_at=clock_timestamp(),updated_by=p_actor where id=p_review;
  elsif p_action in ('comment','complete') then
    v_note=nullif(trim(p_data->>'note'),'');
    if p_action='complete' then
      if v_review.status='closed' or v_step.id is distinct from nullif(p_data->>'step_id','')::uuid or v_step.status<>'pending' then raise exception 'The review has moved to another stage. Refresh to continue.'; end if;
      update ops_performance_review_steps set status='completed',completed_at=now(),completed_by=p_actor,feedback=coalesce(v_note,feedback),updated_at=now() where id=v_step.id;
      select min(step_order) into v_next from ops_performance_review_steps where review_id=p_review and status='pending';
      update ops_performance_reviews set status=case when v_next is null then 'closed' else 'in_review' end,current_step_order=coalesce(v_next,current_step_order),
        closed_at=case when v_next is null then now() end,closed_by=case when v_next is null then p_actor end,updated_by=p_actor,updated_at=clock_timestamp() where id=p_review;
      v_note=coalesce(v_note,'Reviewed — no additional comments.');
    elsif v_note is null then raise exception 'Enter your comment.';
    end if;
    v_log=true;
  else raise exception 'Unsupported review action.';
  end if;
  if v_log then
    insert into ops_performance_review_updates(company_id,review_id,review_item_id,update_type,note,created_by,author_name,author_role,stage_label)
    values(p_company,p_review,v_item_id,v_type,v_note,p_actor,p_data->>'author_name',p_data->>'author_role',coalesce(v_step.reviewer_role,'Completed review'));
  end if;
end $$;

-- Recover vehicle timings that remained on the review row (e.g. KTUR) and never
-- landed in ops_performance_connections — only when that station/day has none yet.
insert into public.ops_performance_connections(company_id,station_id,service_date,label,arrival_at,unloading_at,clearance_at,created_by,updated_by,updated_by_name)
select r.company_id,r.station_id,r.source_date,'Connection 1',
  (r.source_date + r.vehicle_arrival_time) at time zone 'Asia/Kolkata',
  case when r.unloading_complete_time is not null then
    (r.source_date + r.unloading_complete_time + case when r.unloading_complete_time < r.vehicle_arrival_time then interval '1 day' else interval '0' end) at time zone 'Asia/Kolkata' end,
  case when r.station_clear_time is not null and r.unloading_complete_time is not null then
    (r.source_date + r.station_clear_time
      + case when r.station_clear_time < r.unloading_complete_time then interval '1 day' else interval '0' end
      + case when r.unloading_complete_time < r.vehicle_arrival_time then interval '1 day' else interval '0' end) at time zone 'Asia/Kolkata' end,
  r.started_by,r.updated_by,'Previous entry'
from public.ops_performance_reviews r
where r.vehicle_arrival_time is not null
  and not exists (
    select 1 from public.ops_performance_connections c
    where c.company_id=r.company_id and c.station_id=r.station_id and c.service_date=r.source_date
  );

commit;
