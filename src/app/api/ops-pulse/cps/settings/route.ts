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
  const [people,expenses,components,fields,designations,attendance,fallbacks]=await Promise.all([
    supabaseAdmin.from('ops_cps_people_policies').select('id,designation_code,designation_name,mode,head,label,allocation,effective_from,updated_at').eq('company_id',scope.companyId).order('designation_name').order('effective_from',{ascending:false}).limit(1000),
    supabaseAdmin.from('ops_cps_expense_policies').select('id,cost_label,mode,effective_from,updated_at').eq('company_id',scope.companyId).order('cost_label').order('effective_from',{ascending:false}).limit(1000),
    supabaseAdmin.from('ops_cps_component_policies').select('id,component_code,label,mode,effective_from,updated_at').eq('company_id',scope.companyId).order('component_code').order('effective_from',{ascending:false}).limit(1000),
    supabaseAdmin.from('payment_fields').select('code,label,calculation_type,is_custom_production').eq('company_id',scope.companyId).order('label').limit(1000),
    supabaseAdmin.from('designations').select('code,name').eq('company_id',scope.companyId).order('name').limit(1000),
    supabaseAdmin.from('workforce_attendance_capture_settings').select('capture_method,minimum_daily_deliveries,review_below_deliveries,effective_from,change_reason').eq('company_id',scope.companyId).order('effective_from',{ascending:false}).limit(1000),
    supabaseAdmin.from('ops_cps_production_fallback_policies').select('*').eq('company_id',scope.companyId).order('field_code').order('effective_from',{ascending:false}).limit(1000),
  ]);
  if(fallbacks.error||fallbacks.data?.length===1000||attendance.error||components.error||fields.error||components.data?.length===1000||fields.data?.length===1000||people.error||expenses.error||designations.error||people.data?.length===1000||expenses.data?.length===1000||designations.data?.length===1000)return reply({error:'Settings could not be loaded completely.'},503);
  const newRoles=(designations.data??[]).filter(d=>!people.data?.some(p=>p.designation_code===d.code)).map(d=>({designation_code:d.code,designation_name:d.name,mode:'excluded',head:'UTR',label:'Station staff CTC',allocation:'equal',effective_from:''}));
  return reply({fallbacks:fallbacks.data??[],attendance:attendance.data??[],people:[...(people.data??[]),...newRoles],expenses:expenses.data,components:components.data,fields:fields.data,canEdit:!auth.readOnly&&auth.hasAllLocationAccess&&hasPermission(auth,'cps_inputs','edit')});
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
    if(body.kind==='attendance') {
      const minimum=Number(body.minimum_daily_deliveries),review=String(body.review_below_deliveries??'').trim()?Number(body.review_below_deliveries):null;
      if(!['biometric','shipment_data'].includes(body.capture_method)||!/^\d{4}-\d{2}-01$/.test(body.effective_from)||!isoDate(body.effective_from)||String(body.change_reason??'').trim().length<3
        ||(body.capture_method==='shipment_data'&&(!Number.isInteger(minimum)||minimum<1||minimum>100000))
        ||(review!==null&&(!Number.isInteger(review)||review<1||review>100000)))return reply({error:'Enter a valid month, delivery thresholds and change reason.'},400);
      const saved=await supabaseAdmin.rpc('save_workforce_attendance_capture_setting_v2',{p_company_id:scope.companyId,p_capture_method:body.capture_method,p_minimum_daily_deliveries:body.capture_method==='shipment_data'?minimum:null,p_review_below_deliveries:review,p_effective_from:body.effective_from,p_change_reason:String(body.change_reason).trim().slice(0,250),p_actor_user_id:auth.userId});
      if(saved.error)return reply({error:saved.error.message},409);
      return reply({ok:true});
    }
    if(!isoDate(body.effective_from))return reply({error:'Choose a valid effective date.'},400);
    let table:string,values:Record<string,unknown>;
    if(body.kind==='fallback') {
      if(!['disabled','associate_average','associate_then_station','associate_station_company'].includes(body.mode)||!Number.isInteger(Number(body.lookback_months))||Number(body.lookback_months)<1||Number(body.lookback_months)>12||!Number.isInteger(Number(body.minimum_history_days))||Number(body.minimum_history_days)<1||Number(body.minimum_history_days)>366)return reply({error:'Choose a valid fallback and history window.'},400);
      const field=await supabaseAdmin.from('payment_fields').select('code,is_custom_production').eq('company_id',scope.companyId).eq('code',String(body.field_code)).maybeSingle();
      if(field.error||!field.data?.is_custom_production)return reply({error:'Choose a custom production field from this company.'},400);
      table='ops_cps_production_fallback_policies';values={field_code:field.data.code,mode:body.mode,lookback_months:Number(body.lookback_months),minimum_history_days:Number(body.minimum_history_days)};
    } else if(body.kind==='people') {
      if(!['excluded','home','managed'].includes(body.mode)||!['UTR','DA','Van','Overhead'].includes(body.head)||!['equal','delivery_share'].includes(body.allocation))return reply({error:'Choose a valid allocation rule.'},400);
      const designation=await supabaseAdmin.from('designations').select('code,name').eq('company_id',scope.companyId).eq('code',String(body.designation_code)).maybeSingle();
      if(designation.error||!designation.data)return reply({error:'Designation not found.'},400);
      const label=String(body.label||'').trim();
      if(label.length<3||label.length>80)return reply({error:'Use a group label of 3–80 characters, without employee names.'},400);
      table='ops_cps_people_policies';values={designation_code:designation.data.code,designation_name:designation.data.name,mode:body.mode,head:body.head,label,allocation:body.allocation};
    } else if(body.kind==='component') {
      if(!['fleet','workforce','pnl_only'].includes(body.mode))return reply({error:'Choose a valid cost source.'},400);
      const field=await supabaseAdmin.from('payment_fields').select('code,label,calculation_type,is_custom_production').eq('company_id',scope.companyId).eq('code',String(body.component_code)).maybeSingle();
      if(field.error||!field.data)return reply({error:'Payment field not found in this company.'},400);
      if(body.mode==='fleet' && !['fixed_daily','fixed_monthly'].includes(field.data.calculation_type))return reply({error:'Only fixed rental fields can use Fleet. Per-package and production payments remain included.'},400);
      table='ops_cps_component_policies';values={component_code:field.data.code.trim().toUpperCase(),label:field.data.label,mode:body.mode};
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
