import { summarizeDaDetails, type CpsDaDay, type CpsRate } from "./cps-details";
import type { CpsSnapshot, CpsLine, CpsHead, CpsCostInput, CpsStaffCost, CpsPeoplePolicy } from './cps';
import {
  allocationActiveOn,
  directPayAttendanceUnit,
  directPayForDay,
  preferredDirectPayAttendance,
  directPayAttendanceBasis,
  type DirectPayAttendance,
  type DirectPayComponent,
} from '../direct-workforce-pay';
import {
  monthlyAttendanceAmountForDay,
  workforcePaymentPolicyForDate,
  type WorkforcePaymentPolicy,
} from '../workforce-payment-policy';
import {
  aggregateShipmentDeliveriesByWorkforceDay,
  shipmentAttendanceRecord,
  shipmentAttendanceReview,
  workforceAttendanceCaptureSettingForDate,
  type WorkforceAttendanceCaptureSetting,
} from '../workforce-attendance-capture';
import {
  allocateCombinedProductionThresholds,
  type WorkforceProductionThresholdAllocation,
  type WorkforceProductionThresholdInput,
} from '../workforce-production-threshold';

import { buildWorkforcePayoutInputMaps, overlayWorkforcePayoutAttendance,
  resolveWorkforcePaymentFieldRate, findWorkforceProductionInput,
  findWorkforcePayoutAttendancePeriod, hasWorkforcePayoutAttendanceOverride } from '../workforce-payout-input-calculation';

// Cost accrual is separate from payroll settlement. Source records are never rewritten.
type RecordRow = Record<string, any>;
export type CpsFacts = {
  payout_inputs?: Parameters<typeof buildWorkforcePayoutInputMaps>[0];
  shipments: RecordRow[]; volumes: RecordRow[]; mappings: RecordRow[];
  workforce: RecordRow[]; components: RecordRow[]; providers: RecordRow[];
  stations: RecordRow[]; employees: RecordRow[]; salaries: RecordRow[];
  people_rules: CpsCostInput[];
  people_policies?: CpsPeoplePolicy[];
  component_policies?: {component_code:string;mode:string;effective_from:string}[];
  people_assignments?: {employee_id:string;station_code:string;effective_from:string;effective_to:string|null;kind?:string}[];
  allocations?: RecordRow[];
  attendance?: RecordRow[];
  attendance_shipments?: RecordRow[];
  attendance_mappings?: RecordRow[];
  attendance_workforce?: RecordRow[];
  attendance_providers?: RecordRow[];
  attendance_stations?: RecordRow[];
  production_threshold_context?: {
    shipments: RecordRow[];
    mappings: RecordRow[];
    workforce: RecordRow[];
    components: RecordRow[];
    providers: RecordRow[];
    stations: RecordRow[];
  };
  payment_policy_history?: WorkforcePaymentPolicy[];
  attendance_capture_history?: WorkforceAttendanceCaptureSetting[];
  policy_history?: RecordRow[];
  rent_coverage?: RecordRow[];
  manual_inputs?: CpsCostInput[];
};
export type CpsGap = {
  key: string; kind: string; station_code: string; provider_id: string;
  dropx_id: string; name: string; first_date: string; last_date: string;
  days: number; deliveries: number; known_cost: number; owner: string; href: string;
};
export type CpsPersonCost = {
  id: string; dropx_id: string; name: string; station_code: string;
  salary: number; variable: number; fuel: number; van: number;
  deliveries: number; paid_days: number; zero_delivery_days: number;
};
export type LiveAssociate = RecordRow & {
  id: string; work_date: string; station_code: string; provider_employee_id: string;
  provider_employee_name: string | null; dropx_name: string | null; dropx_emp_code: string | null;
  pay_type: string | null; total_delivery: number; c_return: number; mfn: number; mfn_return: number;
  variable_pay: number; mg_pay: number; fuel_pay: number; van_pay: number;
  da_total_pay: number; mapping_status: string;
};
const key = (s: unknown) => String(s ?? '').trim().toUpperCase();
const compact = (s: unknown) => key(s).replace(/[^A-Z0-9]/g, '');
const num = (n: unknown) => Number.isFinite(Number(n)) ? Number(n) : 0;
const activeOn = (r: RecordRow, date: string) => r.effective_from <= date && (!r.effective_to || r.effective_to >= date);
const employedOn = (r: RecordRow, date: string) => (!r.date_of_join || r.date_of_join <= date) &&
  (!r.last_working_date || r.last_working_date >= date) && (!r.deleted_at || String(r.deleted_at).slice(0,10) > date) &&
  (r.is_active !== false || Boolean(r.last_working_date && r.last_working_date >= date));
export function monthlyAccrual(amount: number, date: string) {
  const [y,m,d] = date.split('-').map(Number);
  const days = new Date(Date.UTC(y,m,0)).getUTCDate();
  return (Math.round(amount * 100 * d / days) - Math.round(amount * 100 * (d-1) / days)) / 100;
}
export function allocateCost(amount: number, codes: string[], volumes: Map<string, number>, allocation='delivery_share') {
  const unique = [...new Set(codes)].sort();
  if (!unique.length) return new Map<string,number>();
  const total = unique.reduce((n,c) => n + Math.max(0,volumes.get(c) ?? 0),0);
  // Cumulative rounding conserves every paise, including equal fallback on zero-volume days.
  let cumulative=0, previous=0;
  return new Map(unique.map(c => {
    cumulative += allocation==='delivery_share' && total>0 ? Math.max(0,volumes.get(c) ?? 0)/total : 1/unique.length;
    const end = Math.round(amount*100*cumulative);
    const value=(end-previous)/100; previous=end;
    return [c,value];
  }));
}
const production = (r: RecordRow, source: unknown): number | null => {
  switch(compact(source)) {
    case 'DELIVERY': case 'TOTALDELIVERY': return num(r.total_delivery);
    case 'AMAZONDELIVERY': return num(r.amazon_delivery);
    case 'SWADELIVERY': return num(r.swa_delivery);
    case 'CRETURN': case 'CUSTOMERRETURN': return num(r.c_return);
    case 'MFN': case 'SELLERPICKUP': return num(r.mfn);
    case 'MFNRETURN': case 'SELLERRETURN': case 'SLLLERRETURN': return num(r.mfn_return);
    default: return null;
  }
};
function configured(r: RecordRow) {
  return Boolean(r.payment_method_id || ['delivery_rate','pickup_rate','mfn_rate','mfn_return_rate','guarantee_amount','fuel_rate'].some(k=>num(r[k])>0));
}
function rateSignature(r: RecordRow) {
  return JSON.stringify([r.payment_method_id, Object.entries(r.payment_values ?? {}).sort(([a],[b])=>a.localeCompare(b)),
    r.production_threshold_config ?? null,
    r.method_production_threshold_config ?? null,
    Array.isArray(r.payment_components) ? r.payment_components : null,
    ...['delivery_rate','pickup_rate','mfn_rate','mfn_return_rate','guarantee_amount','guarantee_schedule','fuel_rate'].map(k=>r[k] ?? null)]);
}
export function calculateRateCard(
  r: RecordRow,
  components: RecordRow[],
  shipment: RecordRow,
  date: string,
  includeFixed: boolean,
  attendance?: DirectPayAttendance | null,
  paymentPolicyHistory?: WorkforcePaymentPolicy[] | null,
  cumulativeAttendanceUnitsBefore = 0,
  attendanceSource: 'biometric' | 'shipment_data' = 'biometric',
  productionAllocations?: ReadonlyMap<string, WorkforceProductionThresholdAllocation>,
  attendanceInput?: {basis:'days'|'hours';quantity:number}
) {
  const cost={salary:0,variable:0,fuel:0,van:0,missing:false,production_details:[] as import("./cps-details").CpsProductionDetail[]};
  if (r.payment_method_id && !components.length) cost.missing=true;
  const values = Object.fromEntries(Object.entries(r.payment_values ?? {}).map(([k,v])=>[key(k),v]));
  for(const c of components) {
    const code=key(c.component_code), label=key(`${code} ${c.label}`);
    // Fleet owns fixed rental accrual; payroll settlement keeps its original card.
    if(c.cps_cost_source==='pnl_only') continue;
    if(c.cps_cost_source==='fleet' && c.component_type!=='production' && c.calculation_type!=='count_x_rate') continue;
    const raw=values[code];
    if(raw==null || String(raw).trim()==='' || !Number.isFinite(Number(raw)) || Number(raw)<0) { cost.missing=true; continue; }
    const rate=Number(raw), isProduction=c.component_type==='production' || c.calculation_type==='count_x_rate';
    const source=c.provider_calculation_sources?.[String(shipment.client ?? 'Amazon').toLowerCase()] || c.calculation_source || code;
    const count=productionAllocations?.get(code)?.reportedUnits ?? production(shipment,source) ?? (c.is_custom_production ? 0 : null);
    if(isProduction && count==null) {cost.missing=true;continue;}
    const thresholdAllocation=isProduction ? productionAllocations?.get(code) : undefined;
    if(isProduction && productionAllocations && !thresholdAllocation) {cost.missing=true;continue;}
    if(thresholdAllocation?.thresholdConfigurationMissing) cost.missing=true;
    if(!isProduction && !includeFixed) continue;
    const monthly= /month/i.test(String(c.pay_schedule)) || c.calculation_type==='fixed_monthly';
    const hourly=/hour/i.test(String(c.pay_schedule));
    const daily=/day/i.test(String(c.pay_schedule));
    const attendanceBased=!isProduction && c.calculation_source==='attendance_eligibility';
    if(attendanceBased && !monthly && !hourly && !daily) {cost.missing=true;continue;}
    if(attendanceBased && hourly && attendanceSource==='shipment_data' && num(attendance?.work_minutes)<=0 && attendanceInput?.basis!=='hours') {cost.missing=true;continue;}
    const attendanceUnit=attendanceBased ? directPayAttendanceUnit(attendance) : 1;
    const workedHours=attendanceUnit>0 ? Math.max(0,num(attendance?.work_minutes))/60 : 0;
    const attendanceAmount=monthly
      ? monthlyAttendanceAmountForDay({
        monthlyAmount: rate,
        date,
        attendanceUnit,
        cumulativeAttendanceUnitsBefore,
        policy: workforcePaymentPolicyForDate(paymentPolicyHistory,date)
      }).amount
      : hourly ? rate*workedHours : rate*attendanceUnit;
    const aggregateFixed = attendanceBased && attendanceInput && directPayAttendanceBasis(c as DirectPayComponent)===attendanceInput.basis
      ? directPayForDay({[code]:rate},[c as DirectPayComponent],date,attendance,{policyHistory:paymentPolicyHistory,cumulativeAttendanceUnitsBefore,attendanceSource,attendanceInput}).total : undefined;
    const amount=isProduction
      ? thresholdAllocation?.amount ?? rate*count!
      : aggregateFixed ?? (attendanceBased ? Math.round(attendanceAmount*100)/100 : monthly ? monthlyAccrual(rate,date) : rate);
    const bucket=/VAN|VEHICLE|DOCK/.test(label) ? 'van' : /FUEL|KILOMET|\bKM\b/.test(label) ? 'fuel' : !isProduction ? 'salary' : 'variable';
    cost[bucket]+=amount;
    if(isProduction) cost.production_details.push({label:c.label||c.component_code,basis:String(source).replaceAll("_"," ").toLowerCase(),rate,reported_units:count!,payable_units:thresholdAllocation?.payableUnits??count!,threshold_units:thresholdAllocation?.thresholdDeducted??0,amount,bucket});
  }
  if(!components.length && !r.payment_method_id) {
    const sellerPay=num(shipment.mfn)*num(r.mfn_rate)+num(shipment.mfn_return)*num(r.mfn_return_rate);
    cost.variable=num(shipment.total_delivery)*num(r.delivery_rate)+num(shipment.c_return)*num(r.pickup_rate)+sellerPay;
    cost.fuel=num(shipment.total_delivery)*num(r.fuel_rate);
    if(includeFixed) cost.salary=Math.max(0,(/month/i.test(r.guarantee_schedule ?? '') ? monthlyAccrual(num(r.guarantee_amount),date) : num(r.guarantee_amount))-cost.variable);
    if(r.exclude_seller_costs) cost.variable-=sellerPay;
    if(!configured(r)) cost.missing=true;
  }
  return cost;
}
function detailRates(card: RecordRow, components: RecordRow[], client: string): CpsRate[] {
  const values=Object.fromEntries(Object.entries(card.payment_values??{}).map(([k,v])=>[key(k),v]));
  if(components.length) return components.filter(c=>values[key(c.component_code)]!=null && c.cps_cost_source!=='pnl_only' && (c.cps_cost_source!=='fleet' || c.component_type==='production' || c.calculation_type==='count_x_rate')).map(c=>({
    label:c.label||c.component_code, rate:num(values[key(c.component_code)]),
    basis:(c.component_type==='production'||c.calculation_type==='count_x_rate')
      ? String(c.provider_calculation_sources?.[client.toLowerCase()]||c.calculation_source||c.component_code).replaceAll('_',' ').toLowerCase()
      : `${c.pay_schedule||c.calculation_type||'fixed'}${c.calculation_source==='attendance_eligibility'?' · attendance based':''}`.replaceAll('_',' ')
  }));
  return [
    ['Delivery',card.delivery_rate,'per delivery'],['Customer return',card.pickup_rate,'per return'],
    ...(!card.exclude_seller_costs ? [['Seller pickup',card.mfn_rate,'per pickup'],['Seller return',card.mfn_return_rate,'per return']] : []),
    ['Minimum guarantee',card.guarantee_amount,card.guarantee_schedule||'per day'],['DA fuel',card.fuel_rate,'per delivery']
  ].filter(([,rate])=>rate!=null).map(([label,rate,basis])=>({label:String(label),rate:num(rate),basis:String(basis)}));
}
function hasFixedDaPay(card: RecordRow, cs: RecordRow[]) {
  return num(card.guarantee_amount)>0 || /MG|GUARANTEE|SALARY|FIXED/i.test(card.pay_type??'') || cs.some(c=>
    c.component_type!=='production'&&c.calculation_type!=='count_x_rate' &&
    !/VAN|VEHICLE|DOCK|FUEL|KILOMET|\bKM\b/i.test(`${c.component_code} ${c.label}`) &&
    num(Object.entries(card.payment_values??{}).find(([k])=>key(k)===key(c.component_code))?.[1])>0);
}
export function rebuildCps(base: CpsSnapshot, facts: CpsFacts): CpsSnapshot & { associates: LiveAssociate[]; gaps: CpsGap[]; people: CpsPersonCost[] } {
  const policyFor = (e: RecordRow, date: string) => (facts.people_policies ?? [])
    .filter(p=>p.designation_code===e.designation && p.effective_from<=date)
    .sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
  const sourceComponents = <T extends RecordRow>(rows: T[], date: string) => rows.map(c=>({...c,cps_cost_source:
    (facts.component_policies??[]).filter(p=>key(p.component_code)===key(c.component_code) && p.effective_from<=date)
      .sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0]?.mode??'workforce'}));
  const sellerExcludedOn=(date:string)=>['SELLER_PICKUP','SLLLER_RETURN','SELLER_RETURN','MFN','MFN_RETURN'].some(code=>
    (facts.component_policies??[]).filter(p=>key(p.component_code)===code&&p.effective_from<=date).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0]?.mode==='pnl_only');
  const inputMaps=buildWorkforcePayoutInputMaps(facts.payout_inputs??{});
  const stationById=new Map(facts.stations.map(s=>[s.id,s]));
  const selected=new Set(base.daily.map(d=>d.station_code));
  const dates=[...new Set(base.daily.map(d=>d.work_date))].sort();
  const workforce=new Map(facts.workforce.map(w=>[w.id,w]));
  const workforceByAttendanceIdentity=new Map<string,RecordRow>();
  for(const worker of facts.workforce) {
    workforceByAttendanceIdentity.set(`workforce|${worker.id}`,worker);
    if(worker.source_profile_type&&worker.source_profile_id) workforceByAttendanceIdentity.set(`${worker.source_profile_type}|${worker.source_profile_id}`,worker);
  }
  const canonical = (m:RecordRow): RecordRow | undefined => workforce.get(m.workforce_id) ?? facts.workforce.find(w =>
    (w.source_profile_type==='employee' && w.source_profile_id===m.employee_id && m.employee_id) ||
    (w.source_profile_type==='contractor' && w.source_profile_id===m.contractor_id && m.contractor_id) ||
    (w.source_profile_type==='field_executive' && w.source_profile_id===m.field_executive_id && m.field_executive_id));
  const mappings=facts.mappings.map((m):RecordRow=>({...m,worker:canonical(m)})).sort((a,b)=>b.effective_from.localeCompare(a.effective_from));
  const components=new Map<string,RecordRow[]>();
  facts.components.forEach(c=>components.set(c.payment_method_id,[...(components.get(c.payment_method_id)??[]),c]));
  for(const [methodId,methodComponents] of components) components.set(methodId,methodComponents.sort((a,b)=>
    num(a.sort_order)-num(b.sort_order) || key(a.component_code).localeCompare(key(b.component_code))));
  const providers=new Map(facts.providers.map(p=>[p.id,compact(`${p.code} ${p.name}`)]));
  const attendanceWorkforceRows=facts.attendance_workforce??facts.workforce;
  const attendanceWorkforce=new Map(attendanceWorkforceRows.map(w=>[w.id,w]));
  const attendanceCanonical=(m:RecordRow):RecordRow|undefined=>attendanceWorkforce.get(m.workforce_id)??attendanceWorkforceRows.find(w=>
    (w.source_profile_type==='employee'&&w.source_profile_id===m.employee_id&&m.employee_id)||
    (w.source_profile_type==='contractor'&&w.source_profile_id===m.contractor_id&&m.contractor_id)||
    (w.source_profile_type==='field_executive'&&w.source_profile_id===m.field_executive_id&&m.field_executive_id));
  const attendanceMappings=(facts.attendance_mappings??facts.mappings).map((m):RecordRow=>({...m,worker:attendanceCanonical(m)}));
  const attendanceProviders=new Map((facts.attendance_providers??facts.providers).map(p=>[p.id,compact(`${p.code} ${p.name}`)]));
  const attendanceStationById=new Map((facts.attendance_stations??facts.stations).map(s=>[s.id,s]));
  let attendanceByWorkerDate=new Map<string,RecordRow>();
  for(const row of facts.attendance??[]) {
    if(!row.punch_date) continue;
    const attendanceWorker=workforceByAttendanceIdentity.get(`workforce|${row.workforce_id}`)
      ??workforceByAttendanceIdentity.get(`employee|${row.employee_id}`)
      ??workforceByAttendanceIdentity.get(`contractor|${row.contractor_id}`)
      ??workforceByAttendanceIdentity.get(`field_executive|${row.field_executive_id}`);
    if(!attendanceWorker) continue;
    const k=`${attendanceWorker.id}|${row.punch_date}`,existing=attendanceByWorkerDate.get(k);
    attendanceByWorkerDate.set(k,preferredDirectPayAttendance(existing as DirectPayAttendance|undefined,row as DirectPayAttendance) as RecordRow);
  }
  const shipmentDeliveries=aggregateShipmentDeliveriesByWorkforceDay((facts.attendance_shipments??facts.shipments??[]).flatMap(row=>{
    if(!row.work_date) return [];
    const matches=attendanceMappings.filter(m=>key(m.provider_member_id)===key(row.provider_employee_id) && activeOn(m,row.work_date) &&
      (!m.station_id || attendanceStationById.get(m.station_id)?.station_code===row.station_code) &&
      (attendanceProviders.get(m.provider_id)??'').includes(compact(row.client)));
    const identities=[...new Set(matches.map(m=>m.worker?.id).filter(Boolean))];
    return identities.length===1 ? [{workforce_id:identities[0],work_date:String(row.work_date),total_delivery:num(row.total_delivery)}] : [];
  }));
  const attendanceDates=new Set(dates);
  for(const workerDate of shipmentDeliveries.keys()) attendanceDates.add(workerDate.slice(workerDate.lastIndexOf('|')+1));
  for(const workerDate of attendanceByWorkerDate.keys()) attendanceDates.add(workerDate.slice(workerDate.lastIndexOf('|')+1));
  for(const worker of attendanceWorkforceRows) for(const date of attendanceDates) {
    const capture=workforceAttendanceCaptureSettingForDate(facts.attendance_capture_history,date);
    if(capture.capture_method!=='shipment_data') continue;
    const workerDate=`${worker.id}|${date}`;
    attendanceByWorkerDate.set(workerDate,shipmentAttendanceRecord(date,shipmentDeliveries.get(workerDate)??0,capture) as RecordRow);
  }
  attendanceByWorkerDate=new Map(overlayWorkforcePayoutAttendance(attendanceByWorkerDate as Map<string,DirectPayAttendance>,inputMaps.attendanceByWorkforceDate));
  const paymentCard=(card:RecordRow,cs:RecordRow[],workerId:string,date:string,stationId=card.station_id):RecordRow=>({ ...card,exclude_seller_costs:sellerExcludedOn(date),
    payment_values:Object.fromEntries(cs.map(c=>{const code=key(c.component_code);return [code,resolveWorkforcePaymentFieldRate(inputMaps,{workforceId:workerId,stationId:String(stationId??''),paymentFieldId:c.payment_field_id,fieldCode:code,date,fallbackRate:Object.entries(card.payment_values??{}).find(([k])=>key(k)===code)?.[1]})]}))
  });
  const rangeValidation=new Map<string,boolean>();
  const rangeInput=(workerId:string,stationId:string,date:string)=>{
    const period=findWorkforcePayoutAttendancePeriod(inputMaps,{workforceId:workerId,stationId,date});
    if(!period)return undefined;
    const periodKey=String(period.id??`${workerId}|${stationId}|${period.effective_from}|${period.effective_to}`);
    if(!rangeValidation.has(periodKey)) {
      const signatures=new Set<string>();let valid=period.effective_from.slice(0,7)===period.effective_to.slice(0,7);
      for(let cursor=new Date(`${period.effective_from}T00:00:00Z`);cursor<=new Date(`${period.effective_to}T00:00:00Z`);cursor.setUTCDate(cursor.getUTCDate()+1)) {
        const d=cursor.toISOString().slice(0,10);
        const sources=[...mappings.filter(m=>m.worker?.id===workerId && m.station_id===stationId && activeOn(m,d)),
          ...(facts.allocations??[]).filter(m=>m.workforce_id===workerId && m.station_id===stationId && m.status!=='cancelled' && activeOn(m,d))]
          .map(card=>({card,cs:(Array.isArray(card.payment_components)&&card.payment_components.length?card.payment_components:components.get(card.payment_method_id)??[]).filter((c:RecordRow)=>directPayAttendanceBasis(c as DirectPayComponent)===period.attendance_basis)}))
          .filter(source=>source.cs.length);
        if(sources.length!==1){valid=false;continue;}
        const {card,cs}=sources[0],resolved=paymentCard(card,cs,workerId,d,stationId);
        signatures.add(JSON.stringify([card.id,cs.map((c:RecordRow)=>[c.component_code,c.pay_schedule,c.calculation_type,resolved.payment_values[key(c.component_code)]]),workforcePaymentPolicyForDate(facts.payment_policy_history,d)]));
      }
      rangeValidation.set(periodKey,valid&&signatures.size===1);
    }
    const valid=rangeValidation.get(periodKey)!;
    const complete=valid && period.effective_from>=dates[0] && period.effective_to<=dates.at(-1)!;
    // Uploaded ranges contain no daily attendance. Settle once at range end,
    // just like Dashboard; flag a partial view instead of inventing workdays.
    return {period,complete,valid,input:{basis:period.attendance_basis,quantity:complete&&date===period.effective_to?period.quantity:0}};
  };
  const cumulativeAttendanceUnitsBefore=new Map<string,number>();
  for(const periods of inputMaps.attendancePeriodsByWorkforceStation.values()) for(const period of periods) {
    if(period.attendance_basis!=='days') continue;
    for(let cursor=new Date(`${period.effective_from}T00:00:00Z`);cursor<=new Date(`${period.effective_to}T00:00:00Z`);cursor.setUTCDate(cursor.getUTCDate()+1)) {
      const date=cursor.toISOString().slice(0,10),k=`${period.workforce_id}|${date}`;
      attendanceByWorkerDate.set(k,{punch_date:date,status:'A',aggregate_units:date===period.effective_to&&rangeInput(period.workforce_id,period.station_id,date)?.valid?Number(period.quantity):0});
    }
  }
  for(const worker of facts.workforce) {
    const workerDates=[...attendanceByWorkerDate.entries()]
      .filter(([entry])=>entry.startsWith(`${worker.id}|`))
      .sort(([left],[right])=>left.localeCompare(right));
    let month='',running=0;
    for(const [entry,attendance] of workerDates) {
      const date=entry.slice(worker.id.length+1),nextMonth=date.slice(0,7);
      if(nextMonth!==month){month=nextMonth;running=0;}
      cumulativeAttendanceUnitsBefore.set(entry,running);
      running+=attendance.aggregate_units??directPayAttendanceUnit(attendance as DirectPayAttendance);
    }
  }
  const dailyVolumes=new Map<string,Map<string,number>>();
  facts.volumes.forEach(v=>{const map=dailyVolumes.get(v.work_date)??new Map();map.set(v.station_code,num(v.deliveries));dailyVolumes.set(v.work_date,map);});
  const lines:CpsLine[]=base.breakup.filter(l=>l.source!=='Shipment payment mapping').map(l=>({...l,head:l.source==='Finance Rent Master'||(l.head==='Other'&&/^(station|office|premise|facility) rent$/i.test(l.sub_head))?'Rent':l.head}));
  const gaps=new Map<string,CpsGap>((base.gaps ?? []).filter(g=>selected.has(g.station_code)).map(g=>[g.key,g]));
  const gapDates=new Map<string,Set<string>>();
  function gap(kind:string, station:string,date:string, id='',name='',dropx='',deliveries=0,cost=0, owner='Workforce team') {
    if(!selected.has(station)) return;
    if(owner==='People / Finance') { id=''; name=''; dropx=''; }
    const k=`${kind}|${station}|${id}|${dropx}`;
    const existing=gaps.get(k);
    const seen=gapDates.get(k)??new Set<string>();seen.add(date);gapDates.set(k,seen);
    if(existing) {existing.days=seen.size;existing.first_date=existing.first_date<date?existing.first_date:date;existing.last_date=existing.last_date>date?existing.last_date:date;existing.deliveries+=deliveries;existing.known_cost+=cost;return;}
    gaps.set(k,{key:k,kind,station_code:station,provider_id:id,dropx_id:dropx,name,first_date:date,last_date:date,days:1,deliveries,known_cost:cost,owner,
      href:owner==='Workforce attendance' ? `https://dashboard.dropxlogistics.com/attendance` : owner==='People / Finance' ? '/cps?view=inputs' : owner==='Operations uploads' ? 'https://dashboard.dropxlogistics.com/imports' : owner==='Workforce direct pay' ? `https://dashboard.dropxlogistics.com/provider-mapping/direct-pay?q=${encodeURIComponent(dropx)}` : `https://dashboard.dropxlogistics.com/provider-id-mapping?q=${encodeURIComponent(dropx || id)}&station=${encodeURIComponent(station)}`});
  }
  const add=(station:string,date:string,head:CpsHead,sub:string,amount:number,source:string) => {
    if(selected.has(station) && amount!==0) lines.push({station_code:station,work_date:date,head,sub_head:sub,amount,source});
  };
  const associates:LiveAssociate[]=facts.shipments.map(s=>({...s,dropx_name:null,dropx_emp_code:null,pay_type:null,variable_pay:0,mg_pay:0,fuel_pay:0,van_pay:0,da_total_pay:0,mapping_status:'Unmapped'} as LiveAssociate));
  const groups=new Map<string,{worker:RecordRow; date:string; rows:LiveAssociate[]; maps:RecordRow[]}>();
  for(const row of associates) {
    const matches=mappings.filter(m=>key(m.provider_member_id)===key(row.provider_employee_id) && activeOn(m,row.work_date) &&
      (!m.station_id || stationById.get(m.station_id)?.station_code===row.station_code) &&
      (providers.get(m.provider_id)??'').includes(compact(row.client)));
    const identities=new Set(matches.map(m=>m.worker?.id).filter(Boolean));
    if(identities.size!==1 || matches.some(m=>!m.worker)) {
      row.mapping_status=matches.length ? 'Conflicting or missing DropX identity' : 'Unmapped';
      if(num(row.total_delivery)+num(row.c_return)>0) gap(row.mapping_status,row.station_code,row.work_date,row.provider_employee_id,row.provider_employee_name??'','',num(row.total_delivery));
      continue;
    }
    const worker=matches[0].worker!;
    row.dropx_name=worker.full_name;row.dropx_emp_code=worker.dropx_id;
    const k=`${worker.id}|${row.work_date}`, g=groups.get(k)??{worker,date:row.work_date,rows:[] as LiveAssociate[],maps:[] as RecordRow[]};
    g.rows.push(row);g.maps.push(...matches);groups.set(k,g);
  }
  // Calendar-monthly commitments and attendance-earned fixed pay accrue even when
  // the provider upload has no row for a worker.
  for(const m of mappings) {
    if(!m.worker || !configured(m)) continue;
    const cs=components.get(m.payment_method_id)??[];
    for(const date of dates) {
      if(!activeOn(m,date) || !employedOn(m.worker,date)) continue;
      const k=`${m.worker.id}|${date}`;
      if(groups.has(k)) continue;
      const attendance=attendanceByWorkerDate.get(k) as DirectPayAttendance|undefined;
      const calendarMonthly=cs.some(c=>c.component_type!=='production' && c.calculation_type!=='count_x_rate' && c.calculation_source!=='attendance_eligibility' && (/month/i.test(c.pay_schedule??'') || c.calculation_type==='fixed_monthly')) || /month/i.test(m.guarantee_schedule??'');
      const attendanceFixed=cs.some(c=>c.component_type!=='production' && c.calculation_type!=='count_x_rate' && c.calculation_source==='attendance_eligibility');
      if(!calendarMonthly && !(attendanceFixed && (directPayAttendanceUnit(attendance)>0 || rangeInput(m.worker.id,m.station_id,date)))) continue;
      const station=stationById.get(m.station_id ?? m.worker.location_id)?.station_code;
      if(!station) continue;
      const row={id:`fixed:${m.worker.id}:${date}`,client:'Amazon',work_date:date,station_code:station,provider_employee_id:m.provider_member_id,provider_employee_name:m.worker.full_name,dropx_name:m.worker.full_name,dropx_emp_code:m.worker.dropx_id,pay_type:m.pay_type,total_delivery:0,total_activity:0,c_return:0,mfn:0,mfn_return:0,variable_pay:0,mg_pay:0,fuel_pay:0,van_pay:0,da_total_pay:0,mapping_status:'Mapped'};
      associates.push(row); groups.set(k,{worker:m.worker,date,rows:[row],maps:[m]});
    }
  }
  const thresholdInputs:WorkforceProductionThresholdInput[]=[];
  const thresholdInputTargets=new Map<string,{rowKey:string;groupKey:string}>();
  // A day/custom CPS view still needs production from the start of the calendar
  // month to determine how much of a monthly combined minimum was already used.
  // Keep that calculation context separate from `groups`: only requested rows
  // may become associates, detail lines, gaps or daily totals.
  const thresholdContext=facts.production_threshold_context;
  const thresholdWorkforceRows=thresholdContext?.workforce??facts.workforce;
  const thresholdWorkforce=new Map(thresholdWorkforceRows.map(worker=>[worker.id,worker]));
  const thresholdCanonical=(mapping:RecordRow):RecordRow|undefined=>thresholdWorkforce.get(mapping.workforce_id)??thresholdWorkforceRows.find(worker=>
    (worker.source_profile_type==='employee'&&worker.source_profile_id===mapping.employee_id&&mapping.employee_id)||
    (worker.source_profile_type==='contractor'&&worker.source_profile_id===mapping.contractor_id&&mapping.contractor_id)||
    (worker.source_profile_type==='field_executive'&&worker.source_profile_id===mapping.field_executive_id&&mapping.field_executive_id));
  const thresholdMappings=(thresholdContext?.mappings??facts.mappings)
    .map((mapping):RecordRow=>({...mapping,worker:thresholdCanonical(mapping)}))
    .sort((a,b)=>b.effective_from.localeCompare(a.effective_from));
  const thresholdComponents=new Map<string,RecordRow[]>();
  (thresholdContext?.components??facts.components).forEach(component=>thresholdComponents.set(
    component.payment_method_id,
    [...(thresholdComponents.get(component.payment_method_id)??[]),component]
  ));
  for(const [methodId,methodComponents] of thresholdComponents) thresholdComponents.set(methodId,methodComponents.sort((a,b)=>
    num(a.sort_order)-num(b.sort_order)||key(a.component_code).localeCompare(key(b.component_code))));
  const thresholdProviders=new Map((thresholdContext?.providers??facts.providers).map(provider=>[provider.id,compact(`${provider.code} ${provider.name}`)]));
  const thresholdStationById=new Map((thresholdContext?.stations??facts.stations).map(station=>[station.id,station]));
  const thresholdGroups=new Map<string,{worker:RecordRow;date:string;rows:RecordRow[]}>();
  for(const row of thresholdContext?.shipments??facts.shipments) {
    const matches=thresholdMappings.filter(mapping=>key(mapping.provider_member_id)===key(row.provider_employee_id)&&activeOn(mapping,row.work_date)&&
      (!mapping.station_id||thresholdStationById.get(mapping.station_id)?.station_code===row.station_code)&&
      (thresholdProviders.get(mapping.provider_id)??'').includes(compact(row.client)));
    const identities=new Set(matches.map(mapping=>mapping.worker?.id).filter(Boolean));
    if(identities.size!==1||matches.some(mapping=>!mapping.worker)) continue;
    const worker=matches[0].worker!;
    const groupKey=`${worker.id}|${row.work_date}`;
    const group=thresholdGroups.get(groupKey)??{worker,date:row.work_date,rows:[] as RecordRow[]};
    group.rows.push(row);thresholdGroups.set(groupKey,group);
  }
  const requestedThresholdRows=new Set([...groups.values()].flatMap(group=>group.rows.map(row=>`${group.date}|${String(row.id)}`)));
  for(const g of [...thresholdGroups.values()].sort((a,b)=>a.date.localeCompare(b.date)||String(a.worker.id).localeCompare(String(b.worker.id)))) {
    const candidates=thresholdMappings.filter(m=>m.worker?.id===g.worker.id && activeOn(m,g.date) && configured(m));
    const latest=candidates.sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
    const current=latest ? candidates.filter(m=>m.effective_from===latest.effective_from) : [];
    if(!latest || new Set(current.map(rateSignature)).size>1) continue;
    const card=latest,cs=thresholdComponents.get(card.payment_method_id)??[];
    const values=Object.fromEntries(Object.entries(card.payment_values??{}).map(([k,v])=>[key(k),v]));
    const orderedRows=[...g.rows].sort((a,b)=>String(a.station_code).localeCompare(String(b.station_code))||String(a.id).localeCompare(String(b.id)));
    for(const [rowIndex,row] of orderedRows.entries()) for(const [componentIndex,c] of cs.entries()) {
      const code=key(c.component_code),isProduction=c.component_type==='production'||c.calculation_type==='count_x_rate';
      if(!isProduction) continue;
      const source=c.provider_calculation_sources?.[String(row.client??'Amazon').toLowerCase()]||c.calculation_source||code;
      const stationId=thresholdStationById.size ? [...thresholdStationById.values()].find(s=>s.station_code===row.station_code)?.id : card.station_id;
      const uploaded=findWorkforceProductionInput(inputMaps,{workforceId:g.worker.id,stationId,paymentFieldId:c.payment_field_id,fieldCode:code,date:g.date});
      const firstAtStation=orderedRows.findIndex(r=>r.station_code===row.station_code)===rowIndex;
      const count=uploaded ? (firstAtStation?Number(uploaded.units):0) : production(row,source) ?? (c.is_custom_production?0:null);
      if(count==null) continue;
      const inputId=`${card.id}|${g.date}|${String(row.id)}|${code}|${rowIndex}|${componentIndex}`;
      thresholdInputs.push({
        id:inputId,
        workforceId:String(g.worker.id),
        mappingId:String(card.id),
        date:g.date,
        effectiveFrom:String(card.effective_from),
        effectiveTo:card.effective_to?String(card.effective_to):null,
        componentCode:code,
        componentOrder:Number.isFinite(Number(c.sort_order))?Number(c.sort_order):componentIndex,
        reportedUnits:count,
        rate:num(resolveWorkforcePaymentFieldRate(inputMaps,{workforceId:g.worker.id,stationId,paymentFieldId:c.payment_field_id,fieldCode:code,date:g.date,fallbackRate:values[code]})),
        thresholdConfig:card.production_threshold_config,
        methodThresholdConfig:card.method_production_threshold_config
      });
      if(requestedThresholdRows.has(`${g.date}|${String(row.id)}`)) thresholdInputTargets.set(inputId,{
          rowKey:`${card.id}|${g.date}|${String(row.id)}`,
          groupKey:`${card.id}|${g.worker.id}|${g.date}`
        });
    }
  }
  const thresholdAllocationsByRow=new Map<string,Map<string,WorkforceProductionThresholdAllocation>>();
  const thresholdAllocationsByGroup=new Map<string,Map<string,WorkforceProductionThresholdAllocation>>();
  const mergeThresholdAllocation=(target:Map<string,Map<string,WorkforceProductionThresholdAllocation>>,targetKey:string,allocation:WorkforceProductionThresholdAllocation)=>{
    const byCode=target.get(targetKey)??new Map<string,WorkforceProductionThresholdAllocation>();
    const current=byCode.get(allocation.componentCode);
    byCode.set(allocation.componentCode,current?{
      ...current,
      reportedUnits:current.reportedUnits+allocation.reportedUnits,
      thresholdDeducted:current.thresholdDeducted+allocation.thresholdDeducted,
      payableUnits:current.payableUnits+allocation.payableUnits,
      amount:Math.round((current.amount+allocation.amount)*100)/100,
      thresholdConfigurationMissing:current.thresholdConfigurationMissing||allocation.thresholdConfigurationMissing
    }:allocation);
    target.set(targetKey,byCode);
  };
  for(const allocation of allocateCombinedProductionThresholds(thresholdInputs)) {
    const target=thresholdInputTargets.get(allocation.id);
    if(!target) continue;
    mergeThresholdAllocation(thresholdAllocationsByRow,target.rowKey,allocation);
    mergeThresholdAllocation(thresholdAllocationsByGroup,target.groupKey,allocation);
  }
  const people=new Map<string,CpsPersonCost>();
  const detailDays:CpsDaDay[]=[];
  const employeeCostDays=new Set<string>();
  // Canonical employee CTC replaces fixed DA components for that employee, so it cannot be counted twice.
  for(const e of facts.employees) for(const date of dates) {
    if(!employedOn(e,date)) continue;
    const salary=facts.salaries.filter(s=>s.employee_id===e.id && activeOn(s,date)).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
    if(salary?.monthly_ctc!=null && policyFor(e,date)?.mode && policyFor(e,date)?.mode!=='excluded') employeeCostDays.add(`${e.id}|${date}`);
  }
  for(const g of groups.values()) {
    // A single effective card belongs to the DropX identity; multiple provider IDs share fixed pay once.
    const candidates=mappings.filter(m=>m.worker?.id===g.worker.id && activeOn(m,g.date) && configured(m));
    const latest=candidates.sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
    const current=latest ? candidates.filter(m=>m.effective_from===latest.effective_from) : [];
    const conflict=new Set(current.map(rateSignature)).size>1;
    let card=latest;
    const cs=sourceComponents(card ? components.get(card.payment_method_id)??[] : [],g.date);
    if(card)card=paymentCard(card,cs,g.worker.id,g.date);
    const aggregate:RecordRow={client:g.rows[0].client};
    for(const field of ['amazon_delivery','swa_delivery','total_delivery','total_activity','c_return','mfn','mfn_return']) aggregate[field]=g.rows.reduce((n,r)=>n+num(r[field]),0);
    const workerDateKey=`${g.worker.id}|${g.date}`;
    const range=card?rangeInput(g.worker.id,card.station_id,g.date):undefined;
    const costs=card ? calculateRateCard(
      card,cs,aggregate,g.date,true,
      attendanceByWorkerDate.get(workerDateKey) as DirectPayAttendance|undefined,
      facts.payment_policy_history,
      cumulativeAttendanceUnitsBefore.get(workerDateKey)??0,
      hasWorkforcePayoutAttendanceOverride(inputMaps,g.worker.id,g.date)?'biometric':workforceAttendanceCaptureSettingForDate(facts.attendance_capture_history,g.date).capture_method,
      thresholdAllocationsByGroup.get(`${card.id}|${g.worker.id}|${g.date}`),range?.input
    ) : {salary:0,variable:0,fuel:0,van:0,missing:true};
    const thresholdConfigurationMissing=card
      ? [...(thresholdAllocationsByGroup.get(`${card.id}|${g.worker.id}|${g.date}`)?.values()??[])]
        .some((allocation)=>allocation.thresholdConfigurationMissing)
      : false;
    const issue=conflict
      ? 'Conflicting rate cards'
      : !card
        ? 'Payment setup missing'
        : thresholdConfigurationMissing
          ? 'Combined production minimum missing'
          : costs.missing ? 'Rate values or production source missing' : '';
    if(issue) {
      for(const row of g.rows) {row.mapping_status=issue;gap(issue,row.station_code,g.date,row.provider_employee_id,g.worker.full_name,g.worker.dropx_id,num(row.total_delivery));}
      if(conflict || !card || thresholdConfigurationMissing) continue;
    }
    if(g.worker.source_profile_type==='employee' && employeeCostDays.has(`${g.worker.source_profile_id}|${g.date}`)) costs.salary=0;
    const volumes=new Map<string,number>();g.rows.forEach(r=>volumes.set(r.station_code,(volumes.get(r.station_code)??0)+num(r.total_delivery)));
    const salaryByStation=allocateCost(costs.salary,[...volumes.keys()],volumes);
    const vanByStation=allocateCost(costs.van,[...volumes.keys()],volumes);
    const fuelFixed=costs.fuel-g.rows.reduce((n,r)=>n+(card?calculateRateCard(
      card,cs,r,g.date,false,undefined,undefined,0,'biometric',
      thresholdAllocationsByRow.get(`${card.id}|${g.date}|${String(r.id)}`)
    ).fuel:0),0);
    const fuelByStation=allocateCost(fuelFixed,[...volumes.keys()],volumes);
    const seenStations=new Set<string>();
    for(const row of g.rows) {
      const rowStationId=[...stationById.values()].find(s=>s.station_code===row.station_code)?.id;
      const rowCard=paymentCard(card!,cs,g.worker.id,g.date,rowStationId);
      const missingInputs=cs.filter(c=>c.is_custom_production && c.cps_cost_source!=='pnl_only'
        && num(rowCard.payment_values[key(c.component_code)])>0
        && !findWorkforceProductionInput(inputMaps,{workforceId:g.worker.id,stationId:rowStationId,paymentFieldId:c.payment_field_id,fieldCode:key(c.component_code),date:g.date}));
      if(num(row.total_activity)>0 || directPayAttendanceUnit(attendanceByWorkerDate.get(workerDateKey) as DirectPayAttendance|undefined)>0)
        for(const c of missingInputs)gap(`${c.label||c.component_code} input missing`,row.station_code,g.date,row.provider_employee_id,g.worker.full_name,g.worker.dropx_id,num(row.total_delivery),0,'Operations uploads');
      const variable=calculateRateCard(
        rowCard,cs,row,g.date,false,undefined,undefined,0,'biometric',
        thresholdAllocationsByRow.get(`${card!.id}|${g.date}|${String(row.id)}`)
      );
      const first=!seenStations.has(row.station_code);seenStations.add(row.station_code);
      row.variable_pay=variable.variable;row.mg_pay=first?salaryByStation.get(row.station_code)??0:0;
      row.fuel_pay=variable.fuel+(first?fuelByStation.get(row.station_code)??0:0);
      row.van_pay=first?vanByStation.get(row.station_code)??0:0;
      row.da_total_pay=row.variable_pay+row.mg_pay+row.fuel_pay;row.pay_type=card!.pay_type;row.mapping_status=issue||'Mapped';
      const attendance=attendanceByWorkerDate.get(workerDateKey) as DirectPayAttendance|undefined;
      const attendanceWorked=directPayAttendanceUnit(attendance)>0;
      const worked=attendanceWorked || [row.total_activity,row.total_delivery,row.c_return,row.mfn,row.mfn_return].some(v=>num(v)>0);
      const pendingFixed = !attendance && worked && cs.some(c=>c.component_type!=='production' && c.calculation_type!=='count_x_rate'
        && c.calculation_source==='attendance_eligibility' && c.cps_cost_source!=='fleet'
        && !/VAN|VEHICLE|DOCK|FUEL|KILOMET|\bKM\b/i.test(`${c.component_code} ${c.label}`)
        && num(Object.entries(card!.payment_values??{}).find(([k])=>key(k)===key(c.component_code))?.[1])>0)
        && !(g.worker.source_profile_type==='employee' && employeeCostDays.has(`${g.worker.source_profile_id}|${g.date}`));
      if(range&&!range.complete) gap(range.valid?'Uploaded attendance range needs full-period view':'Uploaded attendance range crosses payment setup changes',row.station_code,g.date,row.provider_employee_id,g.worker.full_name,g.worker.dropx_id,num(row.total_delivery),0,'Workforce attendance');
      const review=worked?shipmentAttendanceReview(shipmentDeliveries.get(workerDateKey)??0,workforceAttendanceCaptureSettingForDate(facts.attendance_capture_history,g.date)):null;
      if(review)gap(`Low deliveries · below ${review.threshold}`,row.station_code,g.date,row.provider_employee_id,g.worker.full_name,g.worker.dropx_id,num(row.total_delivery),0,'Workforce attendance');
      if(pendingFixed) gap('Fixed pay attendance missing',row.station_code,g.date,row.provider_employee_id,g.worker.full_name,g.worker.dropx_id,num(row.total_delivery),row.da_total_pay,'Workforce attendance');
      detailDays.push({worker_id:g.worker.id,dropx_id:g.worker.dropx_id,name:g.worker.full_name,
        station_code:row.station_code,date:g.date,provider_ids:[row.provider_employee_id],
        cohort:hasFixedDaPay(card!,cs)||employeeCostDays.has(`${g.worker.source_profile_id}|${g.date}`)?'guarantee':'variable',
        worked,work_basis:attendanceWorked?'attendance':worked?'shipment activity':'no work evidence',
        deliveries:num(row.total_delivery),customer_returns:num(row.c_return),seller_pickups:0,seller_returns:0,
        salary:row.mg_pay,variable:row.variable_pay,fuel:row.fuel_pay,van:row.van_pay,
        production_details:variable.production_details,pending_fixed_pay:pendingFixed || Boolean(range&&!range.complete) || Boolean(issue) || missingInputs.length>0,
        source:'Workforce rate card',card_from:card!.effective_from,rates:detailRates(rowCard,cs,String(row.client??'Amazon'))});
      add(row.station_code,g.date,'DA','Salary / minimum guarantee',row.mg_pay,'Workforce rate card');
      add(row.station_code,g.date,'DA','Variable delivery pay',row.variable_pay,'Workforce rate card');
      add(row.station_code,g.date,'DA','DA fuel',row.fuel_pay,'Workforce rate card');
      add(row.station_code,g.date,'Van','Vehicle pay from rate card',row.van_pay,'Workforce rate card');
      const k=`${g.worker.id}|${row.station_code}`,p=people.get(k)??{id:g.worker.id,dropx_id:g.worker.dropx_id,name:g.worker.full_name,station_code:row.station_code,salary:0,variable:0,fuel:0,van:0,deliveries:0,paid_days:0,zero_delivery_days:0};
      p.salary+=row.mg_pay;p.variable+=row.variable_pay;p.fuel+=row.fuel_pay;p.van+=row.van_pay;p.deliveries+=num(row.total_delivery);
      if(first){p.paid_days++;if((volumes.get(row.station_code)??0)===0 && costs.salary>0)p.zero_delivery_days++;}people.set(k,p);
    }
  }
  // Providerless designations accrue from their direct, effective-dated allocation.
  // A historical provider mapping remains authoritative for its own dates; a direct
  // allocation may never overlap it because that would create duplicate pay.
  const directAllocations=(facts.allocations??[]).filter(a=>a.status!=='cancelled');
  const policyHistoryProvided=Array.isArray(facts.policy_history);
  const paymentPolicyOn=(w:RecordRow,date:string):{
    station_id:string|null;
    station_code_snapshot:string|null;
    designation_is_active:boolean;
    is_field_operations:boolean;
    provider_mapping_required:boolean;
  }|null=>{
    if(!policyHistoryProvided) return {
      station_id:w.location_id??null,
      station_code_snapshot:stationById.get(w.location_id)?.station_code??null,
      designation_is_active:w.designation_is_active!==false,
      is_field_operations:w.designation_is_active!==false&&w.is_field_operations!==false,
      provider_mapping_required:w.designation_is_active!==false&&w.provider_mapping_required!==false,
    };
    const history=facts.policy_history!.filter(policy=>policy.workforce_id===w.id&&activeOn(policy,date))
      .sort((a,b)=>String(b.effective_from).localeCompare(String(a.effective_from)))[0];
    return history ? {
      station_id:history.station_id??null,
      station_code_snapshot:history.station_code_snapshot??null,
      designation_is_active:history.designation_is_active!==false,
      is_field_operations:history.designation_is_active!==false&&history.is_field_operations===true,
      provider_mapping_required:history.designation_is_active!==false&&history.provider_mapping_required===true,
    } : null;
  };
  for(const w of facts.workforce) {
    for(const date of dates) {
      if(!employedOn(w,date)) continue;
      const policy=paymentPolicyOn(w,date);
      const providerCards=mappings.filter(m=>m.worker?.id===w.id&&activeOn(m,date)&&configured(m));
      const cards=directAllocations.filter(a=>a.workforce_id===w.id&&allocationActiveOn(a as {effective_from:string;effective_to?:string|null},date)).sort((a,b)=>String(b.effective_from).localeCompare(String(a.effective_from)));
      const station=stationById.get(cards[0]?.station_id)?.station_code
        ??stationById.get(policy?.station_id)?.station_code
        ??policy?.station_code_snapshot
        ??(!policyHistoryProvided?stationById.get(w.location_id)?.station_code:undefined);
      if(!station || !selected.has(station)) continue;
      if(providerCards.length&&cards.length) {
        gap('Conflicting provider and direct pay setup',station,date,'',w.full_name,w.dropx_id,0,0,'Workforce direct pay');
        continue;
      }
      // Preserve a valid historical provider card after the designation policy changes.
      if(providerCards.length) continue;
      if(!cards.length) {
        // Current flags are not evidence of historical policy. New source payloads
        // supply an effective-dated ledger; dates before its first honest snapshot
        // deliberately produce no policy-derived gap.
        if(!policy?.designation_is_active || !policy.is_field_operations) continue;
        if(!policy.provider_mapping_required) gap('Direct payment allocation missing',station,date,'',w.full_name,w.dropx_id,0,0,'Workforce direct pay');
        continue;
      }
      const latest=cards[0],current=cards.filter(a=>a.effective_from===latest.effective_from);
      if(new Set(current.map(rateSignature)).size>1) {
        gap('Conflicting direct payment allocations',station,date,'',w.full_name,w.dropx_id,0,0,'Workforce direct pay');
        continue;
      }
      const snapshotComponents=Array.isArray(latest.payment_components) ? latest.payment_components.filter((component:unknown)=>component&&typeof component==='object') as DirectPayComponent[] : [];
      const allDirectComponents=snapshotComponents.length ? snapshotComponents : (components.get(latest.payment_method_id)??[]) as DirectPayComponent[];
      const directComponents=sourceComponents(allDirectComponents,date).filter(c=>c.cps_cost_source!=='pnl_only' && (c.cps_cost_source!=='fleet' || c.component_type==='production' || c.calculation_type==='count_x_rate'));
      // A rental-only card is covered by Fleet and is not a missing pay setup.
      if(allDirectComponents.length && !directComponents.length) continue;
      const workerDateKey=`${w.id}|${date}`;
      const captureSetting=workforceAttendanceCaptureSettingForDate(facts.attendance_capture_history,date);
      const directRange=rangeInput(w.id,latest.station_id,date);
      if(directRange&&!directRange.complete)gap(directRange.valid?'Uploaded attendance range needs full-period view':'Uploaded attendance range crosses payment setup changes',station,date,'',w.full_name,w.dropx_id,0,0,'Workforce attendance');
      const result=directPayForDay(
        paymentCard(latest,directComponents,w.id,date).payment_values,
        directComponents,
        date,
        attendanceByWorkerDate.get(workerDateKey) as {punch_date:string;status?:string|null;in_time?:string|null;out_time?:string|null;work_minutes?:number|string|null}|undefined,
        {policyHistory:facts.payment_policy_history,cumulativeAttendanceUnitsBefore:cumulativeAttendanceUnitsBefore.get(workerDateKey)??0,attendanceSource:captureSetting.capture_method,attendanceInput:rangeInput(w.id,latest.station_id,date)?.input}
      );
      if(result.missing) {
        gap('Direct payment allocation incomplete',station,date,'',w.full_name,w.dropx_id,0,0,'Workforce direct pay');
        continue;
      }
      let salary=0,fuel=0,van=0;
      const salaryCoveredByPeople = w.source_profile_type==='employee'
        && employeeCostDays.has(`${w.source_profile_id}|${date}`);
      for(const line of result.lines) {
        if(line.bucket==='van') {van+=line.amount;add(station,date,'Van',line.label,line.amount,'Direct workforce allocation');}
        else if(line.bucket==='fuel') {fuel+=line.amount;add(station,date,'DA',line.label,line.amount,'Direct workforce allocation');}
        else if(!salaryCoveredByPeople) {salary+=line.amount;add(station,date,'DA',`Salary / ${line.label}`,line.amount,'Direct workforce allocation');}
      }
      if(salaryCoveredByPeople && salary===0 && fuel===0 && van===0) continue;
      if(!result.total&&!result.present&&!result.lines.some(line=>line.schedule==='per_month')) continue;
      const synthetic={id:`direct:${w.id}:${date}`,client:'Direct',work_date:date,station_code:station,provider_employee_id:'',provider_employee_name:w.full_name,dropx_name:w.full_name,dropx_emp_code:w.dropx_id,pay_type:'DIRECT',total_delivery:0,total_activity:result.present?1:0,c_return:0,mfn:0,mfn_return:0,variable_pay:0,mg_pay:salary,fuel_pay:fuel,van_pay:van,da_total_pay:salary+fuel,mapping_status:'Mapped'} as LiveAssociate;
      associates.push(synthetic);
      detailDays.push({worker_id:w.id,dropx_id:w.dropx_id,name:w.full_name,station_code:station,date,provider_ids:[],
        cohort:'guarantee',worked:result.present,work_basis:result.present?'attendance':'no work evidence',
        deliveries:0,customer_returns:0,seller_pickups:0,seller_returns:0,salary,variable:0,fuel,van,
        pending_fixed_pay:Boolean(directRange&&!directRange.complete),source:'Direct workforce allocation',card_from:latest.effective_from,rates:detailRates(paymentCard(latest,directComponents,w.id,date),directComponents,'Direct')});
      const personKey=`${w.id}|${station}`,person=people.get(personKey)??{id:w.id,dropx_id:w.dropx_id,name:w.full_name,station_code:station,salary:0,variable:0,fuel:0,van:0,deliveries:0,paid_days:0,zero_delivery_days:0};
      person.salary+=salary;person.fuel+=fuel;person.van+=van;if(result.total>0){person.paid_days++;person.zero_delivery_days++;}people.set(personKey,person);
    }
  }
  // Only designations that require an external provider identity create provider-link gaps.
  const through=dates.at(-1);
  if(through) for(const w of facts.workforce) {
    const policy=paymentPolicyOn(w,through);
    if(!policy?.designation_is_active || !policy.is_field_operations || !policy.provider_mapping_required) continue;
    const station=stationById.get(policy.station_id)?.station_code
      ??policy.station_code_snapshot
      ??(!policyHistoryProvided?stationById.get(w.location_id)?.station_code:undefined);
    if(!station || !selected.has(station) || !employedOn(w,through)) continue;
    if(directAllocations.some(a=>a.workforce_id===w.id&&allocationActiveOn(a as {effective_from:string;effective_to?:string|null},through))) continue;
    const current=mappings.filter(m=>m.worker?.id===w.id && activeOn(m,through));
    if(!current.some(m=>key(m.provider_member_id))) gap('Provider ID not linked',station,through,'',w.full_name,w.dropx_id);
    else if(!current.some(configured) && ![...gaps.values()].some(g=>g.dropx_id===w.dropx_id && g.kind==='Payment setup missing')) gap('Payment setup missing',station,through,current[0].provider_member_id,w.full_name,w.dropx_id);
  }
  const staff=new Map<string,CpsStaffCost>();
  const allocationNotices=new Set<string>();
  const staffed=new Set<string>(),missingCtc=new Set<string>();
  const operating=facts.stations.filter(s=>s.is_active && !s.hide_from_location_list && !s.is_ho && !/^HO(?:_|$)/.test(s.station_code));
  for(const e of facts.employees) for(const date of dates) {
    if(!employedOn(e,date)) continue;
    const policy=policyFor(e,date);
    if(!policy) continue;
    if(policy.mode==='excluded') continue;
    const home=stationById.get(e.location_id);
    const rules=facts.people_rules.filter(r=>r.employee_id===e.id && activeOn(r,date)).sort((a,b)=>b.effective_from.localeCompare(a.effective_from));
    const rule=rules[0];
    const overhead=policy.mode==='managed';
    const linkedWorkforce=facts.workforce.find(w=>w.source_profile_type==='employee'&&w.source_profile_id===e.id);
    const linkedPolicy=linkedWorkforce?paymentPolicyOn(linkedWorkforce,date):null;
    const linkedAllocation=linkedWorkforce?directAllocations.filter(a=>a.workforce_id===linkedWorkforce.id&&allocationActiveOn(a as {effective_from:string;effective_to?:string|null},date)).sort((a,b)=>String(b.effective_from).localeCompare(String(a.effective_from)))[0]:undefined;
    const datedWorkforceOwnership=Boolean(linkedWorkforce&&(linkedAllocation||(linkedPolicy?.designation_is_active&&linkedPolicy.is_field_operations)));
    const workforceStation=stationById.get(linkedAllocation?.station_id)?.station_code
      ??stationById.get(linkedPolicy?.station_id)?.station_code
      ??linkedPolicy?.station_code_snapshot;
    let codes:string[]=rule?.station_codes??[];
    let head:CpsHead=rule?.head ?? policy.head;
    if(!rule) {
      if(!overhead) {
        const homeHistory=(facts.people_assignments??[]).filter(a=>a.employee_id===e.id && (a as RecordRow).kind==='home');
        const assigned=homeHistory.filter(a=>activeOn(a,date)&&operating.some(s=>s.station_code===a.station_code));
        codes=datedWorkforceOwnership?(workforceStation?[workforceStation]:[]):(homeHistory.length||e.has_home_assignments)
          ? [...new Set(assigned.map(a=>a.station_code))] : operating.some(s=>s.id===home?.id)?[home!.station_code]:[];
      }
      else {
        // The current People assignment history is authoritative when supplied;
        // an expired assignment must not revive an old org-position/email scope.
        if(facts.people_assignments) codes=[...new Set(facts.people_assignments.filter(a=>a.employee_id===e.id&&activeOn(a,date)&&operating.some(s=>s.station_code===a.station_code)).map(a=>a.station_code))];
        else {
          codes=operating.filter(s=>(e.location_scope_ids??[]).includes(s.id)).map(s=>s.station_code);
          if(!codes.length && e.email) codes=operating.filter(s=>[s.cluster_manager_email,s.ops_manager_email].some(v=>key(v)===key(e.email))).map(s=>s.station_code);
        }
      }
    }
    // An unassigned role is not a station exception. Missing CTC is flagged
    // only after a verified operating-station assignment exists.
    if(!codes.length) continue;
    if(!codes.some(c=>selected.has(c))) continue;
    const salary=facts.salaries.filter(s=>s.employee_id===e.id && activeOn(s,date)).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
    if(!salary || salary.monthly_ctc==null || num(salary.monthly_ctc)<=0) {
      for(const c of codes) {missingCtc.add(`${c}|${date}`);gap('People CTC missing',c,date,'',e.full_name,e.employee_code,0,0,'People / Finance');}continue;
    }
    const shares=allocateCost(monthlyAccrual(num(salary.monthly_ctc),date),codes,dailyVolumes.get(date)??new Map(),rule?.allocation??policy.allocation);
    for(const [station,amount] of shares) {
      if(head==='UTR')staffed.add(`${station}|${date}`);
      add(station,date,head,policy.label,amount,'People CTC');
      if(selected.has(station)) {
        const allocation=rule?.allocation ?? policy.allocation;
        const staffKey=`${station}|${head}|${policy.label}|${allocation}`;
        const row=staff.get(staffKey) ?? {group:policy.label,station_code:station,head,
          from_date:date,through_date:date,amount:0,allocation,roles:[]};
        if(!row.roles!.includes(policy.designation_name||policy.designation_code)) row.roles!.push(policy.designation_name||policy.designation_code);
        row.from_date=row.from_date<date?row.from_date:date;row.through_date=row.through_date>date?row.through_date:date;row.amount+=amount;staff.set(staffKey,row);
      }
      if((head==='DA'||head==='Van') && selected.has(station)) {
        const k=`${linkedWorkforce?.id??e.id}|${station}`,p=people.get(k)??{id:linkedWorkforce?.id??e.id,dropx_id:e.employee_code,name:e.full_name,station_code:station,salary:0,variable:0,fuel:0,van:0,deliveries:0,paid_days:0,zero_delivery_days:0};
        if(head==='Van')p.van+=amount;else p.salary+=amount;people.set(k,p);
        if(head==='DA') detailDays.push({worker_id:linkedWorkforce?.id??e.id,dropx_id:linkedWorkforce?.dropx_id??e.employee_code,
          name:linkedWorkforce?.full_name??e.full_name,station_code:station,date,provider_ids:[],cohort:'guarantee',
          worked:false,work_basis:'no work evidence',deliveries:0,customer_returns:0,seller_pickups:0,seller_returns:0,
          salary:amount,variable:0,fuel:0,van:0,source:'People CTC',card_from:salary.effective_from,
          rates:[{label:'People DA CTC',rate:num(salary.monthly_ctc),basis:'per calendar month · allocated station share'}]});
      }
    }
  }
  for(const d of base.daily) {
    if(facts.rent_coverage && !facts.rent_coverage.some(r=>r.station_code===d.station_code && activeOn(r,d.work_date)) && !(facts.manual_inputs??[]).some(r=>r.head==='Rent' && r.station_codes.includes(d.station_code) && activeOn(r,d.work_date))) gap('Facility rent missing',d.station_code,d.work_date,'','','',0,0,'People / Finance');
    if(!d.shipment_present) gap('Shipment upload missing',d.station_code,d.work_date,'','','',0,0,'Operations uploads');
  }
  for(const bill of base.expense_periods??[]) if(!bill.confirmed) {
    const first=dates.find(d=>d>=bill.period_from&&d<=bill.period_to);
    if(first) {
      gap('Billing period unconfirmed',bill.station_code,first,bill.source_id,bill.label,'',0,0,'Finance billing');
      const issue=gaps.get(`Billing period unconfirmed|${bill.station_code}|${bill.source_id}|`);
      if(issue){issue.href=`/cps?head=Other&station=${encodeURIComponent(bill.station_code)}&period=monthly&month=${first.slice(0,7)}`;issue.last_date=dates.filter(d=>d<=bill.period_to).at(-1)??first;}
    }
  }
  const ledgerByDay=new Map<string,CpsLine[]>();
  for(const line of lines) {
    const key=`${line.station_code}|${line.work_date}`;
    const group=ledgerByDay.get(key)??[];group.push(line);ledgerByDay.set(key,group);
  }
  const daily=base.daily.map(d=>{
    const ledger=ledgerByDay.get(`${d.station_code}|${d.work_date}`)??[];
    const sum=(head:string,sub?:string)=>ledger.filter(l=>l.head===head&&(!sub||l.sub_head===sub)).reduce((n,l)=>n+num(l.amount),0);
    const daBucket=(bucket:string)=>ledger.filter(l=>l.head==='DA' && (bucket==='salary'?/salary|minimum|guarantee|\bmg\b|fixed/i.test(l.sub_head):bucket==='fuel'?/fuel/i.test(l.sub_head):!/salary|minimum|guarantee|\bmg\b|fixed|fuel/i.test(l.sub_head))).reduce((n,l)=>n+num(l.amount),0);
    const rows=associates.filter(r=>r.station_code===d.station_code&&r.work_date===d.work_date);
    const unresolved=rows.filter(r=>r.mapping_status!=='Mapped' && num(r.total_delivery)+num(r.c_return)>0);
    const dayGaps=[...gaps.values()].filter(g=>g.station_code===d.station_code&&g.first_date<=d.work_date&&g.last_date>=d.work_date);
    return {...d,mfn:0,mfn_return:0,activity:Math.max(0,num(d.activity)-num(d.mfn)-num(d.mfn_return)),da:sum('DA'),utr:sum('UTR'),van:sum('Van'),rent:sum('Rent'),overhead:sum('Overhead'),other:sum('Other'),
      da_salary:daBucket('salary'),da_variable:daBucket('variable'),da_fuel:daBucket('fuel'),
      total:ledger.reduce((n,l)=>n+num(l.amount),0),unmapped:unresolved.length,unpaid:0,
      exposed_deliveries:unresolved.reduce((n,r)=>n+num(r.total_delivery),0),cost_gaps:dayGaps.length+allocationNotices.size,
      utr_configured:!missingCtc.has(`${d.station_code}|${d.work_date}`)};
  });
  const privateEmployees=facts.employees.filter(e=>!['DA','DCD','ODCD','WM','PTDA','DR'].includes(e.designation));
  const privateCodes=new Set(privateEmployees.map(e=>e.employee_code).filter(Boolean));
  const privateWorkerIds=new Set(facts.workforce.filter(w=>w.source_profile_type==='employee'&&privateEmployees.some(e=>e.id===w.source_profile_id)).map(w=>w.id));
  for(const g of gaps.values()) if(privateCodes.has(g.dropx_id)) {g.name='';g.dropx_id='';g.provider_id='';}
  return {...base,da_details:summarizeDaDetails(detailDays.filter(d=>selected.has(d.station_code)&&!privateCodes.has(d.dropx_id)&&!privateWorkerIds.has(d.worker_id))),allocation_notices:[...allocationNotices],staff:[...staff.values()].sort((a,b)=>b.amount-a.amount),daily,breakup:lines,associates:associates.filter(r=>selected.has(r.station_code)&&!privateCodes.has(r.dropx_emp_code)).map(r=>({...r,mfn:0,mfn_return:0,total_activity:Math.max(0,num(r.total_activity)-num(r.mfn)-num(r.mfn_return))})),gaps:[...gaps.values()].sort((a,b)=>b.deliveries-a.deliveries||a.first_date.localeCompare(b.first_date)),people:[...people.values()].filter(p=>selected.has(p.station_code)&&!privateCodes.has(p.dropx_id)&&!privateWorkerIds.has(p.id)).sort((a,b)=>b.salary-a.salary)};
}
