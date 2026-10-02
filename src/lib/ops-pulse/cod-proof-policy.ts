export const CONTROL_TOWER_CC='ct@dropxlogistics.com';
export type ProofExtraction={uncertain_fields?:string[];document_type:'deposit_slip'|'other'|'unclear';readable:boolean;amount:number|null;deposit_date:string|null;remittance_reference:string|null;receipt_reference:string|null;station_code:string|null;deposit_confirmed:boolean;seal_status:'visible'|'missing'|'unclear';seal_clarity:'high'|'medium'|'low'|'not_applicable';seal_issuer:string|null;seal_evidence:string|null};
export function proofVerdict(value:unknown,expected:{amount:number;date:string;reference:string;station:string}) {
 const v=value as ProofExtraction;
 if(!v||!['deposit_slip','other','unclear'].includes(v.document_type)||typeof v.readable!=='boolean'||typeof v.deposit_confirmed!=='boolean'||!['visible','missing','unclear'].includes(v.seal_status)||!['high','medium','low','not_applicable'].includes(v.seal_clarity)||!(v.amount===null||typeof v.amount==='number'&&Number.isFinite(v.amount))||!['deposit_date','remittance_reference','receipt_reference','station_code','seal_issuer','seal_evidence'].every(k=>v[k as keyof ProofExtraction]===null||typeof v[k as keyof ProofExtraction]==='string'))throw new Error('Invalid extraction response.');
 const uncertain=v.uncertain_fields||[];
 if(!Array.isArray(uncertain)||uncertain.some(k=>!['amount','deposit_date','station_code','remittance_reference','receipt_reference'].includes(k)))throw new Error('Invalid handwriting uncertainty response.');
 const failures:string[]=[],unclear:string[]=[];
 // The decision intentionally uses only the three operational controls requested by the business.
 // Other extracted fields remain useful context, but handwriting in them must not reject a slip.
 if(v.document_type==='other')failures.push('The uploaded image is not a CMS / bank deposit slip.');
 else if(v.document_type==='unclear')unclear.push('The document type is unclear; confirm that the full CMS / bank deposit slip is visible.');
 if(v.amount===null||uncertain.includes('amount'))unclear.push('The deposit amount is not clear enough to compare.');
 else if(Math.abs(v.amount-expected.amount)>0.01)failures.push(`Slip amount ${v.amount.toFixed(2)} does not match submitted amount ${expected.amount.toFixed(2)}.`);
 if(v.seal_status==='missing')failures.push('Bank / CMS seal is missing. Upload a stamped deposit slip.');
 else if(v.seal_status!=='visible'||!['high','medium'].includes(v.seal_clarity))unclear.push('Bank / CMS seal is not clear enough; medium clarity is required.');
 if(failures.length)return {status:'Not valid',reason:[...failures,...unclear].join(' '),extracted:v};
 if(unclear.length)return {status:'Details unclear',reason:unclear.join(' '),extracted:v};
 return {status:'Valid',reason:'CMS / bank deposit slip confirmed; amount matches; seal is visible.',extracted:v};
}
export function emailList(raw:string) {
 const values=[...new Set(raw.split(/[,;\s]+/).map(s=>s.trim().toLowerCase()).filter(Boolean))];
 if(!values.length||values.length>20||values.some(s=>!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)))throw new Error('Enter valid email addresses, separated by commas (maximum 20).');
 return values;
}
export function proofStatus(value?:string|null){return value==='Valid'||value==='Not valid'||value==='Returned'?value:'Review pending';}
export function proofStatusLabel(value?:string|null){return proofStatus(value);}
export function proofTone(value:string){return value==='Valid'||value==='Not required'?'good':['Returned','Not valid'].includes(value)?'bad':'warn';}

// Independent readings that disagree are not evidence of a confirmed mismatch.
export function reconcileProofReadings(first:ProofExtraction,second:ProofExtraction){
 const keys=['amount','deposit_date','station_code','remittance_reference','receipt_reference'] as const;
 const normalized=(value:unknown)=>typeof value==='string'?value.toUpperCase().replace(/[^A-Z0-9]/g,''):value;
 const uncertain=new Set([...(first.uncertain_fields||[]),...(second.uncertain_fields||[])]);
 for(const key of keys)if(normalized(first[key])!==normalized(second[key]))uncertain.add(key);
 return {...second,uncertain_fields:[...uncertain]};
}
