export function shortfallValue(expected:number,deposited:number){
 if([expected,deposited].some(n=>!Number.isFinite(n)||n<0||!Number.isSafeInteger(Math.round(n*100))))return null;
 return Math.max(0,(Math.round(expected*100)-Math.round(deposited*100))/100);
}
/** One station-wide reminder/day; carried shortages are raised BEFORE the usual pickup. */
export function shortfallReminder(depositDay:string,day:string,slot:string,pickupStart:string|null,nonPickup:boolean,leadMinutes=60){
 if(depositDay>day)return null;
 if(slot==='23:55')return null;
 if(depositDay===day)return 'first';
 if(!pickupStart||nonPickup)return null;
 const minutes=(t:string)=>/^\d{2}:\d{2}$/.test(t)&&Number(t.slice(0,2))<24&&Number(t.slice(3,5))<60?Number(t.slice(0,2))*60+Number(t.slice(3,5)):NaN;
 const start=minutes(pickupStart),current=minutes(slot);
 if(!Number.isFinite(leadMinutes)||leadMinutes<30||leadMinutes>60)return null;
 return current>=Math.max(0,start-leadMinutes)&&current<start?'before-pickup':null;
}
export const shortfallDailyKey=(day:string)=>`short-ledger:${day}`;

/** Only meaningful remaining pendency is eligible; small residuals stay in history. */
export function hasShortfallPendency(original:number,recovered:number){
 return Number.isFinite(original)&&Number.isFinite(recovered)&&original>=0&&recovered>=0&&Math.round(original*100)-Math.round(recovered*100)>1000;
}
