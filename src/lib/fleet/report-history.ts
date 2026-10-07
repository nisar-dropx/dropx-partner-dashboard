import 'server-only';
import { hasPermission, type AuthorizationContext } from '@/lib/authorization';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { reportScope, FleetReportError } from './report-data';
import { reportDateRangeError } from './operating-policy';
import { loadCodLocations } from '@/lib/ops-pulse/cod';
import { loadAdHocActivity } from '@/lib/ops-pulse/adhoc-activity';
import { fleetAdHocRequestType } from '@/lib/fleet-control-adhoc-scope';
import { isFleetManagerPaymentRequest } from '@/lib/fleet-control-payment-scope';
import type { FleetControlData } from '@/lib/fleet-control';

export const historyReportKeys = ['lifecycle','service','audits','payments','adhoc','capacity'] as const;
export type HistoryReportKey = typeof historyReportKeys[number];
const str = (v:unknown) => String(v ?? '');
const num = (v:unknown) => v == null ? null : Number(v);
/** Dedicated read path: no dashboard caps, no settings/recipient or approval-action payloads. */
export async function loadReportHistory(auth:AuthorizationContext,key:HistoryReportKey,from:string,to:string):Promise<Partial<FleetControlData>> {
  if (!hasPermission(auth,'fleet_reports','access')) throw new FleetReportError('Fleet Reports access is required.',403);
  const invalid = reportDateRangeError(from,to); if(invalid) throw new FleetReportError(invalid,400);
  const scope = await reportScope(auth), db = supabaseAdmin!;
  const read = async (query:Parameters<typeof readAllRows>[0]) => { const result=await readAllRows(query); if(result.error) throw new FleetReportError('The complete report could not be loaded. Retry or narrow the dates.'); return result.data ?? []; };
  const locations = await loadCodLocations(scope.companyId,auth.locationScopeIds,auth.hasAllLocationAccess);
  if(locations.error) throw new FleetReportError('Unable to check report station scope.');
  if(key==='adhoc'||key==='capacity') {
    const activity=await loadAdHocActivity(scope.companyId,locations.locations,from,to,{includeInactiveHeads:true});
    if(activity.error) throw new FleetReportError('Ad hoc history could not be loaded. Retry.');
    return {adHocRows:activity.stations.flatMap(station=>station.days.flatMap(day=>day.entries.flatMap(entry=>{
      const requestType=fleetAdHocRequestType(entry);return requestType?[{id:entry.id,date:day.date,stationCode:station.code,stationName:station.name,cluster:station.cluster||'Unassigned cluster',region:station.region||'Unassigned region',requestType,paymentHeadCode:entry.paymentHeadCode||'',paymentHeadName:entry.paymentHeadName||`Ad hoc ${requestType}`,reference:entry.reference,source:entry.source,reason:entry.reason,remark:entry.remark,amount:entry.amount,approvalStatus:entry.approvalStatus||(entry.source==='Cashbook'?'paid':'submitted')}]:[];
    })))};
  }
  if(key==='payments') {
    const heads=await read(db.from('payment_heads').select('id,code,name').eq('company_id',scope.companyId).order('id'));
    let query=db.from('payment_requests').select('id,request_no,station_code,location_code,payment_head_id,adhoc_reason_key,amount,amount_approved,amount_requested,status,approval_status,created_at,work_date,remarks,notes,profiles:requested_by(full_name,email)').eq('company_id',scope.companyId).neq('status','draft')
      .or(`and(work_date.gte.${from},work_date.lte.${to}),and(work_date.is.null,created_at.gte.${from}T00:00:00+05:30,created_at.lte.${to}T23:59:59.999+05:30)`).order('created_at').order('id');
    if(!auth.hasAllLocationAccess) query=query.in('location_id',locations.locations.map(v=>v.id).length ? locations.locations.map(v=>v.id):['00000000-0000-0000-0000-000000000000']);
    const records=await read(query);
    return {payments:records.filter(row=>isFleetManagerPaymentRequest(heads.find(h=>h.id===row.payment_head_id)??{},row.adhoc_reason_key)).map(row=>{const head=heads.find(h=>h.id===row.payment_head_id);const profile=Array.isArray(row.profiles)?row.profiles[0]:row.profiles;const state=str(row.approval_status||row.status);return {id:row.id,requestNo:row.request_no||row.id,stationCode:row.station_code||row.location_code||'UNASSIGNED',head:head?.name||head?.code||'Vehicle expense',amount:Number(row.amount_approved??row.amount??row.amount_requested??0),requestedBy:profile?.full_name||profile?.email||'Station team',requestedAt:row.created_at,workDate:row.work_date,status:state.toLowerCase(),statusLabel:state.replaceAll('_',' '),remarks:row.remarks||row.notes||'',canApprove:false};})};
  }
  const nos=scope.vehicles.map(v=>v.vehicle_no);
  if(!nos.length) return {serviceHistory:[],audits:[],dailyKm:[],statusHistory:[]};
  const vehicles=await read(db.from('fleet_vehicles').select('id,vehicle_no,station_code,ownership_type').eq('company_id',scope.companyId).in('vehicle_no',nos).order('id'));
  const ids=vehicles.map(v=>v.id), vehicle=(id:string)=>vehicles.find(v=>v.id===id);
  const base=(table:string)=>db.from(table).select('*').eq('company_id',scope.companyId).in('vehicle_id',ids);
  if(key==='audits') {
    const audits=await read(base('fleet_audits').gte('scheduled_for',from).lte('scheduled_for',to).order('scheduled_for').order('id'));
    const evidence=audits.length?await read(db.from('fleet_audit_evidence').select('id,audit_id').eq('company_id',scope.companyId).in('audit_id',audits.map(a=>a.id)).order('id')):[];
    return {audits:audits.map(row=>({id:row.id,vehicleId:row.vehicle_id,vehicleNo:vehicle(row.vehicle_id)?.vehicle_no||'',stationCode:vehicle(row.vehicle_id)?.station_code||'',templateId:row.template_id,auditMode:/\bphysical\b/i.test(row.scheduled_reason||'')?'physical':'video',scheduledFor:row.scheduled_for,scheduledReason:row.scheduled_reason||'',riskScore:Number(row.risk_score||0),status:row.status,score:num(row.score),summary:row.summary||'',completedAt:row.completed_at,emailStatus:row.email_status||'',draft:{},evidence:[],evidenceCount:evidence.filter(e=>e.audit_id===row.id).length}))};
  }
  const services=await read(base('fleet_service_history').gte('service_date',from).lte('service_date',to).order('service_date').order('id'));
  const serviceHistory=services.map(row=>({id:row.id,vehicleId:row.vehicle_id,vehicleNo:vehicle(row.vehicle_id)?.vehicle_no||'',stationCode:vehicle(row.vehicle_id)?.station_code||'',serviceDate:row.service_date,serviceType:row.service_type||'',odometerKm:num(row.odometer_km),vendorName:row.vendor_name||'',vendorContact:row.vendor_contact||'',amount:Number(row.amount||0),status:row.status,description:row.description||'',invoiceUrl:row.invoice_url||'',nextServiceDate:row.next_service_date,nextServiceOdometerKm:num(row.next_service_odometer_km),downtimeHours:num(row.downtime_hours)}));
  if(key==='service')return {serviceHistory};
  const [status,km,availability]=await Promise.all([
    read(base('fleet_vehicle_status_history').lte('started_at',`${to}T23:59:59.999+05:30`).or(`ended_at.is.null,ended_at.gte.${from}T00:00:00+05:30`).order('started_at',{ascending:false}).order('id')),
    read(db.from('fleet_daily_km').select('*').eq('company_id',scope.companyId).in('vehicle_no',nos).gte('movement_date',from).lte('movement_date',to).neq('review_status','needs_review').order('movement_date').order('id')),
    read(base('fleet_vehicle_day_availability').gte('work_date',from).lte('work_date',to).is('revoked_at',null).order('work_date').order('request_id'))
  ]);
  return {serviceHistory,statusHistory:[...availability.map(row=>({id:row.request_id,vehicle_id:row.vehicle_id,vehicle_no:vehicle(row.vehicle_id)?.vehicle_no, status_key:row.status,status_label:str(row.status).replaceAll("_"," "),comment:"Daily replacement request",started_at:`${row.work_date}T00:00:00+05:30`,ended_at:`${row.work_date}T23:59:59.999+05:30`})),...status].map(row=>({id:row.id,vehicleId:row.vehicle_id,vehicleNo:row.vehicle_no,status:row.status_key,statusLabel:row.status_label,statusReasonKey:row.status_reason_key||'',statusReasonLabel:row.status_reason_label||'',comment:row.comment||'',expectedOperationalDate:row.expected_operational_date,startedAt:row.started_at,endedAt:row.ended_at})),dailyKm:km.map(row=>({gpsPolicy:row.gps_policy,vehicleNo:row.vehicle_no,date:row.movement_date,km:Number(row.km),source:row.source,confidencePercent:num(row.confidence_percent),maxSpeed:num(row.max_speed),movingMinutes:num(row.moving_minutes),lateNight:Boolean(row.late_night),firstMovingAt:row.first_moving_at,lastMovingAt:row.last_moving_at,firstMovingLatitude:num(row.first_moving_latitude),firstMovingLongitude:num(row.first_moving_longitude)}))};
}
