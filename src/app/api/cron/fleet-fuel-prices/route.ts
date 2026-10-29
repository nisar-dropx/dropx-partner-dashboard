import {timingSafeEqual} from 'node:crypto';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {runFuelPriceLookup} from '@/lib/fleet/fuel-price-worker';
export const dynamic='force-dynamic';
export const maxDuration=120;
export async function GET(request:Request){
 const secret=process.env.CRON_SECRET,actual=request.headers.get('authorization')||'',expected=`Bearer ${secret}`;
 if(!secret||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return Response.json({error:'Unauthorized'},{status:401});
 if(!supabaseAdmin)return Response.json({error:'Database unavailable'},{status:503});
 const settings=await supabaseAdmin.from('fleet_fuel_price_settings').select('company_id').eq('enabled',true);
 if(settings.error)return Response.json({error:'Settings unavailable'},{status:503});
 if(!settings.data?.length)return Response.json({processed:0});
 const queue=await supabaseAdmin.from('fleet_fuel_prices').select('id,company_id').in('company_id',settings.data.map(s=>s.company_id)).neq('status','ready').lt('attempts',3).or(`last_attempt_at.is.null,last_attempt_at.lt.${new Date(Date.now()-6*3600000).toISOString()}`).order('last_attempt_at',{nullsFirst:true}).order('created_at').limit(1);
 if(queue.error)return Response.json({error:'Price queue unavailable'},{status:503});
 // One lookup per run, cached by station/day/fuel. A slow provider never blocks webhook receipt.
 try{for(const row of queue.data??[])await runFuelPriceLookup(row.company_id,row.id);return Response.json({processed:queue.data?.length||0});}
 catch(e){return Response.json({error:e instanceof Error?e.message:'Lookup unavailable'},{status:503});}
}
