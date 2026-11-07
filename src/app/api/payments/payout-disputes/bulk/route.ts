import {NextResponse} from "next/server";
import {performPayoutReview} from "@/lib/payout-review-actions";
import {validateBulkDisputeSelection} from "@/lib/payout-dispute-balance";
export const runtime="nodejs";
export const maxDuration=300;
export async function POST(request:Request){
 try{
  if(request.headers.get("origin")!==new URL(request.url).origin)return NextResponse.json({error:"Invalid request origin."},{status:403});
  const rows=validateBulkDisputeSelection((await request.json()).rows),results=[];
  for(const row of rows){
   const form=new FormData();Object.entries({transition:"approve_final",dispute_id:row.id,expected_version:String(row.version),evidence_digest:row.digest,evidence_reviewed:"on",loss_balance_treatment:row.treatment??"",loss_balance_reason:row.reason??"",note:"Reviewed in Finance bulk approval."}).forEach(([k,v])=>form.set(k,String(v)));
   try{const result=await performPayoutReview(form);results.push({id:row.id,ok:true,status:result.status});}
   catch(e){results.push({id:row.id,ok:false,error:e instanceof Error?e.message:"Approval failed."});}
  }
  return NextResponse.json({results},{headers:{"Cache-Control":"private, no-store"}});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Unable to review selection."},{status:400});}
}
