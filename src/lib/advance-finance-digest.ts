import type { SupabaseClient } from "@supabase/supabase-js";
import type { DigestBuilder } from "./portal-digest-delivery";
import { advanceFinanceCutoff, advanceFinanceMessages, type AdvanceFinanceRow } from "./advance-finance-digest-model";

export async function loadAdvanceFinanceQueue(db: SupabaseClient,companyId:string,date:string) {
  const rows: AdvanceFinanceRow[]=[];
  for (let start=0;;start+=500) {
    const result=await db.from("hr_advance_finance_mail_queue").select("*").eq("company_id",companyId)
      .lte("available_at",advanceFinanceCutoff(date)).order("request_id").range(start,start+499);
    if(result.error)throw Error(result.error.message);
    rows.push(...(result.data??[]) as AdvanceFinanceRow[]);
    if((result.data??[]).length<500)break;
  }
  return rows;
}
export const buildAdvanceFinanceDigest:DigestBuilder=async(db,control,date)=>({
  checkedAt:new Date().toISOString(),
  messages:advanceFinanceMessages(await loadAdvanceFinanceQueue(db,control.company_id,date),control.company_id,date,
    String(control.config.email_domain||""),control.subject_template||"Advance requests · Finance queue")
});

/** Rebuild the saved edition before SMTP: never email reassigned or completed
 * requests, and never add new post-snapshot requests to a leased edition. */
export async function refreshAdvanceFinanceDelivery(db:SupabaseClient,companyId:string,date:string,email:string,scope:unknown,domain:string,subject:string) {
  const ids=(scope as {requestIds?:unknown})?.requestIds;
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=="string"))throw Error("Invalid saved advance queue scope");
  const rows=(await loadAdvanceFinanceQueue(db,companyId,date)).filter(r=>ids.includes(r.request_id)&&r.recipient_email===email);
  return advanceFinanceMessages(rows,companyId,date,domain,subject).find(m=>m.email===email)??null;
}
