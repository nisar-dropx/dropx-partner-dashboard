export type FleetGpsPolicy = {afterHoursStart:string;afterHoursEnd:string;minimumStopMinutes:number;exceptionMinSpeedKph:number};
export const defaultGpsPolicy:FleetGpsPolicy={afterHoursStart:'22:00',afterHoursEnd:'05:00',minimumStopMinutes:5,exceptionMinSpeedKph:0};
const clock=(v:unknown)=>typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export function normalizeGpsPolicy(value:unknown):FleetGpsPolicy {
 const v=(value&&typeof value==='object'?value:{}) as Record<string,unknown>;
 const bounded=(key:string,fallback:number,min:number,max:number)=>v[key]!=null&&Number.isFinite(Number(v[key]))&&Number(v[key])>=min&&Number(v[key])<=max?Number(v[key]):fallback;
 const start=clock(v.afterHoursStart)?String(v.afterHoursStart):defaultGpsPolicy.afterHoursStart;
 const end=clock(v.afterHoursEnd)?String(v.afterHoursEnd):defaultGpsPolicy.afterHoursEnd;
 return {afterHoursStart:start===end?defaultGpsPolicy.afterHoursStart:start,afterHoursEnd:start===end?defaultGpsPolicy.afterHoursEnd:end,minimumStopMinutes:bounded('minimumStopMinutes',5,1,120),exceptionMinSpeedKph:bounded('exceptionMinSpeedKph',0,0,60)};
}
export function validateGpsPolicy(value:unknown) {
 const v=value as FleetGpsPolicy;
 if(!v||!clock(v.afterHoursStart)||!clock(v.afterHoursEnd)||v.afterHoursStart===v.afterHoursEnd)throw new Error('Choose two different, valid after-hours times.');
 if(!Number.isFinite(v.minimumStopMinutes)||v.minimumStopMinutes<1||v.minimumStopMinutes>120)throw new Error('Minimum stop must be 1–120 minutes.');
 if(!Number.isFinite(v.exceptionMinSpeedKph)||v.exceptionMinSpeedKph<0||v.exceptionMinSpeedKph>60)throw new Error('Exception speed threshold must be 0–60 km/h.');
 return normalizeGpsPolicy(v);
}
export function isAfterHours(epoch:number,policy:FleetGpsPolicy=defaultGpsPolicy) {
 const minute=((Math.floor(epoch/60)+330)%1440+1440)%1440;
 const parse=(clock:string)=>Number(clock.slice(0,2))*60+Number(clock.slice(3));
 const start=parse(policy.afterHoursStart),end=parse(policy.afterHoursEnd);
 return start>end?minute>=start||minute<end:minute>=start&&minute<end;
}
export const gpsPolicyLabel=(policy:FleetGpsPolicy=defaultGpsPolicy)=>`${policy.afterHoursStart}–${policy.afterHoursEnd} IST`;
