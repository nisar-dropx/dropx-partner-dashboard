export type OperatingSchedule = {id:string;operating_pincode:string;weekly_off_day:number;effective_from:string;effective_to:string|null};

export function indiaScheduleToday(now=new Date()) {
 return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
export function scheduleWeekStart(value:string) {
 const date=new Date(`${value}T00:00:00Z`);
 date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
 return date.toISOString().slice(0,10);
}
export function workforceOperatingDays(assignments:OperatingSchedule[],start:string,count:number){
 return Array.from({length:count},(_,offset)=>{
  const day=new Date(`${start}T00:00:00Z`);day.setUTCDate(day.getUTCDate()+offset);
  const date=day.toISOString().slice(0,10);
  const matches=assignments.filter(item=>item.effective_from<=date&&(!item.effective_to||item.effective_to>=date));
  if(matches.length>1)throw new Error('Your operating schedule has conflicting versions. Ask Workforce to review it.');
  const assignment=matches[0];if(!assignment)return null;
  return {id:`workforce:${assignment.id}:${date}`,date,
   dayType:day.getUTCDay()===Number(assignment.weekly_off_day)?'weekly_off' as const:'working' as const,
   operatingPincode:assignment.operating_pincode,locationId:null,shift:null,
   isProjected:date>start,canSwap:false,partners:[]};
 }).filter((day):day is NonNullable<typeof day>=>day!==null);
}
