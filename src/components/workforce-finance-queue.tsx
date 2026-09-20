import {supabaseAdmin} from '@/lib/supabase-admin';
import type {AuthorizationContext} from '@/lib/authorization';
import {PendingLink} from '@/components/pending-link';

export async function WorkforceFinanceQueue({companyId,authorization,status}:{companyId:string;authorization:AuthorizationContext;status?:string}) {
  if(!supabaseAdmin) return <p role="alert">Finance queue is unavailable.</p>;
  const statuses=['pending','approved','processing','processed','returned','rejected'];
  let query=supabaseAdmin.from('payment_requests').select('id,request_no,requested_for_name,location_code,amount,status,created_at,processed_at,utr_cin,details',{count:'exact'}).eq('company_id',companyId).eq('source_system','WORKFORCE_PAYROLL').order('created_at',{ascending:false}).order('id').limit(100);
  if(!authorization.hasAllLocationAccess) query=query.in('location_id',authorization.locationScopeIds.length ? authorization.locationScopeIds:['00000000-0000-0000-0000-000000000000']);
  if(status && statuses.includes(status)) query=query.eq('status',status);
  const result=await query;
  return <section className="panel"><div className="panel-head"><div><h2>Confirmed Workforce payroll</h2><p className="subtle">Frozen associate amounts from Workforce. Finance approval → Federal Bank processing → payment status returned to Workforce and DropX One.</p></div><PendingLink className="button secondary" href="/payments/approvals">Finance approvals</PendingLink></div>
    <div className="panel-body"><form method="get" className="payout-period-filter"><label>Payment status<select name="payrollStatus" className="field" defaultValue={status ?? ''}><option value="">All statuses</option>{statuses.map(value=><option key={value} value={value}>{value}</option>)}</select></label><button className="button secondary" type="submit">Filter payroll</button><PendingLink href="/payments/process">Payment processing</PendingLink></form>
      {result.error ? <p role="alert">Confirmed payroll could not be loaded. Please retry.</p>:<><p className="subtle">Showing {result.data?.length ?? 0} of {result.count ?? 0} matching requests, newest first. Use Finance Reports for the full register.</p><div className="table-wrap"><table><thead><tr><th>Associate / payroll</th><th>Station</th><th>Amount</th><th>Status</th><th>Bank reference</th></tr></thead><tbody>{(result.data ?? []).map(row=><tr key={row.id}><td><strong>{row.requested_for_name}</strong><div>{row.request_no}</div><small>{String(row.details?.run_number ?? '')} · {String(row.details?.period_start ?? '')} – {String(row.details?.period_end ?? '')}</small></td><td>{row.location_code}</td><td>{new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(Number(row.amount))}</td><td>{row.status}</td><td>{row.utr_cin ?? 'Awaiting payment'}{row.processed_at ? <small> · {new Date(row.processed_at).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'})}</small>:null}</td></tr>)}{!result.data?.length ? <tr><td colSpan={5}>No confirmed payroll requests match this view. Confirm a clean payroll in Workforce to send it here.</td></tr>:null}</tbody></table></div></>}
    </div></section>;
}
