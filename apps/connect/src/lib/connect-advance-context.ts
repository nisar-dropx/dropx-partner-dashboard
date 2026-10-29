import "server-only";
import {createHmac} from "node:crypto";

export type CurrentAdvanceCapacity = {
  outstandingPay: number; maxEligibleAmount: number; committedAdvance: number;
  eligibilityPercent: number; breakdown: Array<{ month: string; outstanding: number }>;
};

export async function loadCurrentAdvanceCapacity(companyId:string,requestId:string): Promise<CurrentAdvanceCapacity> {
  const secret=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!secret) throw new Error("Current advance capacity is unavailable.");
  const body=JSON.stringify({companyId,requestId}),timestamp=String(Date.now());
  const signature=createHmac("sha256",secret).update(`dropx:advance-context:v1.${timestamp}.${body}`).digest("hex");
  const response=await fetch(new URL("/api/internal/advance-context",process.env.DASHBOARD_URL||"https://dashboard.dropxlogistics.com"),{
    method:"POST",body,headers:{"content-type":"application/json","x-dropx-time":timestamp,"x-dropx-signature":signature},
    cache:"no-store",redirect:"error",signal:AbortSignal.timeout(30_000)
  });
  const value=await response.json();
  if(!response.ok || !Number.isFinite(value.outstandingPay) || !Number.isFinite(value.maxEligibleAmount))
    throw new Error("The current outstanding pay could not be verified. Please retry.");
  return value;
}
