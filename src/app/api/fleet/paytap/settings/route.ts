import {getAuthorization,hasPermission} from '@/lib/authorization';
import {hasActiveFleetMembership} from '@/lib/fleet-control';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {runFuelPriceLookup} from '@/lib/fleet/fuel-price-worker';
import {readAllRows} from '@/lib/supabase-pagination';
import {withFleetSystemLog} from '@/lib/fleet/system-log';
import {validateMapping,parsePaytap} from '@/lib/fleet/paytap';
import {parsePaytapStatementFile,statementBodyHash,statementEventId} from '@/lib/fleet/paytap-statement';
export const dynamic='force-dynamic';
export const maxDuration=120;
async function access(edit=false){
 const a=await getAuthorization();if(!a?.companyId)return {error:Response.json({error:'Sign in to Fleet.'},{status:401})};
 if(!supabaseAdmin)return {error:Response.json({error:'Database unavailable.'},{status:503})};
 if(!(a.isMasterOwner||await hasActiveFleetMembership(a.companyId,a.userId))||!(a.isMasterOwner||a.hasAllLocationAccess&&hasPermission(a,'fleet_settings',edit?'edit':'access'))||edit&&a.readOnly)return {error:Response.json({error:'Company-wide Fleet Settings permission is required.'},{status:403})};
 return {auth:a};
}
async function reprocessEvent(companyId:string,mapping:unknown,event:{event_id:string;body_hash:string;payload:Record<string,unknown>}){
 const parsed=parsePaytap(event.payload,validateMapping(mapping));
 const result=await supabaseAdmin!.rpc('fleet_paytap_ingest',{p_company:companyId,p_event:event.event_id,p_hash:event.body_hash,p_payload:event.payload,p_state:parsed.state,p_reason:parsed.reason,p_fuel:parsed.fuel??null,p_reprocess:true});
 if(result.error)throw Error('Unable to process the event.');
 return String(result.data);
}
export async function GET(request:Request){
 const a=await access();if('error'in a)return a.error;
 const page=Math.max(1,Math.min(10000,Number(new URL(request.url).searchParams.get('page'))||1));
 const [c,e,ps,prices,locations,imported,review,ignored,cards]=await Promise.all([
  supabaseAdmin!.from('fleet_paytap_connections').select('endpoint_id,enabled,mapping,secret_id,verified_at,last_event_at').eq('company_id',a.auth.companyId!).maybeSingle(),
  supabaseAdmin!.from('fleet_paytap_events').select('id,event_id,received_at,state,reason,payload,fuel_id',{count:'exact'}).eq('company_id',a.auth.companyId!).order('received_at',{ascending:false}).order('id').range((page-1)*20,page*20-1),
  supabaseAdmin!.from('fleet_fuel_price_settings').select('enabled,model,api_secret_id').eq('company_id',a.auth.companyId!).maybeSingle(),
  supabaseAdmin!.from('fleet_fuel_prices').select('id,station_code,city,price_date,fuel_type,status,rate,source_url,source_title,evidence,reason,attempts,last_attempt_at').eq('company_id',a.auth.companyId!).order('created_at',{ascending:false}).limit(100),
  readAllRows(supabaseAdmin!.from('stations').select('id,station_code,city').eq('company_id',a.auth.companyId!).order('id')),
  supabaseAdmin!.from('fleet_paytap_events').select('id',{count:'exact',head:true}).eq('company_id',a.auth.companyId!).eq('state','imported'),
  supabaseAdmin!.from('fleet_paytap_events').select('id',{count:'exact',head:true}).eq('company_id',a.auth.companyId!).eq('state','review'),
  supabaseAdmin!.from('fleet_paytap_events').select('id',{count:'exact',head:true}).eq('company_id',a.auth.companyId!).eq('state','ignored'),
  supabaseAdmin!.from('fleet_paytap_cards').select('card_ending,kit_number,masked_card,paytap_vehicle_id,vehicle_id,fleet_vehicles!inner(vehicle_no,station_code,fuel_type)').eq('company_id',a.auth.companyId!).order('card_ending')
 ]);
 if(c.error||e.error)return Response.json({error:'PayTap setup is unavailable. Check the integration migration.'},{status:503});
 const cardRows=(cards.data??[]).map((row:any)=>({
  card_ending:row.card_ending,kit_number:row.kit_number,masked_card:row.masked_card,paytap_vehicle_id:row.paytap_vehicle_id,
  vehicle_id:row.vehicle_id,vehicle_no:row.fleet_vehicles?.vehicle_no??null,station_code:row.fleet_vehicles?.station_code??null,fuel_type:row.fleet_vehicles?.fuel_type??null
 }));
 return Response.json({
  connection:c.data?{...c.data,secret_id:undefined,hasSecret:Boolean(c.data.secret_id)}:null,
  events:e.data,total:e.count,page,
  imported:imported.error?null:imported.count,review:review.error?null:review.count,ignored:ignored.error?null:ignored.count,
  cards:cards.error?[]:cardRows,cardsError:cards.error?'Card map is unavailable. Apply the PayTap Core card migration.':null,
  pricingError:ps.error||prices.error?'Fuel price setup is unavailable.':null,
  pricing:{enabled:ps.data?.enabled??false,model:ps.data?.model||'gpt-5-mini',hasKey:Boolean(ps.data?.api_secret_id||process.env.OPENAI_API_KEY)},
  prices:prices.data??[],locations:locations.data??[],
  canEdit:!a.auth.readOnly&&(a.auth.isMasterOwner||hasPermission(a.auth,'fleet_settings','edit'))
 },{headers:{'Cache-Control':'private, no-store'}});
}
async function save(request:Request){
 const a=await access(true);if('error'in a)return a.error;
 try{
  const contentType=request.headers.get('content-type')||'';
  if(contentType.includes('multipart/form-data')){
   const form=await request.formData();
   if(String(form.get('action')||'')!=='import_statement')throw Error('Unknown upload action.');
   const file=form.get('file');
   if(!(file instanceof File)||file.size<=0||file.size>8*1024*1024)throw Error('Upload a PayTap fleet_card Excel file under 8 MB.');
   const buffer=Buffer.from(await file.arrayBuffer());
   const conn=await supabaseAdmin!.from('fleet_paytap_connections').select('mapping').eq('company_id',a.auth.companyId!).single();
   if(conn.error)throw Error('Save PayTap connection settings before importing statements.');
   const mapping=validateMapping(conn.data.mapping||{paths:{},paymentTypes:[],successStatuses:[],fuelProducts:[],amountDivisor:1,estimateMissingQuantity:true});
   const {bodies,skipped}=parsePaytapStatementFile(buffer);
   if(!bodies.length)throw Error('No debit fuel rows found in the statement.');
   const counts={imported:0,duplicate:0,review:0,ignored:0,other:0};
   for(const body of bodies){
    const parsed=parsePaytap(body,mapping);
    const eventId=statementEventId(body);
    const hash=statementBodyHash(body);
    const result=await supabaseAdmin!.rpc('fleet_paytap_ingest',{
     p_company:a.auth.companyId,p_event:eventId,p_hash:hash,p_payload:body,
     p_state:parsed.state,p_reason:parsed.reason,p_fuel:parsed.fuel??null,p_reprocess:true
    });
    if(result.error)throw Error(`Import stopped on ${eventId}: ${result.error.message}`);
    const state=String(result.data);
    if(state in counts)(counts as any)[state]+=1;else counts.other+=1;
   }
   return Response.json({message:`Imported statement · ${counts.imported} imported · ${counts.duplicate} duplicate · ${counts.review} review · ${counts.ignored} ignored · ${skipped} rows skipped.`,counts,skipped});
  }
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
  if(body.action==='upsert_cards'){
   if(!Array.isArray(body.cards)||body.cards.length===0)throw Error('Provide at least one card mapping.');
   const r=await supabaseAdmin!.rpc('fleet_paytap_upsert_cards',{p_company:a.auth.companyId,p_actor:a.auth.viewerUserId??a.auth.userId,p_cards:body.cards});
   if(r.error)throw Error(r.error.message||'Could not save card mappings. Check vehicle registrations exist in Fleet.');
   return Response.json({message:`Saved ${r.data} PayTap card mapping${Number(r.data)===1?'':'s'}.`});
  }
  if(body.action==='reprocess'){
   const c=await supabaseAdmin!.from('fleet_paytap_connections').select('mapping').eq('company_id',a.auth.companyId!).single();
   const e=await supabaseAdmin!.from('fleet_paytap_events').select('*').eq('company_id',a.auth.companyId!).eq('id',body.id).single();
   if(c.error||e.error)return Response.json({error:'Event not available.'},{status:404});
   const state=await reprocessEvent(a.auth.companyId!,c.data.mapping,e.data);
   return Response.json({message:`Event status: ${state}`});
  }
  if(body.action==='reprocess_all'){
   const c=await supabaseAdmin!.from('fleet_paytap_connections').select('mapping').eq('company_id',a.auth.companyId!).single();
   if(c.error)throw Error('PayTap connection is unavailable.');
   const limit=Math.max(1,Math.min(200,Number(body.limit)||100));
   const events=await supabaseAdmin!.from('fleet_paytap_events').select('id,event_id,body_hash,payload,state')
    .eq('company_id',a.auth.companyId!).eq('state','review').order('received_at',{ascending:true}).order('id').limit(limit);
   if(events.error)throw Error('Could not load review events.');
   const counts:{[k:string]:number}={};
   for(const event of events.data??[]){
    const state=await reprocessEvent(a.auth.companyId!,c.data.mapping,event as any);
    counts[state]=(counts[state]||0)+1;
   }
   const summary=Object.entries(counts).map(([k,v])=>`${v} ${k}`).join(' · ')||'none';
   return Response.json({message:`Reprocessed ${(events.data??[]).length} review event(s): ${summary}.`,counts,processed:(events.data??[]).length});
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
