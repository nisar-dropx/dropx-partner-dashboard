import {supabaseAdmin} from '@/lib/supabase-admin';
import type {AuthorizationContext} from '@/lib/authorization';
import {PendingLink} from '@/components/pending-link';

export async function WorkforceFinanceQueue({audience="workforce",companyId,authorization,period,status}:{audience?:"workforce"|"helpers";companyId:string;authorization:AuthorizationContext;period?:{mode:string;month:string;day:string;from:string;to:string};status?:string}) {
  if(!supabaseAdmin) return <p role="alert">Finance queue is unavailable.</p>;
  const statuses=['pending','approved','processing','processed','returned','rejected'];
  const subjectLabel=audience==='helpers'?'Helper':'Workforce';
  const sourceSystem=audience==='helpers'?'HELPER_PAYROLL':'WORKFORCE_PAYROLL';
  let query=supabaseAdmin.from('payment_requests').select('id,request_no,requested_for_name,location_code,amount,status,created_at,processed_at,utr_cin,details',{count:'exact'}).eq('company_id',companyId).eq('source_system',sourceSystem).order('created_at',{ascending:false}).order('id').limit(100);
  if(!authorization.hasAllLocationAccess) query=query.in('location_id',authorization.locationScopeIds.length ? authorization.locationScopeIds:['00000000-0000-0000-0000-000000000000']);
  if(status && statuses.includes(status)) query=query.eq('status',status);
  const result=await query;
  return <section className="panel"><div className="panel-head"><h2>Confirmed {subjectLabel} payroll</h2><PendingLink className="button secondary" href="/payments/approvals">Finance approvals</PendingLink></div>
    <div className="panel-body"><form method="get" className="payout-period-filter"><input name="audience" type="hidden" value={audience}/>{period?<><input name="period" type="hidden" value={period.mode}/><input name="month" type="hidden" value={period.month}/><input name="day" type="hidden" value={period.day}/><input name="from" type="hidden" value={period.from}/><input name="to" type="hidden" value={period.to}/></>:null}<label>Payment status<select name="payrollStatus" className="field" defaultValue={status ?? ''}><option value="">All statuses</option>{statuses.map(value=><option key={value} value={value}>{value}</option>)}</select></label><button className="button secondary" type="submit">Filter payroll</button><PendingLink className="button secondary" href="/payments/process">Payment processing</PendingLink></form>
      {result.error ? <p role="alert">Confirmed payroll could not be loaded. Please retry.</p>:<>{result.data?.length ? <p className="subtle">{result.data.length} of {result.count ?? 0} payroll requests</p> : null}<div className="table-wrap"><table><thead><tr><th>Associate / payroll</th><th>Station</th><th>Amount</th><th>Status</th><th>Bank reference</th></tr></thead><tbody>{(result.data ?? []).map(row=><tr key={row.id}><td><strong>{row.requested_for_name}</strong><div>{row.request_no}</div><small>{String(row.details?.run_number ?? '')} · {String(row.details?.period_start ?? '')} – {String(row.details?.period_end ?? '')}</small></td><td>{row.location_code}</td><td>{new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(Number(row.amount))}</td><td>{row.status}</td><td>{row.utr_cin ?? 'Awaiting payment'}{row.processed_at ? <small> · {new Date(row.processed_at).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'})}</small>:null}</td></tr>)}{!result.data?.length ? <tr><td colSpan={5}>No confirmed {subjectLabel.toLowerCase()} payroll requests match this view.</td></tr>:null}</tbody></table></div></>}
    </div></section>;
}
