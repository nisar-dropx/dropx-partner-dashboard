import type { FleetControlData, FleetVehicleDailyKm } from '../fleet-control';
export type GpsExceptionReview = {vehicleNo:string;date:string;reason:string;remarks:string;reviewedBy:string;reviewedAt:string};
export const gpsReviewReasons:Record<string,string>={authorised_work:'Authorised delivery / business work',driver_follow_up:'Discussed with driver / action recorded',gps_inaccuracy:'GPS reading investigated',other:'Other explanation'};
export const gpsExceptionKey=(vehicle:string,date:string)=>`${vehicle.toUpperCase()}|${date}`;
export function gpsExceptions(data:Pick<FleetControlData,'dailyKm'|'gpsExceptionReviews'>,from:string,to:string,filter='open') {
 const reviews=new Map((data.gpsExceptionReviews||[]).map(r=>[gpsExceptionKey(r.vehicleNo,r.date),r]));
 const unique=new Map<string,FleetVehicleDailyKm>();
 for(const row of data.dailyKm)if(row.lateNight&&row.date>=from&&row.date<=to)unique.set(gpsExceptionKey(row.vehicleNo,row.date),row);
 return [...unique.values()].map(row=>({...row,review:reviews.get(gpsExceptionKey(row.vehicleNo,row.date))})).filter(row=>filter==='all'||(filter==='acknowledged'?!!row.review:!row.review)).sort((a,b)=>b.date.localeCompare(a.date)||a.vehicleNo.localeCompare(b.vehicleNo));
}
export function isOwnedVehicle(vehicle:{ownershipType?:string|null}) {return vehicle.ownershipType==='own';}
