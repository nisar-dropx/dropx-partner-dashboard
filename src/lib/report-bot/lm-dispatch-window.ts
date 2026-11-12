/** Retry only the current slot. Never replay an older slot over a newer report. */
export function dispatchSlotDue(day:string,slot:string,slots:string[],report:string,now:number){
 const due=Date.parse(`${day}T${slot}:00+05:30`);
 const windowMinutes=['dsr','creturn','eod','ageing','high_value'].includes(report)?30:20;
 const next=slots.map(s=>Date.parse(`${day}T${s}:00+05:30`)).filter(t=>t>due).sort((a,b)=>a-b)[0]??Infinity;
 return now>=due&&now<Math.min(due+windowMinutes*60000,next);
}
export function dispatchSlotUpcoming(day:string,slot:string,now:number){
 const due=Date.parse(`${day}T${slot}:00+05:30`);
 return due>now&&due-now<=3*60000;
}
