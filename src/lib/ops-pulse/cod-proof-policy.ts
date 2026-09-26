export const CONTROL_TOWER_CC='ct@dropxlogistics.com';
export type ProofExtraction={document_type:'deposit_slip'|'other'|'unclear';readable:boolean;amount:number|null;deposit_date:string|null;remittance_reference:string|null;receipt_reference:string|null;station_code:string|null;deposit_confirmed:boolean;seal_status:'visible'|'missing'|'unclear';seal_clarity:'high'|'medium'|'low'|'not_applicable';seal_issuer:string|null;seal_evidence:string|null};
export function proofVerdict(value:unknown,expected:{amount:number;date:string;reference:string;station:string}) {
 const v=value as ProofExtraction;
 if(!v||!['deposit_slip','other','unclear'].includes(v.document_type)||typeof v.readable!=='boolean'||typeof v.deposit_confirmed!=='boolean'||!['visible','missing','unclear'].includes(v.seal_status)||!['high','medium','low','not_applicable'].includes(v.seal_clarity)||!(v.amount===null||typeof v.amount==='number'&&Number.isFinite(v.amount))||!['deposit_date','remittance_reference','receipt_reference','station_code','seal_issuer','seal_evidence'].every(k=>v[k as keyof ProofExtraction]===null||typeof v[k as keyof ProofExtraction]==='string'))throw new Error('Invalid extraction response.');
 const reasons:string[]=[];
 if(v.document_type!=='deposit_slip')reasons.push('The uploaded image does not clearly show a CMS / bank deposit slip.');
 if(!v.readable)reasons.push('The slip is unreadable. Upload a clear, complete photo.');
 if(v.amount===null)reasons.push('Deposit amount is not readable on the slip.');
 else if(Math.abs(v.amount-expected.amount)>0.01)reasons.push(`Slip amount ${v.amount.toFixed(2)} does not match submitted amount ${expected.amount.toFixed(2)}.`);
 if(!v.deposit_date)reasons.push('Deposit date is not readable on the slip.');
 else if(v.deposit_date!==expected.date)reasons.push(`Slip date ${v.deposit_date} does not match deposit date ${expected.date}.`);
 const normalize=(s:string)=>s.toUpperCase().replace(/[^A-Z0-9]/g,'');
 if(!v.receipt_reference&&!v.remittance_reference)reasons.push('Receipt / transaction number is not readable on the slip.');
 if(v.remittance_reference&&normalize(v.remittance_reference)!==normalize(expected.reference))reasons.push('Remittance code printed on the slip does not match the submitted code.');
 if(v.station_code&&normalize(v.station_code)!==normalize(expected.station))reasons.push('Station code on the slip does not match the selected station.');
 if(v.seal_status==='missing')reasons.push('Radiant / bank / CMS seal is missing. Upload a stamped deposit slip.');
 else if(v.seal_status!=='visible'||!['high','medium'].includes(v.seal_clarity)||!v.seal_evidence?.trim())reasons.push('Radiant / bank / CMS seal is below medium clarity. Upload a clearer photo with a recognisable seal.');
 if(!v.deposit_confirmed)reasons.push('The slip does not show a completed deposit acknowledgement.');
 return {status:reasons.length?'Not valid':'Valid',reason:reasons.join(' ')||'Deposit details match; bank / CMS seal is visible with sufficient clarity.',extracted:v};
}
export function emailList(raw:string) {
 const values=[...new Set(raw.split(/[,;\s]+/).map(s=>s.trim().toLowerCase()).filter(Boolean))];
 if(!values.length||values.length>20||values.some(s=>!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)))throw new Error('Enter valid email addresses, separated by commas (maximum 20).');
 return values;
}
export function proofStatus(value?:string|null){return value==='Valid'||value==='Not valid'||value==='Validation unavailable'?value:'Validation pending';}
export function proofTone(value:string){return value==='Valid'||value==='Not required'?'good':['Not valid','Validation unavailable'].includes(value)?'bad':'warn';}
