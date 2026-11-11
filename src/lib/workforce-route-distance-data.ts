import type { SupabaseClient } from '@supabase/supabase-js';
import type { RouteDistanceContext } from './workforce-route-distance';
import { readAllRows } from './supabase-pagination';

export async function loadRouteDistanceContext(db:SupabaseClient,companyId:string,workforceIds:string[],from:string,to:string):Promise<RouteDistanceContext> {
  const empty:RouteDistanceContext={enabledFrom:null,rows:[],manual:[],rateOverrides:[]};
  if(!workforceIds.length)return empty;
  // Payable kilometres come exclusively from the committed manual input ledger.
  // Route capture settings must not disable uploaded units or enable a maps fallback.
  const context:RouteDistanceContext={...empty,enabledFrom:from,source:'manual'};
  const start=from;
  for(let i=0;i<workforceIds.length;i+=100){
    const ids=workforceIds.slice(i,i+100);
    const [manual,rates]=await Promise.all([
      readAllRows(db.from('workforce_custom_production_inputs').select('id,workforce_id,station_id,field_code_snapshot,work_date,units').eq('company_id',companyId).in('workforce_id',ids).eq('field_code_snapshot','KM_RUN').gte('work_date',start).lte('work_date',to).order('id')),
      readAllRows(db.from('workforce_payment_field_overrides').select('id,workforce_id,station_id,field_code_snapshot,effective_from,effective_to,input_value').eq('company_id',companyId).in('workforce_id',ids).eq('field_code_snapshot','KM_RUN').lte('effective_from',to).gte('effective_to',start).order('id'))
    ]);
    if(manual.error||rates.error)throw new Error('Kilometre inputs could not be verified. Please retry.');
    context.manual.push(...manual.data??[]);context.rateOverrides.push(...rates.data??[]);
  }
  return context;
}
