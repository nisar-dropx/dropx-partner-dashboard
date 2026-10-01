import type {PendingStation} from './cod-pending';

export type CodDailyUpdateFact={location_id:string|null;report_date:string|null};
export type CodNoUpdateStreak={stationId:string;stationCode:string;days:number};
export const codNoUpdateBands=[
 {key:'1',label:'1 day',min:1,max:1,color:'#92400e',background:'#fef3c7'},
 {key:'2',label:'2 days',min:2,max:2,color:'#9a3412',background:'#ffedd5'},
 {key:'3-4',label:'3–4 days',min:3,max:4,color:'#c2410c',background:'#fed7aa'},
 {key:'5-6',label:'5–6 days',min:5,max:6,color:'#b91c1c',background:'#fee2e2'},
 {key:'7+',label:'7+ days',min:7,max:Infinity,color:'#7f1d1d',background:'#fecaca'}
] as const;

export function previousReportDate(date:string,days:number){
 const value=new Date(date+'T12:00:00Z');value.setUTCDate(value.getUTCDate()-days);return value.toISOString().slice(0,10);
}
export function buildCodNoUpdateStreaks(stations:PendingStation[],updates:CodDailyUpdateFact[],date:string):CodNoUpdateStreak[]{
 const recorded=new Set(updates.filter(row=>row.location_id&&row.report_date).map(row=>`${row.location_id}:${row.report_date}`));
 return stations.map(station=>{
  let days=0;
  for(let offset=0;offset<7;offset++){if(recorded.has(`${station.id}:${previousReportDate(date,offset)}`))break;days++;}
  return {stationId:station.id,stationCode:station.station_code,days};
 }).filter(row=>row.days>0).sort((a,b)=>b.days-a.days||a.stationCode.localeCompare(b.stationCode));
}
export function codNoUpdateBand(days:number){return codNoUpdateBands.find(band=>days>=band.min&&days<=band.max);}
