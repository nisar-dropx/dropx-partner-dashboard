import type {ProofExtraction} from '@/lib/ops-pulse/cod-proof-policy';
import {formatDashboardDate as formatDate,formatDashboardDateTime as formatDateTime} from '@/lib/date-format';
const money=new Intl.NumberFormat('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
const formatAmount=(value:number|string|null)=>money.format(Number(value)||0);

type Props={result?:Record<string,unknown>|null;checkedAt?:string|null;amount:number|string|null;date:string|null;station:string;reference:string};
export function CodSlipCheckDetails({result,checkedAt,amount,date,station,reference}:Props){
 const extracted=result?.extracted;
 const v=extracted&&typeof extracted==='object'&&!Array.isArray(extracted)?extracted as ProofExtraction:null;
 if(!v||Number(result?.policy_version)<4)return <p className="subtle">Seal check pending. An earlier receipt check does not confirm the seal.</p>;
 const normalize=(value:string)=>value.toUpperCase().replace(/[^A-Z0-9]/g,'');
 const seal=v.seal_status==='visible'&&['high','medium'].includes(v.seal_clarity)&&v.seal_evidence?'Seal visible':v.seal_status==='missing'?'Seal missing':'Seal unclear';
 const rows=[
  ['Deposited amount',`₹${formatAmount(amount)}`,v.amount==null?'Not readable':`₹${formatAmount(v.amount)}`,v.amount!=null&&Math.abs(Number(amount)-v.amount)<=0.01?'Match':'Mismatch / unreadable'],
  ['Deposit date',formatDate(date),v.deposit_date?formatDate(v.deposit_date):'Not readable',v.deposit_date===date?.slice(0,10)?'Match':'Mismatch / unreadable'],
  ['Station',station||'—',v.station_code||'Not visible',!v.station_code?'Not checked — not visible':normalize(v.station_code)===normalize(station)?'Match':'Mismatch'],
  ['Marketplace remittance',reference||'—',v.remittance_reference||'Not printed',!v.remittance_reference?'Not checked — not printed':normalize(v.remittance_reference)===normalize(reference)?'Match':'Mismatch'],
  ['Receipt / transaction number','Required',v.receipt_reference||v.remittance_reference||'Not readable',v.receipt_reference||v.remittance_reference?'Present':'Missing'],
  ['Bank / CMS seal','Required · medium clarity or better',v.seal_issuer||'Issuer not fully readable',seal],
  ['Seal clarity','Medium or high',v.seal_clarity||'Not assessed',['high','medium'].includes(v.seal_clarity)?'Sufficient':'Insufficient'],
  ['Deposit acknowledgement','Required',v.deposit_confirmed?'Visible':'Not visible',v.deposit_confirmed?'Present':'Missing']
 ];
 return <details style={{margin:'12px 0',whiteSpace:'normal'}}><summary style={{cursor:'pointer',fontWeight:600,color:seal==='Seal visible'?'#15803d':'#b91c1c'}}>Validation checks · {seal}</summary>
  <p><strong>Checked:</strong> {formatDateTime(checkedAt)} · Slip version {String(result?.proof_version??'—')}</p>
  <div className="table-wrap"><table><thead><tr><th>Check</th><th>Submitted / required</th><th>Read from slip</th><th>Result</th></tr></thead><tbody>{rows.map(([label,expected,read,outcome])=><tr key={label}><td>{label}</td><td>{expected}</td><td>{read}</td><td style={{color:/Mismatch|Missing|Seal missing|Seal unclear|Insufficient/.test(outcome)?'#b91c1c':undefined}}>{outcome}</td></tr>)}</tbody></table></div>
  <p><strong>Seal evidence:</strong> {v.seal_evidence||'No identifiable bank / CMS seal could be read.'}</p>
  <p className="subtle">A printed logo or signature alone does not count as a seal. These checks verify visible document details, not seal authenticity or bank settlement.</p>
 </details>;
}
