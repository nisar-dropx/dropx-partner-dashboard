import Link from 'next/link';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AuthorizationContext } from '@/lib/authorization';
import { hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { todayKolkata } from '@/lib/ops-pulse/cod';

export async function WorkforceCostReadiness({auth}:{auth:AuthorizationContext}) {
  if(!supabaseAdmin) return null;
  const company=requireCompanyId(auth),today=todayKolkata();
  const [workers,designations,maps,allocations]=await Promise.all([
    supabaseAdmin.from('workforce').select('id,location_id,designation_id,designation').eq('company_id',company).eq('is_active',true).is('deleted_at',null).limit(1000),
    supabaseAdmin.from('designations').select('id,code,name,is_field_operations,provider_mapping_required').eq('company_id',company).eq('is_active',true).limit(1000),
    supabaseAdmin.from('field_executive_provider_mappings').select('workforce_id,provider_member_id,payment_method_id,payment_values,effective_from,effective_to,delivery_rate,guarantee_amount').eq('company_id',company).in('status',['active','closed']).lte('effective_from',today).limit(1000),
    supabaseAdmin.from('workforce_payment_allocations').select('workforce_id,payment_method_id,payment_values,effective_from,effective_to').eq('company_id',company).in('status',['active','closed']).lte('effective_from',today).limit(1000),
  ]);
  if(workers.error || designations.error || maps.error || allocations.error || [workers,designations,maps,allocations].some(result=>result.data?.length===1000)) return <section className="panel"><div className="panel-body">Payment readiness could not be confirmed. <a href="https://dashboard.dropxlogistics.com/provider-id-mapping">Review workforce pay setup</a></div></section>;
  const policyById=new Map((designations.data??[]).map(row=>[String(row.id),row]));
  const policyByName=new Map((designations.data??[]).flatMap(row=>[row.code,row.name]
    .map(value=>[String(value??'').trim().toLowerCase(),row] as const)));
  const scoped=(workers.data??[]).filter(w=>{
    const policy=policyById.get(String(w.designation_id??''))??policyByName.get(String(w.designation??'').trim().toLowerCase());
    return policy?.is_field_operations && (auth.hasAllLocationAccess || auth.locationScopeIds.includes(w.location_id));
  });
  let unlinked=0,unpriced=0,directUnpriced=0;
  for(const w of scoped){const active=(maps.data??[]).filter(m=>m.workforce_id===w.id && (!m.effective_to||m.effective_to>=today));
    const policy=policyById.get(String(w.designation_id??''))??policyByName.get(String(w.designation??'').trim().toLowerCase());
    if(policy?.provider_mapping_required!==false){
      if(!active.some(m=>String(m.provider_member_id??'').trim()))unlinked++;
      else if(!active.some(m=>m.payment_method_id&&Object.keys(m.payment_values??{}).length || Number(m.delivery_rate)>0 || Number(m.guarantee_amount)>0))unpriced++;
    } else {
      const configuredProvider=active.some(m=>String(m.provider_member_id??'').trim()&&(m.payment_method_id&&Object.keys(m.payment_values??{}).length || Number(m.delivery_rate)>0 || Number(m.guarantee_amount)>0));
      const direct=(allocations.data??[]).filter(a=>a.workforce_id===w.id&&(!a.effective_to||a.effective_to>=today));
      if(!configuredProvider&&!direct.some(a=>a.payment_method_id&&Object.keys(a.payment_values??{}).length))directUnpriced++;
    }
  }
  const total=unlinked+unpriced+directUnpriced;
  return <section className={`panel message-panel ${total?'error':'success'}`}><div className="panel-body"><strong>Workforce cost readiness · {total} people need setup</strong><p className="subtle">{unlinked} without required provider IDs · {unpriced} provider-linked without pay setup · {directUnpriced} without a provider-linked or direct pay allocation. Unresolved setup leaves CPS provisional.</p><a className="button" href="https://dashboard.dropxlogistics.com/provider-id-mapping">Open workforce pay setup</a>{directUnpriced?<><Link className="button" href="/provider-mapping/direct-pay">Open direct pay</Link></>:null}{hasPermission(auth,'cps_unmapped','access')&&<> <Link className="button" href="/cps?view=unmapped">View cost gaps</Link></>}</div></section>;
}
