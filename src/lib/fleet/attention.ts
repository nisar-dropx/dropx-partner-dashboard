import { documentApplies } from "./source-policy.ts";
import {gpsExceptions,isOwnedVehicle} from './gps-exceptions.ts';
import type { FleetControlData } from '../fleet-control';
export type AttentionItem={id:string;title:string;detail:string;station:string;vehicle:string;vehicleId:string;due:string|null;priority:number;category:string;section:string;documentType?:string;findingId?:string;auditId?:string;resolved?:boolean};
export function fleetAttention(data:FleetControlData):AttentionItem[]{
 const ownedIds=new Set(data.vehicles.filter(isOwnedVehicle).map(v=>v.id));
 const rows:AttentionItem[]=[];const can=(s:string)=>data.capabilities.visibleSections.includes(s);
 if(can('audits'))for(const f of data.findings)if(ownedIds.has(f.vehicleId))rows.push({id:`finding-${f.id}`,title:f.finding,detail:f.actionRequired,station:f.stationCode,vehicle:f.vehicleNo,vehicleId:f.vehicleId,due:f.dueDate,priority:f.severity==='critical'?0:f.severity==='high'?1:2,category:'Audit findings',section:'audits',findingId:f.id,resolved:['resolved','accepted'].includes(f.status)});
 for(const v of data.vehicles){
  if(['sold','disposed','returned'].includes(v.status))continue;
  if(can('vehicles')&&(v.rentAmount==null||!['monthly','daily'].includes(v.rentPeriod||'')))rows.push({id:`rent-${v.id}`,title:'Rent not set',detail:'Set an amount and Per month / Per day. Used by CPS and P&L.',station:v.stationCode,vehicle:v.vehicleNo,vehicleId:v.id,due:null,priority:2,category:'Rent setup',section:'vehicles'});
  if(can('vehicles')&&!(data.vehicleStatuses?.find(s=>s.key===v.status)?.isOperational ?? v.status==='active'))rows.push({id:`return-${v.id}`,title:`${v.statusLabel}${v.expectedOperationalDate&&v.expectedOperationalDate<data.today?' · return overdue':''}`,detail:v.statusComment||'Update the vehicle condition and expected return.',station:v.stationCode,vehicle:v.vehicleNo,vehicleId:v.id,due:v.expectedOperationalDate,priority:v.status==='breakdown'?0:1,category:'Availability',section:'vehicles'});
  if(can('service')&&isOwnedVehicle(v)&&v.nextServiceDate&&v.nextServiceDate<=new Date(Date.parse(`${data.today}T00:00:00Z`)+data.settings.serviceWarningDays*86400000).toISOString().slice(0,10))rows.push({id:`service-${v.id}`,title:'Scheduled service',detail:'Review service due date and book the workshop.',station:v.stationCode,vehicle:v.vehicleNo,vehicleId:v.id,due:v.nextServiceDate,priority:2,category:'Service',section:'service'});
  if(can('documents'))for(const d of data.documentTypes){
   if(!documentApplies(d,v))continue;
   const saved=data.documents.find(x=>x.vehicleNo===v.vehicleNo&&x.documentType===d.value);
   const due=saved?.expiryDate||null;
   if(!saved || (d.requiresExpiry && (!due || due<=new Date(Date.parse(`${data.today}T00:00:00Z`)+d.reminderDays*86400000).toISOString().slice(0,10))))rows.push({id:`doc-${v.id}-${d.value}`,title:`${d.label} · ${!saved?'copy missing':!due?'expiry missing':due<data.today?'expired':'due soon'}`,detail:'Review the saved copy and update the document.',station:v.stationCode,vehicle:v.vehicleNo,vehicleId:v.id,due,priority:due&&due<data.today?1:2,category:'Documents',section:'documents',documentType:d.value});
  }
 }
 if(can('audits'))for(const a of data.audits)if(ownedIds.has(a.vehicleId)&&['scheduled','in_progress'].includes(a.status)&&a.scheduledFor<=data.today)rows.push({id:`audit-${a.id}`,title:`${a.auditMode==='physical'?'Physical':'Virtual'} audit ${a.status==='in_progress'?'in progress':'due'}`,detail:'Complete the scheduled checklist.',station:a.stationCode,vehicle:a.vehicleNo,vehicleId:a.vehicleId,due:a.scheduledFor,priority:2,category:'Audits due',section:'audits',auditId:a.id});
 if(can('tracking'))for(const k of gpsExceptions(data,data.today.slice(0,7)+'-01',data.today)){const v=data.vehicles.find(v=>v.vehicleNo===k.vehicleNo);if(v)rows.push({id:`gps-${v.id}-${k.date}`,title:'Movement outside operating hours',detail:'Review the recorded route and operating times.',station:v.stationCode,vehicle:v.vehicleNo,vehicleId:v.id,due:k.date,priority:1,category:'Tracking exceptions',section:'tracking'});}
 if(can('approvals'))for(const p of data.payments)if(p.canApprove)rows.push({id:`payment-${p.id}`,title:`${p.head} · ₹${p.amount.toLocaleString('en-IN')}`,detail:p.remarks,station:p.stationCode,vehicle:'',vehicleId:'',due:p.workDate||p.requestedAt.slice(0,10),priority:2,category:'Approvals',section:'approvals'});
 return rows.sort((a,b)=>Number(a.resolved)-Number(b.resolved)||a.priority-b.priority||(a.due||'9999').localeCompare(b.due||'9999'));
}
