import {getAuthorization,hasPermission} from '@/lib/authorization';
import {hasActiveFleetMembership} from '@/lib/fleet-control';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {runFuelPriceLookup} from '@/lib/fleet/fuel-price-worker';
import {readAllRows} from '@/lib/supabase-pagination';
import {withFleetSystemLog} from '@/lib/fleet/system-log';
import {validateMapping,parsePaytap} from '@/lib/fleet/paytap';
export const dynamic='force-dynamic';
export const maxDuration=120;
async function access(edit=false){
 const a=await getAuthorization();if(!a?.companyId)return {error:Response.json({error:'Sign in to Fleet.'},{status:401})};
 if(!supabaseAdmin)return {error:Response.json({error:'Database unavailable.'},{status:503})};
 if(!(a.isMasterOwner||await hasActiveFleetMembership(a.companyId,a.userId))||!(a.isMasterOwner||a.hasAllLocationAccess&&hasPermission(a,'fleet_settings',edit?'edit':'access'))||edit&&a.readOnly)return {error:Response.json({error:'Company-wide Fleet Settings permission is required.'},{status:403})};
 return {auth:a};
}
export async function GET(request:Request){
 const a=await access();if('error'in a)return a.error;
 const page=Math.max(1,Math.min(10000,Number(new URL(request.url).searchParams.get('page'))||1));
 const [c,e,ps,prices,locations,imported,review]=await Promise.all([
  supabaseAdmin!.from('fleet_paytap_connections').select('endpoint_id,enabled,mapping,secret_id,verified_at,last_event_at').eq('company_id',a.auth.companyId!).maybeSingle(),
  supabaseAdmin!.from('fleet_paytap_events').select('id,event_id,received_at,state,reason,payload,fuel_id',{count:'exact'}).eq('company_id',a.auth.companyId!).order('received_at',{ascending:false}).order('id').range((page-1)*20,page*20-1),
  supabaseAdmin!.from('fleet_fuel_price_settings').select('enabled,model,api_secret_id').eq('company_id',a.auth.companyId!).maybeSingle(),
  supabaseAdmin!.from('fleet_fuel_prices').select('id,station_code,city,price_date,fuel_type,status,rate,source_url,source_title,evidence,reason,attempts,last_attempt_at').eq('company_id',a.auth.companyId!).order('created_at',{ascending:false}).limit(100),
  readAllRows(supabaseAdmin!.from('stations').select('id,station_code,city').eq('company_id',a.auth.companyId!).order('id')),
  supabaseAdmin!.from('fleet_paytap_events').select('id',{count:'exact',head:true}).eq('company_id',a.auth.companyId!).eq('state','imported'),
  supabaseAdmin!.from('fleet_paytap_events').select('id',{count:'exact',head:true}).eq('company_id',a.auth.companyId!).eq('state','review')
 ]);
 if(c.error||e.error)return Response.json({error:'PayTap setup is unavailable. Check the integration migration.'},{status:503});
 return Response.json({connection:c.data?{...c.data,secret_id:undefined,hasSecret:Boolean(c.data.secret_id)}:null,events:e.data,total:e.count,page,imported:imported.error?null:imported.count,review:review.error?null:review.count,pricingError:ps.error||prices.error?'Fuel price setup is unavailable.':null,pricing:{enabled:ps.data?.enabled??false,model:ps.data?.model||'gpt-5-mini',hasKey:Boolean(ps.data?.api_secret_id||process.env.OPENAI_API_KEY)},prices:prices.data??[],locations:locations.data??[],canEdit:!a.auth.readOnly&&(a.auth.isMasterOwner||hasPermission(a.auth,'fleet_settings','edit'))},{headers:{'Cache-Control':'private, no-store'}});
}
async function save(request:Request){
 const a=await access(true);if('error'in a)return a.error;
 try{
  const body=await request.json();
  if(body.action==='save_pricing'){
   if(typeof body.enabled!=='boolean'||typeof body.model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/.test(body.model)||body.apiKey&&typeof body.apiKey!=='string')throw Error('Choose valid price lookup settings.');
   if(body.enabled&&!body.apiKey&&!process.env.OPENAI_API_KEY){
    const current=await supabaseAdmin!.from('fleet_fuel_price_settings').select('api_secret_id').eq('company_id',a.auth.companyId!).maybeSingle();
    if(current.error||!current.data?.api_secret_id)throw Error('Save an OpenAI API key before enabling automatic price lookups.');
   }
   const r=await supabaseAdmin!.rpc('fleet_fuel_price_configure',{p_company:a.auth.companyId,p_actor:a.auth.viewerUserId??a.auth.userId,p_enabled:body.enabled,p_model:body.model,p_key:body.apiKey||null});
   if(r.error)throw Error('Could not save price settings. Check the API key format and migration.');
   return Response.json({message:'Internet price settings saved. API keys are kept in Vault and never returned.'});
  }
  if(body.action==='lookup_price'){
   if(!/^\d{4}-\d{2}-\d{2}$/.test(body.date)||!Number.isFinite(Date.parse(body.date))||new Date(body.date).toISOString().slice(0,10)!==body.date||body.date>new Date(Date.now()+330*60000).toISOString().slice(0,10)||!['petrol','diesel'].includes(body.fuelType))throw Error('Choose a valid purchase date and petrol or diesel.');
   const l=await supabaseAdmin!.from('stations').select('station_code,city').eq('company_id',a.auth.companyId!).eq('station_code',body.station).limit(2);
   if(l.error||l.data?.length!==1||!l.data[0].city?.trim())throw Error('Set a unique station city in the location master first.');
   const row={company_id:a.auth.companyId!,station_code:l.data[0].station_code.trim().toUpperCase(),city:l.data[0].city.trim(),price_date:body.date,fuel_type:body.fuelType,requested_by:a.auth.viewerUserId??a.auth.userId};
   const added=await supabaseAdmin!.from('fleet_fuel_prices').upsert(row,{onConflict:'company_id,station_code,price_date,fuel_type',ignoreDuplicates:true});
   if(added.error)throw Error('Could not queue the price lookup.');
   const found=await supabaseAdmin!.from('fleet_fuel_prices').select('id').eq('company_id',row.company_id).eq('station_code',row.station_code).eq('price_date',row.price_date).eq('fuel_type',row.fuel_type).single();
   if(found.error)throw Error('Could not read the price queue.');
   return Response.json(await runFuelPriceLookup(row.company_id,found.data.id));
  }
  if(body.action==='reprocess'){
   const c=await supabaseAdmin!.from('fleet_paytap_connections').select('mapping').eq('company_id',a.auth.companyId!).single();
   const e=await supabaseAdmin!.from('fleet_paytap_events').select('*').eq('company_id',a.auth.companyId!).eq('id',body.id).single();
   if(c.error||e.error)return Response.json({error:'Event not available.'},{status:404});
   const parsed=parsePaytap(e.data.payload,validateMapping(c.data.mapping));
   const result=await supabaseAdmin!.rpc('fleet_paytap_ingest',{p_company:a.auth.companyId,p_event:e.data.event_id,p_hash:e.data.body_hash,p_payload:e.data.payload,p_state:parsed.state,p_reason:parsed.reason,p_fuel:parsed.fuel??null,p_reprocess:true});
   if(result.error)throw Error('Unable to process the event.');
   return Response.json({message:`Event status: ${result.data}`});
  }
  if(body.action!=='save')return Response.json({error:'Unknown action.'},{status:400});
  const mapping=validateMapping(body.mapping);
  if(typeof body.enabled!=='boolean'||body.secret&&typeof body.secret!=='string')throw Error('Invalid settings.');
  const result=await supabaseAdmin!.rpc('fleet_paytap_save_connection',{p_company:a.auth.companyId,p_actor:a.auth.viewerUserId??a.auth.userId,p_enabled:body.enabled,p_mapping:mapping,p_secret:body.secret||null});
  if(result.error)throw Error(result.error.message.includes('Save the PayTap')?'Save the PayTap signing secret before enabling reception.':'Could not save PayTap settings.');
  return Response.json({message:'PayTap settings saved.'});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Unable to save settings.'},{status:400});}
}
export const POST=withFleetSystemLog(save);
