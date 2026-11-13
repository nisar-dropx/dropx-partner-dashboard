import 'server-only';
import {fetchLoadFlashBoard,fetchLoadFlashTracking,queueLoadFlashStations} from '@/lib/ops-pulse/edd-worker';
import {requireReportFreshness} from './lm-live-report';
import {highValuePayment} from './lm-high-value';
import {highValueClosed,highValueException,highValueExceptionCaption,highValueScanLabel,highValueHistoryRows,type HighValueEvidence} from './lm-high-value-exceptions';
import {tableReportSvg,reportPngBase64} from './lm-report-image';
import {codCacheGet,codCachePut} from './lm-cod-journeys';
import {CodRuntime} from './lm-cod-runtime';
type Context={company:string;locations:Map<string,string>;runtime:CodRuntime;minimumDays?:number;escalationTime?:string};
export async function highValueOutputs(codes:string[],day:string,slot:string,regional:boolean,threshold=5000,mentions:string[]=[],context?:Context){
 if(regional)throw new Error('High-value exception alerts are station war-room reports only');
 if(!context)throw new Error('High-value station context required');
 const network=await fetchLoadFlashBoard(day,codes);
 const stations=network.stations.filter(s=>codes.includes(s.stationCode)&&s.businessDate===day&&s.hasSnapshot);
 const stale=codes.filter(code=>{const s=stations.find(s=>s.stationCode===code);try{requireReportFreshness(s?.fetchedAt||null,day,5);return s?.board.highValueVersion!==2;}catch{return true;}});
 if(stale.length){await queueLoadFlashStations(stale,5);throw new Error('Waiting for high-value source refresh: '+stale.join(', '));}
 const raw=await fetchLoadFlashTracking(day,codes,{buckets:['BoardHighValue']});
 const candidates=[...new Map(raw.filter(r=>codes.includes(r.stationCode)&&Number.isFinite(r.shipmentValue)&&r.shipmentValue!>=threshold&&!highValueClosed(r.state)).map(r=>[r.stationCode+':'+r.trackingId,r])).values()];
 const rows=[];
 for(const row of candidates){
  const location=context.locations.get(row.stationCode);if(!location)throw new Error('Missing high-value source location');
  const key=`high-value:v1:${row.trackingId}:${row.state}:${row.lastUpdatedAt||slot}`;
  let evidence=await codCacheGet<HighValueEvidence>(context.company,location,day,key);
  if(!evidence){
   evidence=await context.runtime.external(async()=>{
    const base=process.env.EDD_WORKER_URL?.trim().replace(/\/$/,''),admin=process.env.EDD_WORKER_ADMIN_KEY;
    if(!base||!admin)throw new Error('High-value tracking source is not configured');
    const url=new URL(base+'/api/admin/executive/edd/lookup');url.searchParams.set('stationCode',row.stationCode);url.searchParams.set('trackingId',row.trackingId);
    const res=await fetch(url,{headers:{'x-admin-key':admin},signal:AbortSignal.timeout(12000),cache:'no-store'});
    if(!res.ok)throw new Error('High-value history unavailable: '+row.trackingId);
    const r=await res.json();
    if(r.status!=='ok'||r.trackingId!==row.trackingId||!r.packageStatus||!Array.isArray(r.history)||!r.history.length)throw new Error('Incomplete high-value evidence: '+row.trackingId);
    // Customer names and addresses are deliberately omitted from cache and reports.
    return {trackingId:r.trackingId,stationCode:r.stationCode,state:r.packageStatus,checkedAt:new Date().toISOString(),updatedAt:r.lastUpdatedTime||null,product:String(r.itemDescription||'').slice(0,100),history:r.history.map((h:any)=>({state:String(h.state),time:h.time,source:h.source,destination:h.destination,reasonCode:h.reasonCode}))} satisfies HighValueEvidence;
   });
   await codCachePut(context.company,location,day,key,evidence,row.lastUpdatedAt?1440:5);
  }
  const exception=highValueException(row,evidence,Date.now(),context.minimumDays||3,threshold);
  if(exception)rows.push(exception);
 }
 const asOf=stations.map(s=>s.fetchedAt!).sort()[0];
 const outputs=[];
 for(const code of codes){
  const list=rows.filter(r=>r.stationCode===code).sort((a,b)=>(b.ageDays||0)-(a.ageDays||0)||b.shipmentValue!-a.shipmentValue!);
  if(!list.length)continue;
  const title=`${code} · High-value exceptions · ${new Date(day+'T12:00:00+05:30').toLocaleDateString('en-IN',{day:'numeric',month:'short',timeZone:'Asia/Kolkata'})} · ${slot} IST`;
  const caption=[highValueExceptionCaption(code,list.length,list.reduce((n,r)=>n+r.shipmentValue!,0),slot>=(context.escalationTime||'23:00')),mentions.map(n=>'@'+n).join(' ')].filter(Boolean).join('\n');
  const clock=(at:string)=>new Date(at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  const values=list.flatMap(r=>{
   const events=highValueHistoryRows(r.history);
   return [[r.trackingId,'₹'+r.shipmentValue!.toLocaleString('en-IN'),highValuePayment(r.paymentMethod),highValueScanLabel(r.state),r.ageDays===null?'Unknown':`${r.ageDays}d`,`${r.activityDays} days`],
    ...(r.product?[[r.trackingId,'Product',r.product.length>30?r.product.slice(0,29)+'…':r.product,'','','']]:[]),
    ...(r.firstAt?[[r.trackingId,'First seen',clock(r.firstAt),'','','']]:[]),
    ...events.map(h=>[r.trackingId,'Scan',h.time?clock(h.time):'—',highValueScanLabel(h.state),h.reasonCode?.replaceAll('_',' ').slice(0,26)||'',''])];
  });
  for(let offset=0;offset<values.length;offset+=24){
   outputs.push({key:`high_value_${code}_${offset/24+1}`,liveAsOf:asOf,body:{image_base64:await reportPngBase64(await tableReportSvg(title,['Tracking ID','Value / detail','Payment / time','Current status / scan','Age / reason','Activity days'],values.slice(offset,offset+24),[],()=>null)),mime:'image/png',caption:offset===0?caption:`*${title} · continued*`,mentions:mentions.map(n=>n+'@s.whatsapp.net')}});
  }
 }
 return {outputs,rows,asOf};
}
