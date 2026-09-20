export function parseWorkforceLoss(form:FormData,today:string){
  const text=(name:string)=>String(form.get(name)??'').trim();
  const date=(name:string)=>{const value=text(name);if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new Error('Choose valid incident and payroll posting dates.');return value;};
  const incident=date('incident_date'),posting=date('posting_date'),amount=Number(text('amount'));
  if(!Number.isFinite(amount)||amount<=0||Math.abs(Math.round(amount*100)-amount*100)>0.00001)throw new Error('Enter a positive loss amount with at most two decimals.');
  if(incident>today||posting<incident)throw new Error('Incident date cannot be in the future; posting date cannot precede it.');
  const reference=text('reference').toUpperCase(),reason=text('reason'),category=text('category');
  if(reference.length<3||reference.length>200||reason.length<10||reason.length>2000)throw new Error('Provide a unique incident reference and a documented reason (10–2,000 characters).');
  if(!['cash_recovery','asset_recovery','other'].includes(category))throw new Error('Choose a valid loss category.');
  for(const field of ['workforce_id','station_id'])if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text(field)))throw new Error('Choose a station and Workforce associate.');
  return {p_workforce:text('workforce_id'),p_station:text('station_id'),p_amount:amount,p_date:incident,p_posting_date:posting,p_reference:reference,p_reason:reason,p_category:category};
}
