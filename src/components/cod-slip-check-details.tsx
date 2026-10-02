import type {ProofExtraction} from '@/lib/ops-pulse/cod-proof-policy';
import {formatDashboardDateTime as formatDateTime} from '@/lib/date-format';
const cellStyle={whiteSpace:'normal' as const,overflowWrap:'anywhere' as const};
const money=new Intl.NumberFormat('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
const formatAmount=(value:number|string|null)=>money.format(Number(value)||0);

type Props={result?:Record<string,unknown>|null;checkedAt?:string|null;amount:number|string|null;date:string|null;station:string;reference:string;status?:string|null};
export function CodSlipCheckDetails({result,checkedAt,amount,status}:Props){
 const extracted=result?.extracted;
 const v=extracted&&typeof extracted==='object'&&!Array.isArray(extracted)?extracted as ProofExtraction:null;
 if(status==='Review pending'||status==='Validation pending'||status==='Checking'||!v)return <p className="subtle">Manual review pending. The upload is already recorded.</p>;
 const seal=v.seal_status==='visible'&&['high','medium'].includes(v.seal_clarity)?'Seal visible':v.seal_status==='missing'?'Seal missing':'Seal unclear';
 const uncertain=v.uncertain_fields||[];
 const rows=[
  ['Document','CMS / bank deposit slip',v.document_type==='deposit_slip'?'Deposit slip':v.document_type==='other'?'Other document':'Unclear',v.document_type==='deposit_slip'?'Confirmed':v.document_type==='other'?'Not a deposit slip':'Needs clearer view'],
  ['Deposited amount',amount==null?'Not available':`₹${formatAmount(amount)}`,v.amount==null?'Not readable':`₹${formatAmount(v.amount)}`,amount!=null&&v.amount!=null&&Math.abs(Number(amount)-v.amount)<=0.01?'Match':'Mismatch / unreadable'],
  ['Bank / CMS seal','Medium clarity or better',v.seal_issuer||v.seal_evidence||'Issuer text not required',seal]
 ].map(row=>row[0]==='Deposited amount'&&uncertain.includes('amount')?[...row.slice(0,3),'Amount unclear']:row);
 return <details style={{margin:'12px 0',whiteSpace:'normal'}}><summary style={{cursor:'pointer',fontWeight:600,color:seal==='Seal visible'?'#15803d':'#b91c1c'}}>Slip checks · 3 controls</summary>
  <p><strong>Checked:</strong> {formatDateTime(checkedAt)} · Slip version {String(result?.proof_version??'—')}</p>
  <div className="table-wrap"><table style={{width:'100%',minWidth:0,tableLayout:'fixed'}}><thead><tr><th style={cellStyle}>Check</th><th style={cellStyle}>Submitted / required</th><th style={cellStyle}>Read from slip</th><th style={cellStyle}>Result</th></tr></thead><tbody>{rows.map(([label,expected,read,outcome])=><tr key={label}><td style={cellStyle}>{label}</td><td style={cellStyle}>{expected}</td><td style={cellStyle}>{read}</td><td style={{...cellStyle,color:/Mismatch|Missing|Seal missing|Seal unclear|Insufficient/.test(outcome)?'#b91c1c':undefined}}>{outcome}</td></tr>)}</tbody></table></div>
  <p><strong>Seal evidence:</strong> {v.seal_evidence||'No identifiable bank / CMS seal could be read.'}</p>
  <p className="subtle">Only document type, deposited amount and a medium-or-better bank/CMS seal decide the result. Date, station handwriting and reference fields are context only.</p>
 </details>;
}
