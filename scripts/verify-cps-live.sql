-- Integration checks use an isolated transaction; no test costs survive.
-- Run only on the DropX database after the CPS migration.
begin;
set local statement_timeout='30s';
do $$
declare
  company uuid;
  cost_id uuid;
  actor uuid := gen_random_uuid();
  whole jsonb;
  scoped jsonb;
  one_day jsonb;
  actual numeric;
  expected numeric;
  rejected boolean := false;
begin
  select company_id into strict company from public.stations where station_code='KOZA' and is_active limit 1;
  if not exists(select 1 from public.stations where company_id=company and station_code='KGQA' and is_active) then
    raise exception 'Expected integration test allocation group unavailable';
  end if;
  whole := public.ops_cps_live_snapshot(company,'2026-09-01','2026-09-10',array['KOZA','KGQA']);
  if exists(select 1 from jsonb_to_recordset(whole->'daily') d(total numeric,da numeric,utr numeric,van numeric,other numeric)
    where abs(total-da-utr-van-other)>.000001) then raise exception 'Daily cost heads do not reconcile'; end if;
  if (public.ops_cps_live_snapshot(gen_random_uuid(),'2026-09-01','2026-09-10',array['KOZA'])->'daily') <> '[]'::jsonb then
    raise exception 'Company isolation failed'; end if;
  begin
    perform public.ops_cps_live_snapshot(company,'2026-08-31','2026-09-01',array['KOZA']);
  exception when others then rejected:=true;
  end;
  if not rejected then raise exception 'Cross-month request accepted'; end if;
  rejected := false;
  begin
    perform public.ops_cps_live_snapshot(company,current_date+40,current_date+40,array['KOZA']);
  exception when others then rejected:=true;
  end;
  if not rejected then raise exception 'Future period accepted'; end if;
  if has_function_privilege('anon','public.ops_cps_live_snapshot(uuid,date,date,text[])','EXECUTE')
    or has_function_privilege('authenticated','public.ops_cps_live_snapshot(uuid,date,date,text[])','EXECUTE')
    or has_table_privilege('authenticated','public.ops_cps_cost_inputs','SELECT')
    or has_table_privilege('authenticated','public.ops_cps_cost_inputs','INSERT') then
    raise exception 'Browser role can bypass portal scope'; end if;
  if not has_function_privilege('service_role','public.ops_cps_live_snapshot(uuid,date,date,text[])','EXECUTE') then
    raise exception 'Server role cannot calculate'; end if;
  insert into public.cps_station_targets(company_id,station_code,target_cps,effective_from)
    values(company,'KOZA',10,'2000-02-01'),(company,'KOZA',20,'2000-02-15');
  one_day := public.ops_cps_live_snapshot(company,'2000-02-14','2000-02-14',array['KOZA']);
  if (one_day->'daily'->0->>'target')::numeric<>10 then raise exception 'Earlier target overwritten'; end if;
  one_day := public.ops_cps_live_snapshot(company,'2000-02-15','2000-02-15',array['KOZA']);
  if (one_day->'daily'->0->>'target')::numeric<>20 then raise exception 'Target effective date ignored'; end if;
  insert into public.ops_cps_cost_inputs(company_id,label,head,station_codes,amount,frequency,allocation,effective_from,effective_to,created_by,updated_by)
    values(company,'CPS integration rollback fixture','UTR',array['KOZA','KGQA'],31000,'monthly','delivery_share','2026-08-01','2026-08-31',actor,actor)
    returning id into cost_id;
  whole := public.ops_cps_live_snapshot(company,'2026-08-01','2026-08-31',array['KOZA','KGQA']);
  scoped := public.ops_cps_live_snapshot(company,'2026-08-01','2026-08-31',array['KOZA']);
  select sum(amount) into actual from jsonb_to_recordset(whole->'breakup') l(source text,sub_head text,amount numeric)
    where source='CPS Inputs' and sub_head='CPS integration rollback fixture';
  if abs(actual-31000)>.000001 then raise exception 'Monthly shared cost does not reconcile: %',actual; end if;
  select sum(amount) into expected from jsonb_to_recordset(whole->'breakup') l(station_code text,source text,sub_head text,amount numeric)
    where source='CPS Inputs' and sub_head='CPS integration rollback fixture' and station_code='KOZA';
  select sum(amount) into actual from jsonb_to_recordset(scoped->'breakup') l(source text,sub_head text,amount numeric)
    where source='CPS Inputs' and sub_head='CPS integration rollback fixture';
  if abs(actual-expected)>.000001 then raise exception 'Scope changed allocation denominator'; end if;
  if exists(select 1 from jsonb_array_elements(scoped->'daily') d where d->>'station_code'<>'KOZA') then
    raise exception 'Station filter leaked'; end if;
  one_day := public.ops_cps_live_snapshot(company,'2026-08-14','2026-08-14',array['KOZA']);
  select sum(amount) into actual from jsonb_to_recordset(one_day->'breakup') l(source text,sub_head text,amount numeric)
    where source='CPS Inputs' and sub_head='CPS integration rollback fixture';
  select sum(amount) into expected from jsonb_to_recordset(scoped->'breakup') l(work_date date,source text,sub_head text,amount numeric)
    where source='CPS Inputs' and sub_head='CPS integration rollback fixture' and work_date='2026-08-14';
  if abs(actual-expected)>.000001 then raise exception 'Daily and monthly cost differ'; end if;
  update public.ops_cps_cost_inputs set is_active=false,updated_by=actor where id=cost_id;
  if not exists(select 1 from public.ops_cps_cost_input_audit where input_id=cost_id and previous_record->>'is_active'='true') then
    raise exception 'Cost edit audit missing'; end if;
  whole := public.ops_cps_live_snapshot(company,'2026-08-01','2026-08-31',array['KOZA','KGQA']);
  if exists(select 1 from jsonb_array_elements(whole->'breakup') l where l->>'sub_head'='CPS integration rollback fixture') then
    raise exception 'Disabled input still charged'; end if;
end $$;
rollback;
select 'PASS: period guards, company/station isolation, grants, cost reconciliation, effective targets, full-month allocation, daily parity, disable and audit; fixtures rolled back' result;
