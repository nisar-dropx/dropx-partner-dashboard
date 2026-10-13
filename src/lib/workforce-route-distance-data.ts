import type { SupabaseClient } from '@supabase/supabase-js';
import type { RouteDistanceContext } from './workforce-route-distance';
import { readAllRows } from './supabase-pagination';

export async function loadRouteDistanceContext(db:SupabaseClient,companyId:string,workforceIds:string[],from:string,to:string):Promise<RouteDistanceContext> {
  const empty:RouteDistanceContext={enabledFrom:null,rows:[],manual:[],rateOverrides:[]};
  if(!workforceIds.length)return empty;
  const cfg=await db.from('workforce_route_distance_settings').select('enabled,effective_from').eq('company_id',companyId).maybeSingle();
  if(cfg.error)throw new Error('Route distance configuration is unavailable. Please retry.');
  if(!cfg.data?.enabled||cfg.data.effective_from>to)return empty;
  const context={...empty,enabledFrom:String(cfg.data.effective_from)};
  const start=[from,context.enabledFrom].sort().at(-1)!;
  for(let i=0;i<workforceIds.length;i+=100){
    const ids=workforceIds.slice(i,i+100);
    const [routes,manual,rates]=await Promise.all([
      readAllRows(db.from('workforce_route_distances').select('id,workforce_id,station_id,mapping_id,work_date,status,reason,distance_km,departure_km,delivery_km,return_km,calculated_at').eq('company_id',companyId).in('workforce_id',ids).gte('work_date',start).lte('work_date',to).order('id')),
      readAllRows(db.from('workforce_custom_production_inputs').select('id,workforce_id,station_id,field_code_snapshot,work_date,units').eq('company_id',companyId).in('workforce_id',ids).eq('field_code_snapshot','KM_RUN').gte('work_date',start).lte('work_date',to).order('id')),
      readAllRows(db.from('workforce_payment_field_overrides').select('id,workforce_id,station_id,field_code_snapshot,effective_from,effective_to,input_value').eq('company_id',companyId).in('workforce_id',ids).eq('field_code_snapshot','KM_RUN').lte('effective_from',to).gte('effective_to',start).order('id'))
    ]);
    if(routes.error||manual.error||rates.error)throw new Error('Kilometre inputs could not be verified. Please retry.');
    context.rows.push(...routes.data??[]);context.manual.push(...manual.data??[]);context.rateOverrides.push(...rates.data??[]);
  }
  return context;
}
