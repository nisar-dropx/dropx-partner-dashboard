import {cronAuthorized,digestDatabase,processPortalDigests,type DigestControl} from "@/lib/portal-digest-delivery";
import {buildAdvanceFinanceDigest} from "@/lib/advance-finance-digest";
import {ADVANCE_FINANCE_EVENT} from "@/lib/advance-finance-digest-model";
import {isEddCronHost} from "@/lib/ops-pulse/edd-cron-scope";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
export async function GET(request:Request) {
 if(!cronAuthorized(request))return Response.json({error:"Unauthorized"},{status:401});
 if(!isEddCronHost(new URL(request.url).hostname))return Response.json({skipped:"Ops Pulse only"});
 try {
  if(new URL(request.url).searchParams.get("preview")==="1") {
   const db=digestDatabase(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata"}).format(new Date());
   const controls=await db.from("portal_notification_controls").select("*").eq("portal","ops").eq("event_key",ADVANCE_FINANCE_EVENT);
   if(controls.error)throw Error(controls.error.message);
   const companies=[];
   for(const control of (controls.data??[]) as DigestControl[]){
    const preview=await buildAdvanceFinanceDigest(db,control,date);
    companies.push({companyId:control.company_id,schedule:control.config.schedule_time,timezone:control.config.timezone,enabled:control.state==="enabled"&&control.config.delivery_ready===true,
     recipients:preview.messages.length,requests:preview.messages.reduce((total,m)=>total+(m.scope.requestIds as string[]).length,0),cutoff:preview.messages[0]?.scope.cutoff??null});
   }
   return Response.json({version:1,preview:true,date,companies});
  }
  const result=await processPortalDigests("ops",ADVANCE_FINANCE_EVENT,buildAdvanceFinanceDigest);
  return Response.json({version:1,...result},{status:result.errors.length?500:200});
 }catch(error){console.error("Advance finance digest failed",error instanceof Error?error.message:"Unknown error");return Response.json({error:"Advance finance queue could not be prepared"},{status:500});}
}
