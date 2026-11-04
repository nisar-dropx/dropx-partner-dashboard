import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { requirePagePermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { saveDriverReason } from './actions';
export const dynamic = 'force-dynamic';
export default async function DriverReasons() {
  const auth = await requirePagePermission('master_payment_heads', 'access');
  const result = await supabaseAdmin!.from('payment_adhoc_driver_rules').select('*').eq('company_id', requireCompanyId(auth)).order('sort_order');
  if (result.error) throw new Error('Unable to load Adhoc Driver rules.');
  return <AppShell active="Payment Heads" pageCode="master_payment_heads"><section className="panel"><div className="panel-head"><h1>Adhoc Driver · sub-reasons</h1><Link className="button secondary compact" href="/master/payment-heads">Payment Heads</Link></div><div className="panel-body"><p className="subtle">Leave requests mark the selected person Absent and exclude day pay. Service requests require a Fleet vehicle under service or breakdown.</p>{result.data.map(r => <form action={saveDriverReason} key={r.reason_key}><fieldset disabled={!auth.permissions.master_payment_heads?.canEdit} style={{ border: 0, borderBottom: '1px solid #e2e8f0', padding: '12px 0' }}><input type="hidden" name="reason_key" value={r.reason_key} /><div className="form-grid three"><label>Sub-reason<input className="field" name="label" required maxLength={80} defaultValue={r.label} /></label><label>Order<input className="field" type="number" name="sort_order" min="0" max="100" defaultValue={r.sort_order} required /></label><div><label><input type="checkbox" name="is_active" defaultChecked={r.is_active} /> Enabled</label><p className="helper-text">{r.reason_key === 'vehicle_service' ? 'Fleet: Under service / Breakdown' : r.designation_codes.join(' / ') + ' · Absent + no day pay'}</p></div></div><button type="submit" className="button compact">Save</button></fieldset></form>)}</div></section></AppShell>;
}
