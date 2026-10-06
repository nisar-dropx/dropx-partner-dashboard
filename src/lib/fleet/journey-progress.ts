import type {MovementEvent,MovementProgressPoint} from '../wheelseye-history';
export const locationLink=(lat:number,lng:number)=>`https://www.google.com/maps?q=${lat},${lng}`;
export const traceTime=(at:string)=>new Date(at).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit'});
/** Keep real sample timestamps. Bins select their final sample, never fabricate a position. */
export function sampleProgress(points:MovementProgressPoint[],minutes:number){
 if(!minutes)return points;
 const bins=new Map<number,MovementProgressPoint>();
 for(const p of points)bins.set(Math.floor(Date.parse(p.at)/(minutes*60000)),p);
 const samples=[...bins.values()];if(points.length&&samples[0]!==points[0])samples.unshift(points[0]);
 let previous=0,lastAt=-Infinity,cursor=0;
 return samples.map(p=>{
  let gap=false;
  while(cursor<points.length&&Date.parse(points[cursor].at)<=Date.parse(p.at)){if(Date.parse(points[cursor].at)>lastAt&&points[cursor].gapBefore)gap=true;cursor++;}
  const added=p.cumulativeKm-previous;previous=p.cumulativeKm;lastAt=Date.parse(p.at);
  return {...p,addedKm:gap&&added===0?null:Math.max(0,Number(added.toFixed(3))),gapBefore:gap};
 });
}
export function journeyOverview(events:MovementEvent[],points:MovementProgressPoint[]){
 const stops=events.filter(e=>['idle','stopped','stop_unknown'].includes(e.kind)&&e.minutes>=5);
 const longest=[...stops].sort((a,b)=>b.minutes-a.minutes)[0]??null;
 const moving=events.filter(e=>e.kind==='moving').reduce((sum,e)=>sum+e.minutes,0);
 const km=points.at(-1)?.cumulativeKm??0;
 // Only accepted moving legs wholly inside the existing 22:00–05:00 IST window are attributed.
 const afterHours=points.filter(p=>p.afterHours&&p.distanceFrom&&(()=>{const h=new Date(Date.parse(p.distanceFrom!)+19800000).getUTCHours();return h>=22||h<5;})());
 return {longest,stops:stops.length,movingMinutes:moving,averageMovingSpeed:moving>0?km/(moving/60):null,
  afterHoursKm:afterHours.reduce((sum,p)=>sum+(p.addedKm??0),0),afterHoursPoints:points.filter(p=>p.afterHours&&(p.speed??0)>0).length,
  gapCount:events.filter(e=>e.kind==='gap').length};
}
/** Pick a real GPS sample within a touch-sized screen radius; repeated visits remain selectable. */
export function nearestTracePoints(points:Array<{x:number;y:number}>,x:number,y:number,radius=22){
 let min=Infinity;const distances=points.map(p=>{const d=Math.hypot(p.x-x,p.y-y);min=Math.min(min,d);return d;});
 if(min>radius)return [];
 return distances.flatMap((d,i)=>d<=Math.min(radius,min+2)?[i]:[]).sort((a,b)=>distances[a]-distances[b]||a-b);
}
