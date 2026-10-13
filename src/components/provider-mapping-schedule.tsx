"use client";
import { useState } from 'react';
import { SearchableSelect } from '@/components/searchable-select';
import type { PaymentMethodOption } from '@/components/provider-mapping-worksheet';
import type { ProviderFirstMappingRowView } from '@/lib/provider-first-mapping-view';
import { mappingScheduleError, nextMappingPeriodStart, type MappingPaymentPeriod } from '@/lib/provider-mapping-schedule';
import { saveProviderMappingSchedule } from '@/app/provider-mapping/actions';

export type SavedScheduleMappings = Awaited<ReturnType<typeof saveProviderMappingSchedule>>['mappings'];
export function ProviderMappingSchedule({ row, methods, onClose, onSaved }: {row:ProviderFirstMappingRowView; methods:PaymentMethodOption[]; onClose:()=>void; onSaved:(mappings:SavedScheduleMappings)=>void}) {
  const first:MappingPaymentPeriod = {effectiveFrom:row.effectiveFrom,effectiveTo:row.effectiveTo,paymentMethodId:row.paymentMethodId,paymentValues:{...row.paymentValues},productionThresholdMinimumUnits:row.productionThresholdMinimumUnits};
  const [periods,setPeriods] = useState<MappingPaymentPeriod[]>([first,{effectiveFrom:nextMappingPeriodStart(first.effectiveTo),effectiveTo:'',paymentMethodId:'',paymentValues:{},productionThresholdMinimumUnits:''}]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const methodsById=new Map(methods.map(method=>[method.id,method]));
  const issue=mappingScheduleError(periods) ?? periods.map((period,index) => {
    const method = methodsById.get(period.paymentMethodId);
    if (!method || method.isActive === false) return `Period ${index+1}: Select an active payment method.`;
    const missing = method.components.find(component => !String(period.paymentValues[component.code] ?? '').trim());
    if (missing) return `Period ${index+1}: Enter ${missing.label}.`;
    if (method.productionThresholdConfig && (!Number.isInteger(Number(period.productionThresholdMinimumUnits)) || Number(period.productionThresholdMinimumUnits) < 1)) return `Period ${index+1}: Enter a positive whole-number combined minimum.`;
    return null;
  }).find(Boolean);
  function update(index:number,change:Partial<MappingPaymentPeriod>) {
    setError('');setPeriods(current=>current.map((period,i)=> i===index ? {...period,...change} : period));
  }
  async function save() {
    if(busy||issue)return;
    const data=new FormData();data.set('row_count',String(periods.length));
    periods.forEach((period,index)=>{
      const fields={id:row.workforceId,source_type:'workforce',mapping_id:row.mappingId,dropx_id:row.dropxId,dropx_name:row.dropxName,provider_id:row.providerId,station_id:row.stationId,provider_member_id:row.providerMemberId,provider_member_name:row.providerMemberName,payment_method_id:period.paymentMethodId,payment_values_json:JSON.stringify(period.paymentValues),production_threshold_minimum_units:period.productionThresholdMinimumUnits,effective_from:period.effectiveFrom,effective_to:period.effectiveTo};
      Object.entries(fields).forEach(([key,value])=>data.set(`rows[${index}][${key}]`,value));
    });
    setBusy(true);setError('');
    try{const result=await saveProviderMappingSchedule(data);if(!result.ok){setError(result.message);return;}onSaved(result.mappings);}
    catch{setError('The response could not be confirmed. Check mapping history before retrying; your entered periods are still here.');}
    finally{setBusy(false);}
  }
  return <div className="modal-backdrop payment-history-backdrop"><section className="modal-panel wide payment-history-modal" role="dialog" aria-modal="true" aria-label="Plan payment periods">
    <div className="panel-head"><div><h2>Plan payment periods</h2><p className="subtle">{row.dropxId} · {row.dropxName} · {row.stationLabel}</p></div><button type="button" className="button secondary compact" disabled={busy} onClick={onClose}>Close</button></div>
    <div className="payment-history-body"><p>Set each payment method and its dates now. The next period starts the day after the previous one ends. Leave the final end date blank for ongoing pay.</p>
      {periods.map((period,index)=>{const method=methodsById.get(period.paymentMethodId);return <fieldset disabled={busy} className="mapping-period-plan" key={index}><legend>Period {index+1}</legend>
        <div className="mapping-plan-fields"><label>Payment method<SearchableSelect name={`schedule_method_${index}`} placeholder="Select payment method" options={methods.filter(item=>item.isActive!==false).map(item=>({value:item.id,label:item.name,helper:item.code}))} value={period.paymentMethodId} disabled={busy} onValueChange={value=>update(index,{paymentMethodId:value,paymentValues:{},productionThresholdMinimumUnits:''})} /></label>
          <label>From<input type="date" required value={period.effectiveFrom} onChange={event=>update(index,{effectiveFrom:event.target.value})} /></label>
          <label>To {index===periods.length-1?'(optional)':''}<input type="date" value={period.effectiveTo} min={period.effectiveFrom} onChange={event=>{const end=event.target.value;setPeriods(current=>current.map((item,i)=>i===index?{...item,effectiveTo:end}:i===index+1?{...item,effectiveFrom:nextMappingPeriodStart(end)}:item));setError('');}} /></label>
          {(method?.components??[]).map(component=><label key={component.code}>{component.label}<input type="number" min="0" step="0.01" required placeholder="0.00" value={period.paymentValues[component.code]??''} onChange={event=>update(index,{paymentValues:{...period.paymentValues,[component.code]:event.target.value}})} /></label>)}
          {method?.productionThresholdConfig?<label>Combined minimum / {method.productionThresholdConfig.period}<input type="number" min="1" step="1" value={period.productionThresholdMinimumUnits} onChange={event=>update(index,{productionThresholdMinimumUnits:event.target.value})} /></label>:null}
        </div>{index===periods.length-1&&index>1?<button className="button secondary compact" type="button" onClick={()=>setPeriods(current=>current.slice(0,-1))}>Remove period</button>:null}
      </fieldset>})}
      <button className="button secondary compact" type="button" disabled={busy||periods.length>=12||!nextMappingPeriodStart(periods[periods.length-1].effectiveTo)} onClick={()=>setPeriods(current=>[...current,{effectiveFrom:nextMappingPeriodStart(current[current.length-1].effectiveTo),effectiveTo:'',paymentMethodId:'',paymentValues:{},productionThresholdMinimumUnits:''}])}>+ Add payment period</button>
      {!periods[periods.length-1].effectiveTo?<p className="subtle">Enter an end date above to add another period. Plans can continue into the next month.</p>:null}
      {issue?<p role="status" className="subtle">{issue}</p>:null}{error?<p role="alert" className="mapping-row-error">{error}</p>:null}
      <div className="form-actions"><button className="button" type="button" disabled={busy||Boolean(issue)} onClick={()=>void save()}>{busy?'Saving all periods…':`Save ${periods.length} payment periods`}</button></div>
    </div>
  </section></div>;
}
