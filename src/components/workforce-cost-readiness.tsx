import Link from 'next/link';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AuthorizationContext } from '@/lib/authorization';
import { hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { todayKolkata } from '@/lib/ops-pulse/cod';

export async function WorkforceCostReadiness({auth}:{auth:AuthorizationContext}) {
  if(!supabaseAdmin) return null;
  const company=requireCompanyId(auth),today=todayKolkata();
  const [workers,maps]=await Promise.all([
    supabaseAdmin.from('workforce').select('id,location_id').eq('company_id',company).eq('is_active',true).is('deleted_at',null).limit(1000),
    supabaseAdmin.from('field_executive_provider_mappings').select('workforce_id,provider_member_id,payment_method_id,payment_values,effective_from,effective_to,delivery_rate,guarantee_amount').eq('company_id',company).eq('status','active').lte('effective_from',today).limit(1000),
  ]);
  if(workers.error || maps.error || workers.data?.length===1000 || maps.data?.length===1000) return <section className="panel"><div className="panel-body">Mapping readiness could not be confirmed. <a href="https://dashboard.dropxlogistics.com/provider-mapping">Review ID &amp; pay mapping</a></div></section>;
  const scoped=(workers.data??[]).filter(w=>auth.hasAllLocationAccess || auth.locationScopeIds.includes(w.location_id));
  let unlinked=0,unpriced=0;
  for(const w of scoped){const active=(maps.data??[]).filter(m=>m.workforce_id===w.id && (!m.effective_to||m.effective_to>=today));
    if(!active.some(m=>String(m.provider_member_id??'').trim()))unlinked++;
    else if(!active.some(m=>m.payment_method_id&&Object.keys(m.payment_values??{}).length || Number(m.delivery_rate)>0 || Number(m.guarantee_amount)>0))unpriced++;
  }
  return <section className={`panel message-panel ${unlinked+unpriced?'error':'success'}`}><div className="panel-body"><strong>Workforce cost readiness · {unlinked+unpriced} people need setup</strong><p className="subtle">{unlinked} without provider IDs · {unpriced} without pay setup. Review this queue after onboarding and daily shipment uploads. Unresolved mappings leave CPS provisional.</p><a className="button" href="https://dashboard.dropxlogistics.com/provider-mapping">Open ID &amp; pay mapping</a>{hasPermission(auth,'cps_unmapped','access')&&<> <Link className="button" href="/cps?view=unmapped">View affected shipments</Link></>}</div></section>;
}
