/** Live pace is an operational guide, not an end-of-day pass/fail score. */
export type DsrPacePoint = { time: string; target: number };
export const DEFAULT_DSR_PACE: DsrPacePoint[] = [
  {time:'08:00',target:0},{time:'10:30',target:25},{time:'12:00',target:40},
  {time:'14:00',target:55},{time:'16:00',target:70},{time:'18:00',target:85},
  {time:'20:00',target:95},{time:'22:00',target:98},
];
const minute = (time:string) => Number(time.slice(0,2))*60+Number(time.slice(3));
export function parseDsrPace(text:string):DsrPacePoint[] {
  const points=text.split(',').filter(x=>x.trim()).map(part=>{
    const match=/^\s*([0-2]\d:[0-5]\d)\s*=\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(part);
    if(!match || Number(match[1].slice(0,2))>23 || Number(match[2])>100)throw new Error('Use pace targets such as 10:30=25, 14:00=55.');
    return {time:match[1],target:Number(match[2])};
  }).sort((a,b)=>minute(a.time)-minute(b.time));
  if(points.length<2 || points.length>24 || points.some((p,i)=>i>0&&(p.time===points[i-1].time||p.target<points[i-1].target)))throw new Error('Set 2–24 increasing time targets with non-decreasing percentages.');
  return points;
}
export function dsrPaceTarget(asOf:string,points:readonly DsrPacePoint[]):number|null {
  const stamp=Date.parse(asOf);
  if(!Number.isFinite(stamp)||points.length<2)return null;
  const clock=new Date(stamp+330*60000).toISOString().slice(11,16),now=minute(clock);
  if(now<=minute(points[0].time))return points[0].target;
  for(let i=1;i<points.length;i++)if(now<=minute(points[i].time)){
    const a=points[i-1],b=points[i];return a.target+(b.target-a.target)*(now-minute(a.time))/(minute(b.time)-minute(a.time));
  }
  return points.at(-1)!.target;
}
export function liveDsrStyle(value:string|number,target:number|null) {
  const pct=Number.parseFloat(String(value));
  if(!Number.isFinite(pct)||target===null)return null;
  if(target<=0)return {background:'#eff6ff',color:'#1e40af'};
  if(pct>=target)return {background:'#bbf7d0',color:'#14532d'};
  if(pct>=target*.7)return {background:'#fef3c7',color:'#92400e'};
  return {background:'#fecaca',color:'#991b1b'};
}
