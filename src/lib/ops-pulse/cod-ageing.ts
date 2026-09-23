import type {ReviewCodLine} from './review-cod';
export const ageingBands=['2 DAYS','3-4 DAYS','5-7 DAYS','8-15 DAYS','16-90 DAYS','Other / older'] as const;
export type AgeingStation={stationCode:string;bands:Record<string,number>;total:number;overTwo:number;recent:number;lines:ReviewCodLine[]};
export type CodAgeingSnapshot={uploadDate:string;dataDate:string;batchId:string|null;importedAt:string|null;fileName:string|null;error:string|null;stations:AgeingStation[]};
export function previousCodDate(date:string){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);}
export function buildAgeingStation(stationCode:string,lines:ReviewCodLine[],dataDate:string):AgeingStation{
 const bands:Record<string,number>=Object.fromEntries(ageingBands.map(b=>[b,0]));let recent=0,overTwo=0;
 for(const line of lines){const cents=Math.round(line.amount*100);const bucket=line.bucket.trim().toUpperCase().replace(/[–—]/g,'-');
  const match=bucket.match(/^(\d+)(?:\s*-\s*(\d+)|(\+))?\s*DAYS?$/);const min=match?Number(match[1]):null;
  if(min!==null&&min<2){recent+=cents;continue;}
  const band=ageingBands.includes(bucket as typeof ageingBands[number])?bucket:'Other / older';bands[band]+=cents;
  const age=(Date.parse(dataDate+'T00:00:00Z')-Date.parse(line.pendingDate+'T00:00:00Z'))/86400000;
  // Exactly two days is visible but not a >2-day alert; unknown bands require dated evidence.
  if((min!==null&&min>2)||(min===null&&Number.isFinite(age)&&age>2))overTwo+=cents;
 }
 return {stationCode,bands:Object.fromEntries(Object.entries(bands).map(([k,v])=>[k,v/100])),total:Object.values(bands).reduce((a,b)=>a+b,0)/100,overTwo:overTwo/100,recent:recent/100,lines};
}

export function codAgeingCsv(source:CodAgeingSnapshot,detail?:string){
 const cell=(v:unknown)=>{const raw=String(v??'');return '"'+(/^[\s]*[=+@-]/.test(raw)?"'"+raw:raw).replace(/"/g,'""')+'"';};
 const rows=detail?source.stations.filter(s=>s.stationCode===detail):source.stations.filter(s=>s.total>0);
 const data:unknown[][]=detail?[
 ['Upload date','Data as of','Imported at','Batch ID','Station','Tracking ID','Associate','Pending since','Original age band','Amount INR'],
 ...rows.flatMap(s=>s.lines.map(l=>[source.uploadDate,source.dataDate,source.importedAt,source.batchId,s.stationCode,l.trackingId,l.associate,l.pendingDate,l.bucket,l.amount]))
 ]:[['Upload date','Data as of','Imported at','Batch ID','Station',...ageingBands,'Grand total INR','Greater than 2 days INR','0-1 days (excluded) INR'],
 ...rows.map(s=>[source.uploadDate,source.dataDate,source.importedAt,source.batchId,s.stationCode,...ageingBands.map(b=>s.bands[b]),s.total,s.overTwo,s.recent]),
 [source.uploadDate,source.dataDate,source.importedAt,source.batchId,'Grand total',...ageingBands.map(b=>rows.reduce((n,s)=>n+s.bands[b],0)),rows.reduce((n,s)=>n+s.total,0),rows.reduce((n,s)=>n+s.overTwo,0),rows.reduce((n,s)=>n+s.recent,0)]];
 return '\uFEFF'+data.map(r=>r.map(cell).join(',')).join('\r\n');
}
