import {supabaseAdmin} from '@/lib/supabase-admin';
import {readAllRows} from '@/lib/supabase-pagination';
import {getWheelseyeAccessToken} from '@/lib/wheelseye';
import {loadWheelseyeMovement} from '@/lib/wheelseye-history';
import {loadGpsPolicy} from '@/lib/fleet/gps-policy-server';
import {saveDailyWheelseyeKm} from '@/lib/fleet/gps-storage';
import {istDate,shiftDay} from '@/lib/fleet/daily-report';
export const dynamic='force-dynamic';
export const maxDuration=120;
export async function GET(request:Request){
 const secret=process.env.CRON_SECRET?.trim();
 if(!secret||request.headers.get('authorization')!==`Bearer ${secret}`)return Response.json({error:'Unauthorized'},{status:401});
 // Shared repository: this scheduled collector belongs only to Fleet production.
 if(process.env.VERCEL_PROJECT_ID!=='prj_rJCXZ3d6muOHnfPgtM2E0ze4Qo7d')return Response.json({skipped:'Not Fleet project'});
 if(!supabaseAdmin)return Response.json({error:'Database unavailable'},{status:503});
 const started=Date.now(),today=istDate(),yesterday=shiftDay(today,-1);
 const companies=await supabaseAdmin.from('wheelseye_settings').select('company_id').eq('is_enabled',true);
 if(companies.error)return Response.json({error:'GPS settings unavailable'},{status:503});
 let updated=0,failed=0,deferred=0;
 for(const {company_id:companyId} of companies.data??[]){
  if(Date.now()-started>85000){deferred++;continue;}
  try{
   const token=await getWheelseyeAccessToken(companyId);if(!token)continue;
   const [vehicles,policy]=await Promise.all([readAllRows(supabaseAdmin.from('fleet_vehicles').select('id,vehicle_no,status').eq('company_id',companyId).order('id')),loadGpsPolicy(companyId)]);
   if(vehicles.error){failed++;continue;}
   const url=new URL('https://api.wheelseye.com/currentLoc');url.searchParams.set('accessToken',token);
   const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(15000)}),body=await response.json();
   if(!response.ok||!Array.isArray(body?.data?.list)){failed++;continue;}
   const normalize=(value:string)=>value.toUpperCase().replace(/[^A-Z0-9]/g,'');
   const devices=new Set(body.data.list.map((row:{vehicleNumber?:string})=>normalize(row.vehicleNumber||'')));
   const saved=await readAllRows(supabaseAdmin.from('fleet_daily_km').select('id,vehicle_no,movement_date,journey_location_check').eq('company_id',companyId).eq('source','wheelseye').gte('movement_date',yesterday).lte('movement_date',today).order('id'));
   if(saved.error){failed++;continue;}
   const checks=new Map((saved.data??[]).map(row=>[`${row.vehicle_no}|${row.movement_date}`,row.journey_location_check]));
   const pairs=(vehicles.data??[]).filter(v=>devices.has(normalize(v.vehicle_no))&&!['sold','disposed','returned'].includes(v.status)).flatMap(v=>[yesterday,today].map(date=>({vehicle:v.vehicle_no,date,check:checks.get(`${v.vehicle_no}|${date}`)}))).filter(p=>p.date===today||!p.check||p.check.end?.state==='pending'||p.check.end?.state==='unverified').sort((a,b)=>(a.check?.checkedAt||'').localeCompare(b.check?.checkedAt||''));
   for(let i=0;i<pairs.length;i+=3){
    if(Date.now()-started>85000){deferred+=pairs.length-i;break;}
    await Promise.all(pairs.slice(i,i+3).map(async p=>{try{const movement=await loadWheelseyeMovement(token,p.vehicle,p.date,policy);const result=await saveDailyWheelseyeKm(companyId,p.vehicle,p.date,movement.summary);if(result==='updated'||result==='needs_review')updated++;else failed++;}catch{failed++;}}));
   }
  }catch{failed++;}
 }
 return Response.json({updated,failed,deferred},{headers:{'Cache-Control':'no-store'}});
}
