import { syncAdvertisingDue } from "@/lib/ops-pulse/advertising-sync";
export const dynamic="force-dynamic";
export const maxDuration=300;
export async function GET(request:Request) {
 const secret=process.env.CRON_SECRET;
 if(!secret||request.headers.get("authorization")!==`Bearer ${secret}`)return Response.json({error:"Unauthorized"},{status:401});
 // This repo has multiple product deployments; only OpsPulse owns this sync.
 const portal=process.env.NEXT_PUBLIC_PORTAL;
 if(portal!=="ops"&&portal!=="ops-pulse"&&!new URL(request.url).hostname.startsWith("dropx-ops-pulse")&&new URL(request.url).hostname!=="ops.dropxlogistics.com")return Response.json({skipped:true});
 try{return Response.json({results:await syncAdvertisingDue()});}catch{return Response.json({error:"Advertising sync unavailable"},{status:500});}
}
