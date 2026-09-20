type Relation<T> = T | T[] | null | undefined;
export type PaymentMapping = {provider_member_id:string|null;effective_from:string|null;effective_to:string|null;providers?:Relation<{name?:string|null;code?:string|null}>;stations?:Relation<{station_code?:string|null}>;payment_values:Record<string,unknown>|null};
const first=<T>(value:Relation<T>)=>Array.isArray(value)?value[0]:value;
const key=(value:unknown)=>String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
/** Never credit another person's day merely because the provider ID was reused. */
export function paymentMappingForDay<T extends PaymentMapping>(mappings:T[],row:{work_date:string;provider_employee_id:string;station_code:string;client:string}){
  return mappings.filter(mapping=>mapping.provider_member_id===row.provider_employee_id && mapping.effective_from && mapping.effective_from<=row.work_date && (!mapping.effective_to||mapping.effective_to>=row.work_date))
    .filter(mapping=>{const station=first(mapping.stations)?.station_code;const provider=first(mapping.providers);return (!station||key(station)===key(row.station_code)) && [provider?.name,provider?.code].filter(Boolean).some(value=>key(value)===key(row.client));})
    .sort((a,b)=>String(b.effective_from).localeCompare(String(a.effective_from)))[0] ?? null;
}
