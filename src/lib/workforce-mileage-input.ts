/** Shared server-side input contract. The database rechecks policy, scope and payable history. */
export function parseMileageClaim(form: FormData) {
 const value=(key:string)=>String(form.get(key)??'').trim();
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 const date=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
 if(!uuid.test(value('workforce_id'))||!uuid.test(value('policy_id')))throw new Error('Choose an associate and station policy.');
 const km=value('kilometres');
 if(!/^\d+(\.\d{1,2})?$/.test(km)||Number(km)<=0||Number(km)>10000)throw new Error('Enter positive kilometres with at most two decimals.');
 if(!date(value('work_date'))||!date(value('posting_date')))throw new Error('Choose valid work and payroll posting dates.');
 if(value('posting_date')<value('work_date'))throw new Error('Posting cannot precede the work date.');
 if(value('reference').length<3||value('reference').length>200||value('evidence_reference').length<3||value('evidence_reference').length>500||value('notes').length<10||value('notes').length>1500)throw new Error('Enter a unique claim reference, evidence reference and detailed verification notes.');
 return {p_workforce:value('workforce_id'),p_policy:value('policy_id'),p_km:Number(km),p_date:value('work_date'),p_posting:value('posting_date'),p_reference:value('reference'),p_evidence:value('evidence_reference'),p_notes:value('notes')};
}
