import 'server-only';
import {fetchLoadFlashBoard,fetchLoadFlashTracking,queueLoadFlashStations} from '@/lib/ops-pulse/edd-worker';
import {requireReportFreshness} from './lm-live-report';
import {highValueCaption,highValueStatus,highValueSummary,pendingHighValue} from './lm-high-value';
import {tableReportSvg,reportPngBase64} from './lm-report-image';
export async function highValueOutputs(codes:string[],day:string,slot:string,regional:boolean,threshold=5000,mentions:string[]=[]){
 const network=await fetchLoadFlashBoard(day,codes);
 const stations=network.stations.filter(s=>codes.includes(s.stationCode)&&s.businessDate===day&&s.hasSnapshot);
 const stale=codes.filter(code=>{const s=stations.find(s=>s.stationCode===code);try{requireReportFreshness(s?.fetchedAt||null,day,5);return s?.board.highValueVersion!==1;}catch{return true;}});
 if(stale.length){await queueLoadFlashStations(stale,5);throw new Error('Waiting for high-value source refresh: '+stale.join(', '));}
 const raw=await fetchLoadFlashTracking(day,codes,{buckets:['BoardHighValue']});
 const rows=pendingHighValue(raw.filter(r=>codes.includes(r.stationCode)),threshold);
 if(!rows.length)return {outputs:[],rows,asOf:stations.map(s=>s.fetchedAt!).sort()[0]};
 const asOf=stations.map(s=>s.fetchedAt!).sort()[0];
 const stamp=new Date(asOf).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
 const title=`High value > ₹${threshold.toLocaleString('en-IN')} · ${regional?'Regional pending':codes.join(', ')} · ${stamp}`;
 const columns=regional?['Station','At station','Held','On road','Attempted','Check','Pending','Value ₹']:['Tracking ID','Value ₹','Payment','Status','Associate','EDD'];
 const values=regional?highValueSummary(rows):rows.map(r=>[...(codes.length>1?[r.stationCode]:[]),r.trackingId,r.shipmentValue!,r.paymentMethod||'—',highValueStatus(r.state),['Out on road','Attempted'].includes(highValueStatus(r.state))?(r.driverName||r.driverId||'Unmapped'):'—',r.edd||'—']);
 if(!regional&&codes.length>1)columns.unshift('Station');
 const caption=`*${title}*\n${mentions.map(n=>'@'+n).join(' ')}\n${highValueCaption(slot)}`.replace(/\n\n/g,'\n');
 const outputs=[];
 // Keep text legible instead of scaling hundreds of TIDs into one long snap.
 for(let offset=0;offset<values.length;offset+=25){
  const page=values.slice(offset,offset+25),part=values.length>25?` · ${Math.floor(offset/25)+1}/${Math.ceil(values.length/25)}`:'';
  outputs.push({key:`high_value_photo_${offset/25+1}`,liveAsOf:asOf,body:{image_base64:await reportPngBase64(await tableReportSvg(title+part,columns,page,[],()=>null)),mime:'image/png',caption:offset===0?caption:`*${title}${part}*`,mentions}});
 }
 return {outputs,rows,asOf};
}
