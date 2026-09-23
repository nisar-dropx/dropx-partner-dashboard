// Pure daily-slip policy shared by the report, export and scheduled reminders.
export type PendingStation = { id:string; station_code:string; station_name:string|null; station_email?:string|null; hide_from_location_list?:boolean|null; providers?:unknown; location_models?:unknown };
export type PendingSlip = { id:string; location_id:string|null; deposit_date:string|null; cod_period_from:string|null; cod_period_to:string|null; cod_date:string|null; remittance_code?:string|null; reference_no:string|null; deposited_amount:number|string|null; validated_amount:number|string|null; validation_status:string; remarks:string|null; validation_remarks:string|null; submitter_name:string|null; created_at:string; attachments:unknown; deposit_slip_attachments:unknown };
export const pendingStatuses = ['Missing slip','Slip missing proof','Rejected','Short','Excess','Duplicate review','Pending verification','Complete'] as const;
export type PendingStatus = typeof pendingStatuses[number];
export function validReportDate(date:string) { return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date+'T00:00:00Z')) && new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date; }
export function codClient(station:PendingStation) {
 const relation=(v:unknown)=>{const r=(Array.isArray(v)?v[0]:v) as {code?:string;name?:string}|null;return `${r?.code||''} ${r?.name||''}`.toLowerCase();};
 const value=relation(station.providers)+' '+relation(station.location_models);
 return /amazon|edsp|xpt/.test(value)?'amazon':/flipkart|odh|mdh/.test(value)?'flipkart':'';
}
export function isCodReportStation(station:PendingStation) {return Boolean(codClient(station))&&!station.hide_from_location_list&&!/^TEST(?:$|[\s_-])/i.test(station.station_code.trim());}
export function nullableMoney(value:unknown) {if(value==null||value==='')return null;const n=Number(value);return Number.isFinite(n)?Math.round(n*100)/100:null;}
export function hasSlipProof(slip:PendingSlip) { return [slip.deposit_slip_attachments,slip.attachments].some(value=>Array.isArray(value)&&value.some(item=>item?.storage_path&&item?.storage_bucket)); }
export function buildCodPendingRows(stations:PendingStation[],slips:PendingSlip[],date:string,now=new Date()) {
 if(!validReportDate(date))throw new Error('Choose a valid report date.');
 const deadline=new Date(date+'T20:30:00+05:30');
 return stations.filter(isCodReportStation).map(station=>{
  const entries=slips.filter(s=>s.location_id===station.id&&s.deposit_date===date).sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));
  const seen=new Set<string>(),unique:PendingSlip[]=[];let duplicates=0;
  for(const s of entries){const code=String(s.remittance_code||s.reference_no||'').trim().toUpperCase();const key=code||s.id;if(seen.has(key)){duplicates++;continue;}seen.add(key);unique.push(s);}
  const amount=unique.length?unique.reduce((sum,s)=>sum+(nullableMoney(s.deposited_amount)||0),0):null;
  const expected=unique.length&&unique.every(s=>nullableMoney(s.validated_amount)!=null)?unique.reduce((sum,s)=>sum+nullableMoney(s.validated_amount)!,0):null;
  // Sum individual shortages; an excess remittance must not cancel a different shortage.
  const short=unique.reduce((sum,s)=>sum+Math.max(0,(nullableMoney(s.validated_amount)??nullableMoney(s.deposited_amount)??0)-(nullableMoney(s.deposited_amount)??0)),0);
  const excess=unique.reduce((sum,s)=>sum+Math.max(0,(nullableMoney(s.deposited_amount)??0)-(nullableMoney(s.validated_amount)??nullableMoney(s.deposited_amount)??0)),0);
  const status:PendingStatus=!unique.length?'Missing slip':unique.some(s=>!hasSlipProof(s))?'Slip missing proof':unique.some(s=>s.validation_status==='Rejected')?'Rejected':short>0||unique.some(s=>s.validation_status==='Short')?'Short':excess>0||unique.some(s=>s.validation_status==='Excess')?'Excess':duplicates?'Duplicate review':unique.some(s=>s.validation_status!=='Matched'||nullableMoney(s.deposited_amount)===null)?'Pending verification':'Complete';
  const last=entries[0]?.created_at||null;
  return {station,date,slipUploaded:unique.some(hasSlipProof),client:codClient(station),status,pending:status!=='Complete',amount:amount===null?null:Math.round(amount*100)/100,expected:expected===null?null:Math.round(expected*100)/100,short:Math.round(short*100)/100,excess:Math.round(excess*100)/100,duplicates,entries,unique,last,deadline:deadline.toISOString(),overdue:status!=='Complete'&&now>=deadline,late:unique.some(s=>Date.parse(s.created_at)>deadline.getTime())};
 }).sort((a,b)=>pendingStatuses.indexOf(a.status)-pendingStatuses.indexOf(b.status)||a.station.station_code.localeCompare(b.station.station_code));
}
export type CodPendingRow=ReturnType<typeof buildCodPendingRows>[number];
export function filterCodPendingRows(rows:CodPendingRow[],filters:{location?:string;client?:string;status?:string}) {return rows.filter(row=>(!filters.location||row.station.id===filters.location)&&(!filters.client||row.client===filters.client)&&(!filters.status||filters.status==='all'||(filters.status==='pending'?row.pending:filters.status==='uploaded'?row.slipUploaded:filters.status==='not_uploaded'?!row.slipUploaded:row.status===filters.status)));}
export function codPendingCsv(rows:CodPendingRow[]) {
 const cell=(v:unknown)=>{const raw=String(v??'');return '"'+(/^[\s]*[=+@-]/.test(raw)?"'"+raw:raw).replace(/"/g,'""')+'"';};
 const headers=['Deposit date','Station','Station name','Client','Slip uploaded','Review status','Deadline IST','Overdue','Late upload','Deposited INR','Portal validated INR','Short INR','Excess INR','Duplicate entries','Remittance codes','COD periods','Last submitted','Remarks'];
 return '\uFEFF'+[headers,...rows.map(r=>[r.date,r.station.station_code,r.station.station_name,r.client,r.slipUploaded?'Yes':'No',r.status,r.date+' 20:30',r.overdue?'Yes':'No',r.late?'Yes':'No',r.amount,r.expected,r.short,r.excess,r.duplicates,r.unique.map(s=>s.remittance_code||s.reference_no||'').join('; '),r.unique.map(s=>(s.cod_period_from||s.cod_date||'')+' to '+(s.cod_period_to||s.cod_period_from||s.cod_date||'')).join('; '),r.last,r.entries.map(s=>s.validation_remarks||s.remarks||'').filter(Boolean).join('; ')])].map(row=>row.map(cell).join(',')).join('\r\n');
}
