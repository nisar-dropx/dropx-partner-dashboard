import { NextResponse } from 'next/server';
import { getAuthorization, isCompanyOwner } from '@/lib/authorization';
import { currentAdminAccessSurface } from '@/lib/access-surface';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sources, type TrackerRow, type RecordData } from '@/lib/request-tracker/model';
import links from '@/lib/request-tracker/links.json';
export const dynamic='force-dynamic';
export const maxDuration=60;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function response(value: unknown, status=200){return NextResponse.json(value,{status,headers:{'Cache-Control':'private, no-store'}});}
async function namesFor(value: unknown,companyId:string){
 const ids=new Set<string>();
 function walk(v:unknown){if(typeof v==='string'&&uuid.test(v))ids.add(v);else if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')Object.values(v).forEach(walk);}
 walk(value); if(!ids.size||!supabaseAdmin)return {};
 const selected=[...ids].slice(0,1000); const names:Record<string,string>={};
 const results=await Promise.all([supabaseAdmin.from('profiles').select('id,full_name').eq('company_id',companyId).in('id',selected),supabaseAdmin.from('user_roles').select('id,name').eq('company_id',companyId).in('id',selected),supabaseAdmin.from('stations').select('id,station_code').eq('company_id',companyId).in('id',selected)]);
 for(const result of results)for(const row of result.data??[]){const r=row as unknown as Record<string,string>;names[r.id]=r.full_name||r.name||r.station_code;}
 return names;
}
// Approval rows are current routing snapshots, not immutable timeline events.
async function routingFor(rows: TrackerRow[], companyId: string) {
 const routing: Record<string,RecordData[]>={}; const warnings: {label:string;message:string}[]=[];
 if(!supabaseAdmin)return {routing,warnings};
 for(const adapter of [{kind:'expense_claim',table:'hr_expense_approval_steps',parent:'claim_id'}, {kind:'leave',table:'hr_leave_approval_steps',parent:'request_id'}]) {
  const ids=rows.filter(row=>row.kind===adapter.kind).map(row=>String(row.record.id)).filter(id=>uuid.test(id));
  if(!ids.length)continue;
  const {data,error}=await supabaseAdmin.from(adapter.table).select(`${adapter.parent},step_order,step_name,approver_user_id,status,decided_at,created_at`).eq('company_id',companyId).in(adapter.parent,ids).order('step_order').limit(1000);
  const label=sources.find(source=>source.key===adapter.kind)?.label??adapter.kind;
  if(error){warnings.push({label,message:'Current approval routing could not be loaded.'});continue;}
  for(const item of data??[]){const step=item as unknown as RecordData;const key=`${adapter.kind}:${step[adapter.parent]}`;(routing[key]??=[]).push(step);}
  if(data?.length===1000)warnings.push({label,message:'Approval routing reached the result limit; review the source portal for additional steps.'});
 }
 return {routing,warnings};
}
export async function GET(request:Request){
 try{
  const authorization=await getAuthorization();
  if(!authorization)return response({error:'Please sign in.'},401);
  // Owner scope is intentional: cross-portal HR and financial details are not
  // granted by an ordinary Reports permission or by knowing a request UUID.
  if(currentAdminAccessSurface()!=='dashboard'||!isCompanyOwner(authorization)||!authorization.companyId)return response({error:'Request Tracker is available to company owners in Dashboard.'},403);
  if(!supabaseAdmin)return response({error:'Request sources are temporarily unavailable.'},503);
  const company=authorization.companyId;const params=new URL(request.url).searchParams;
  const kind=params.get('type')??'payment';const query=(params.get('q')??'').trim();const id=params.get('id');
  const offset=Number(params.get('offset')??0);const status=params.get('status')??'';
  if((kind&&!sources.some(s=>s.key===kind))||query.length>160||!Number.isInteger(offset)||offset<0||offset>10000||status.length>80|| (id&&!/^[a-zA-Z0-9_-]{1,160}$/.test(id)))return response({error:'Check the request reference and filters.'},400);
  if(id){
   const {data,error}=await supabaseAdmin.rpc('request_tracker_detail',{p_company:company,p_kind:kind,p_id:id,p_offset:offset});
   if(error){console.error('Request Tracker detail unavailable',error.code);return response({error:'Request history is unavailable. Please retry.'},503);}
   if(!data)return response({error:'Request not found in your company or this source is unavailable.'},404);
   const {data:related,error:linkError}=await supabaseAdmin.rpc('request_tracker_related',{p_company:company,p_kind:kind,p_id:id});
   const outgoing=Object.entries(links).flatMap(([field,target])=>{const v=data.record?.[field];return typeof v==='string'&&uuid.test(v)?[{kind:target,id:v,reference:v,label:sources.find(s=>s.key===target)?.label??target}]:[];});
   const combined=[...outgoing,...(related??[])];const unique=[...new Map(combined.filter(x=>x.id&&!(x.id===id&&x.kind===kind)).map(x=>[`${x.kind}:${x.id}`,x])).values()];
   const context=await routingFor([data],company);const routing=context.routing[`${kind}:${id}`]??[];
   return response({...data,routing,related:unique,names:await namesFor([data,unique,routing],company),warnings:[...(data.warnings??[]),...context.warnings.map(w=>w.message),...(linkError?['Linked records could not be loaded.']:[])]});
  }
  const {data,error}=await supabaseAdmin.rpc('request_tracker_search',{p_company:company,p_kind:kind,p_query:query,p_status:status,p_offset:offset});
  if(error){console.error('Request Tracker search unavailable',error.code);return response({error:'Request sources are unavailable. Please retry.'},503);}
  const context=await routingFor(data?.rows??[],company);
  const rows=(data?.rows??[]).map((row:TrackerRow)=>({...row,routing:context.routing[`${row.kind}:${row.record.id}`]??[]}));
  return response({...data,rows,warnings:[...(data?.warnings??[]),...context.warnings],names:await namesFor(rows,company)});
 }catch(error){console.error('Request Tracker unavailable',error instanceof Error?error.name:'unknown');return response({error:'Unable to load requests. Please retry.'},503);}
}
