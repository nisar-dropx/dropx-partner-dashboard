import { createHmac, timingSafeEqual } from "node:crypto";
import { loadPayAdvanceCapacity } from "@/lib/pay-advance-capacity";
import { supabaseAdmin } from "@/lib/supabase-admin";

// Called only by OneApp after it has resolved the actor's assigned/oversight steps.
export async function POST(request: Request) {
  const secret=process.env.SUPABASE_SERVICE_ROLE_KEY;
  const timestamp=request.headers.get("x-dropx-time")??"";
  const signature=request.headers.get("x-dropx-signature")??"";
  const body=await request.text();
  if(!secret || !supabaseAdmin || body.length>2000 || !/^\d+$/.test(timestamp)
    || Math.abs(Date.now()-Number(timestamp))>60_000 || !/^[a-f0-9]{64}$/.test(signature))
    return Response.json({error:"Unauthorized"},{status:401});
  const expected=createHmac("sha256",secret).update(`dropx:advance-context:v1.${timestamp}.${body}`).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,"hex"))) return Response.json({error:"Unauthorized"},{status:401});
  try {
    const {companyId,requestId}=JSON.parse(body);
    const r=await supabaseAdmin.from("hr_pay_advance_requests").select("worker_type,worker_id")
      .eq("company_id",companyId).eq("id",requestId).single();
    if(r.error || !["employee","contractor","workforce"].includes(r.data?.worker_type)) throw new Error("Advance request not found.");
    const capacity=await loadPayAdvanceCapacity({companyId,accountId:r.data.worker_id,
      profileType:r.data.worker_type,excludeRequestId:requestId});
    return Response.json(capacity,{headers:{"Cache-Control":"private, no-store"}});
  } catch {return Response.json({error:"Current advance capacity could not be verified."},{status:503});}
}
