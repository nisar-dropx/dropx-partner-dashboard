import { getAuthorization,hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { loadReviewCod } from "@/lib/ops-pulse/review-cod-data";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic="force-dynamic";
export const maxDuration=60;
export async function GET(request:Request) {
  const auth=await getAuthorization();
  if(!auth||!hasPermission(auth,"performance_review","access"))return Response.json({error:"Review access denied."},{status:403});
  const url=new URL(request.url);
  const station=url.searchParams.get("station")||"",batch=url.searchParams.get("batch")||"";
  if(!/^[A-Z0-9]{2,16}$/.test(station)||!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(batch))return Response.json({error:"Select one station and a valid report."},{status:400});
  const companyId=requireCompanyId(auth);
  const scope=await loadCodLocations(companyId,auth.locationScopeIds,auth.hasAllLocationAccess);
  if(scope.error)return Response.json({error:"Station access could not be verified."},{status:503});
  if(!scope.locations.some(location=>location.station_code===station))return Response.json({error:"You do not have access to this station."},{status:403});
  const {snapshot,lines}=await loadReviewCod(companyId,station,batch);
  if(snapshot.error||!snapshot.summary)return Response.json({error:snapshot.error||"Report unavailable."},{status:503});
  if(url.searchParams.get("format")!=="xlsx")return Response.json({snapshot,lines},{headers:{"Cache-Control":"no-store"}});
  const associates=new Map<string,{name:string;id:string;amount:number;overdue:number;tids:Set<string>}>();
  for(const line of lines){const key=`${line.associateId}|${line.associate}`;const entry=associates.get(key)||{name:line.associate,id:line.associateId,amount:0,overdue:0,tids:new Set<string>()};entry.amount+=Math.round(line.amount*100);if(line.overdue)entry.overdue+=Math.round(line.amount*100);if(line.trackingId)entry.tids.add(line.trackingId);associates.set(key,entry);}
  return workbookResponse([
    {name:"Summary",rows:[{Station:station,"Snapshot imported":snapshot.importedAt,"Source file":snapshot.fileName,"Total pending":snapshot.summary.total,"Over 2 days":snapshot.summary.overdueAmount,"Tracking IDs":snapshot.summary.tidCount,"Source lines":snapshot.summary.lineCount,"Report batch":snapshot.batchId,"Basis":"Latest imported outstanding position, not historical review-day balance. Age bands as supplied by Amazon. Repeated TIDs retain all source order lines."}]},
    {name:"Ageing",rows:snapshot.summary.buckets.map(group=>({Station:station,Age:group.label,"Pending amount":group.amount,"Source lines":group.lines,"Over 2 days":group.overdue?"Yes":"No"}))},
    {name:"Day-wise",rows:snapshot.summary.days.map(group=>({Station:station,"Cash date":group.label,"Pending amount":group.amount,"Source lines":group.lines}))},
    {name:"DA-wise",rows:[...associates.values()].map(row=>({Station:station,Associate:row.name,"Associate ID":row.id,"Pending amount":row.amount/100,"Over 2 days":row.overdue/100,"Tracking IDs":row.tids.size}))},
    {name:"TID detail",rows:lines.map(line=>({Station:station,"Source row":line.rowNumber,"Tracking ID":line.trackingId,"Order ID":line.orderId,Associate:line.associate,"Associate ID":line.associateId,"Cash date":line.pendingDate,"Source age":line.bucket,Status:line.status,"Pending amount":line.amount,"Over 2 days":line.overdue?"Yes":"No"}))}
  ],`cod-pending-${station}-${snapshot.importedAt?.slice(0,10)}.xlsx`);
}
