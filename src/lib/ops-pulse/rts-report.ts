import type {BoardShareTable,BoardShareCell} from './station-board-share';
export type RtsRow={stationCode:string;trackingId:string;driverId:string;driverName:string;status:string;currentState?:string;rtsValue?:number|null;lastUpdatedAt?:string;rtsAgeDays?:number};
export type RtsLevel='station'|'associate'|'shipment';
export const rtsMoney=(n:number)=>n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
export function rtsTotals(rows:RtsRow[]){return rows.reduce((a,r)=>({count:a.count+1,value:a.value+(r.rtsValue??0),missing:a.missing+(r.rtsValue==null?1:0),oldest:Math.max(a.oldest,r.rtsAgeDays||0),cash:a.cash+(r.status==='Cash / closure pending'?1:0)}),{count:0,value:0,missing:0,oldest:0,cash:0});}
export function rtsTable(rows:RtsRow[],level:RtsLevel):BoardShareTable {
 const cell=(text:string,bold=false):BoardShareCell=>({text,bold,align:'left'});
 const number=(n:number):BoardShareCell=>({text:String(n),align:'right'});
 if(level==='shipment')return {title:'RTS pendency · Shipments',subtitle:'',headers:['Station',"DA's Name",'Shipment ID','Status','Value ₹','Age days','Last update (IST)'],rows:rows.map(r=>[cell(r.stationCode),cell(r.driverName||r.driverId||'Unassigned'),cell(r.trackingId),cell(r.status),{text:r.rtsValue==null?'—':rtsMoney(r.rtsValue),align:'right'},r.rtsAgeDays==null?cell('—'):number(r.rtsAgeDays),cell(r.lastUpdatedAt?new Date(r.lastUpdatedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:false}):'Unknown')])};
 const groups=new Map<string,RtsRow[]>();
 for(const row of rows){const key=level==='station'?row.stationCode:`${row.stationCode}\t${row.driverId||row.driverName||'Unassigned'}`;groups.set(key,[...(groups.get(key)||[]),row]);}
 const metrics=(items:RtsRow[])=>{const t=rtsTotals(items);return [number(t.count),number(t.cash),{text:rtsMoney(t.value),align:'right' as const,bold:true},number(t.missing),number(t.oldest)];};
 const body=[...groups.values()].map(items=>[cell(items[0].stationCode,true),...(level==='associate'?[cell(items[0].driverName||items[0].driverId||'Unassigned'),cell(items[0].driverId||'—')]:[]),...metrics(items)]);
 if(rows.length)body.push([cell('Grand Total',true),...(level==='associate'?[cell(''),cell('')]:[]),...metrics(rows)]);
 return {title:`RTS pendency · ${level==='station'?'Stations':'Associates'}`,subtitle:'',headers:['Station',...(level==='associate'?["DA's Name",'DA ID']:[]),'Pending','Cash / closure','Total value ₹','Value missing','Oldest days'],rows:body};
}
