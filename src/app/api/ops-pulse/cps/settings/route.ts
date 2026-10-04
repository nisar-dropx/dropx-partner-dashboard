import { getAuthorization, hasPermission } from '@/lib/authorization';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { cpsScope } from '@/lib/ops-pulse/cps-data';
import { isoDate } from '@/lib/ops-pulse/cps';
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
export const dynamic='force-dynamic';
export async function GET() {
  const auth=await getAuthorization();
  if(!auth||!hasPermission(auth,'cps_inputs','access'))return reply({error:'CPS setup access required.'},403);
  const scope=await cpsScope(auth,{});
  if(!supabaseAdmin)return reply({error:'Database unavailable.'},503);
  const [people,expenses,designations]=await Promise.all([
    supabaseAdmin.from('ops_cps_people_policies').select('id,designation_code,designation_name,mode,head,label,allocation,effective_from,updated_at').eq('company_id',scope.companyId).order('designation_name').order('effective_from',{ascending:false}).limit(1000),
    supabaseAdmin.from('ops_cps_expense_policies').select('id,cost_label,mode,effective_from,updated_at').eq('company_id',scope.companyId).order('cost_label').order('effective_from',{ascending:false}).limit(1000),
    supabaseAdmin.from('designations').select('code,name').eq('company_id',scope.companyId).order('name').limit(1000),
  ]);
  if(people.error||expenses.error||designations.error||people.data?.length===1000||expenses.data?.length===1000||designations.data?.length===1000)return reply({error:'Settings could not be loaded completely.'},503);
  const newRoles=(designations.data??[]).filter(d=>!people.data?.some(p=>p.designation_code===d.code)).map(d=>({designation_code:d.code,designation_name:d.name,mode:'excluded',head:'UTR',label:'Station staff CTC',allocation:'equal',effective_from:''}));
  return reply({people:[...(people.data??[]),...newRoles],expenses:expenses.data,canEdit:!auth.readOnly&&auth.hasAllLocationAccess&&hasPermission(auth,'cps_inputs','edit')});
}
export async function POST(request:Request) {
  try {
    const auth=await getAuthorization();
    if(!auth||auth.readOnly||!hasPermission(auth,'cps_inputs','edit'))return reply({error:'CPS setup edit access required. Exit preview before saving.'},403);
    if(!supabaseAdmin)return reply({error:'Database unavailable.'},503);
    const scope=await cpsScope(auth,{}),body=await request.json();
    if(!body||typeof body!=='object'||Array.isArray(body))return reply({error:'Invalid settings.'},400);
    if(body.kind==='period') {
      if(!['payment','cashbook'].includes(body.source)||!/^[-a-f0-9]{36}$/i.test(body.source_id)||!isoDate(body.period_from)||!isoDate(body.period_to)||body.period_to<body.period_from||Date.parse(body.period_to)-Date.parse(body.period_from)>366*86400000||String(body.reason||'').trim().length<3)return reply({error:'Enter valid billing dates and a correction reason.'},400);
      const row=await supabaseAdmin.from(body.source==='payment'?'payment_requests':'cps_cashbook_daily').select(body.source==='payment'?'id,station_code,location_id,location_code':'id,station_code').eq('company_id',scope.companyId).eq('id',body.source_id).maybeSingle();
      const data=row.data as Record<string,unknown>|null;
      if(row.error||!data||!scope.all.some(s=>data.location_id?s.id===data.location_id:s.station_code===(data.station_code||data.location_code)))return reply({error:'Bill is outside your station access.'},403);
      const result=await supabaseAdmin.from('ops_cps_expense_periods').upsert({company_id:scope.companyId,source:body.source,source_id:body.source_id,period_from:body.period_from,period_to:body.period_to,reason:String(body.reason).trim().slice(0,500),updated_by:auth.userId,updated_at:new Date().toISOString()},{onConflict:'company_id,source,source_id'});
      if(result.error)throw Error('Bill period could not be saved.');
      return reply({ok:true});
    }
    if(!auth.hasAllLocationAccess)return reply({error:'Company-wide CPS setup access is required to change shared allocation rules.'},403);
    if(!isoDate(body.effective_from))return reply({error:'Choose a valid effective date.'},400);
    let table:string,values:Record<string,unknown>;
    if(body.kind==='people') {
      if(!['excluded','home','managed'].includes(body.mode)||!['UTR','DA','Van','Overhead'].includes(body.head)||!['equal','delivery_share'].includes(body.allocation))return reply({error:'Choose a valid allocation rule.'},400);
      const designation=await supabaseAdmin.from('designations').select('code,name').eq('company_id',scope.companyId).eq('code',String(body.designation_code)).maybeSingle();
      if(designation.error||!designation.data)return reply({error:'Designation not found.'},400);
      const label=String(body.label||'').trim();
      if(label.length<3||label.length>80)return reply({error:'Use a group label of 3–80 characters, without employee names.'},400);
      table='ops_cps_people_policies';values={designation_code:designation.data.code,designation_name:designation.data.name,mode:body.mode,head:body.head,label,allocation:body.allocation};
    } else if(body.kind==='expense') {
      const label=String(body.cost_label||'').trim().toLowerCase();
      if(label.length<3||label.length>120||!['monthly','transaction'].includes(body.mode))return reply({error:'Choose a cost label and recognition method.'},400);
      table='ops_cps_expense_policies';values={cost_label:label,mode:body.mode};
    } else return reply({error:'Unknown setting.'},400);
    const payload={...values,effective_from:body.effective_from,updated_at:new Date().toISOString(),updated_by:auth.userId};
    const result=body.id
      ?await supabaseAdmin.from(table).update(payload).eq('company_id',scope.companyId).eq('id',body.id).eq('updated_at',body.updated_at).select('id')
      :await supabaseAdmin.from(table).insert({...payload,company_id:scope.companyId}).select('id');
    if(result.error?.code==='23505')return reply({error:'A rule already exists for this effective date. Edit that revision or choose a new date.'},409);
    if(result.error||!result.data?.length)return reply({error:'Settings changed or could not be saved. Refresh before retrying.'},409);
    return reply({ok:true});
  }catch {return reply({error:'Settings could not be saved. Check the values and retry.'},500);}
}
