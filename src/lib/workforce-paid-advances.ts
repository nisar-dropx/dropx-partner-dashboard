import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";

import { fitWorkforceAdvances, type Row, type Prior } from "./workforce-paid-advances-allocation";

export async function applyWorkforcePaidAdvances<R extends Row>(companyId: string, start: string, end: string, rows: R[]) {
  if (!supabaseAdmin) throw new Error("Database connection is unavailable.");
  const due = await readAllRows(supabaseAdmin.rpc("pay_advance_period_due",{ p_company:companyId,p_period:start,p_target:"workforce",p_run:null }).order("advance_id"));
  if (due.error) throw new Error("Paid advances could not be verified. Payout was not calculated.");
  if (!due.data?.length) return rows;
  const [payments, publications] = await Promise.all([
    readAllRows(supabaseAdmin.from("workforce_payout_payment_items").select("id,workforce_id,status,instruction_amount")
      .eq("company_id",companyId).eq("period_start",start).eq("period_end",end).in("status",["paid","processing"]).order("id")),
    readAllRows(supabaseAdmin.from("workforce_payout_publications").select("id,workforce_id,station_id,revision,snapshot")
      .eq("company_id",companyId).eq("period_start",start).eq("period_end",end).eq("publication_kind","worksheet").order("revision",{ascending:false}).order("id")),
  ]);
  if (payments.error || publications.error) throw new Error("Advance recovery could not verify payout history.");
  const seen=new Set<string>(), prior: Prior[]=[];
  for (const p of publications.data ?? []) {
    const key=`${p.workforce_id}:${p.station_id}`; if(seen.has(key)) continue; seen.add(key);
    for(const line of (p.snapshot as any)?.worksheet?.deduction_breakdown ?? []) {
      if(line.code==='ADVANCE_RECOVERY' && String(line.recoveryKey).startsWith('ADVANCE:'))
        prior.push({workforce_id:p.workforce_id,station_id:p.station_id,advance_id:String(line.recoveryKey).slice(8),amount:Number(line.amount)});
    }
  }
  return fitWorkforceAdvances(rows,due.data,payments.data ?? [],prior);
}
