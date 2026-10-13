import {rateCardUnit} from '../../../../src/lib/workforce-route-distance.ts';

type Row = Record<string, any>;
const first = (value: any) => Array.isArray(value) ? value[0] : value;
export type PaymentReference = {
  asOf: string;
  cards: Array<{id:string;name:string;station:string;providerId:string|null;from:string;to:string|null;lines:Array<{code:string;label:string;rate:number;unit:string;overrideFrom:string|null;overrideTo:string|null}>}>;
};

/** Only dated, assigned components become a rate card. No payroll calculation. */
export function paymentReference(asOf:string,mappings:Row[],allocations:Row[],methods:Row[],overrides:Row[]):PaymentReference {
  const active=(row:Row)=>row.effective_from<=asOf&&(!row.effective_to||row.effective_to>=asOf)&&row.status!=='cancelled';
  const methodById=new Map(methods.map(row=>[row.id,row]));
  const cards:Row[]=[...mappings.filter(active).map(row=>({...row,method:first(row.payment_methods),station:first(row.stations)?.station_code})),...allocations.filter(active).map(row=>({...row,method:methodById.get(row.payment_method_id),station:row.station_code_snapshot,provider_member_id:null}))];
  return {asOf,cards:cards.map(row=>{
    const snapshots=Array.isArray(row.payment_components)&&row.payment_components.length?row.payment_components:null;
    const components=snapshots??row.method?.payment_method_components??[];
    return {id:row.id,name:row.method?.name||'Assigned payment rates',station:row.station||'',providerId:row.provider_member_id||null,from:row.effective_from,to:row.effective_to||null,lines:components.filter((c:Row)=>c.is_active!==false).flatMap((c:Row)=>{
      const field=first(c.payment_fields),code=String(c.component_code||field?.code||'').trim();
      const raw=Object.entries(row.payment_values??{}).find(([key])=>key.trim().toUpperCase()===code.toUpperCase())?.[1];
      if(!code||raw===null||raw===undefined||raw===''||!Number.isFinite(Number(raw)))return [];
      const changes=overrides.filter(o=>o.station_id===row.station_id&&String(o.field_code_snapshot).trim().toUpperCase()===code.toUpperCase()&&o.effective_from<=asOf&&o.effective_to>=asOf);
      if(changes.length>1)throw new Error('Conflicting rate changes. Please contact Workforce.');
      const rate=changes.length?Number(changes[0].input_value):Number(raw);
      if(!Number.isFinite(rate)||rate<0)throw new Error('Your assigned rate needs review. Please contact Workforce.');
      const unit=rateCardUnit(field,code,c.pay_schedule);
      const specificUnit=unit==='per unit'?/DELIVERY|RETURN|MFN|PACKET|SHIPMENT|PICKUP/i.test(code)?'per package':unit:unit;
      return [{code,label:code.toUpperCase()==='KM_RUN'?'Fuel allowance':String(c.label||field?.label||code.replaceAll('_',' ')),rate,unit:specificUnit,overrideFrom:changes[0]?.effective_from??null,overrideTo:changes[0]?.effective_to??null}];
    })};
  })};
}
