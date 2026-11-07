import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "./supabase-admin";
import { loadWorkforcePayoutRows } from "./workforce-payout-loader";
import { buildWorkforcePayoutPublicationSnapshot } from "./workforce-payout-publication-snapshot";
import { disputeItems, cash, disputeEvidenceValues, type DisputePricingContext } from "./payout-dispute-guide";
import type { AuthorizationContext } from "./authorization";
import { readAllRows } from "./supabase-pagination";
import { normalizePayoutIdentity, resolveShipmentPayoutMapping } from "./workforce-payout-population";

export async function loadDisputeEvidence(company: string, dispute: any, publication: any, auth: AuthorizationContext) {
  const db = supabaseAdmin!;
  const snapshot = publication.snapshot;
  const from = publication.period_start || snapshot.run.period_start;
  const to = publication.period_end || snapshot.run.period_end;
  const worker = await db.from("workforce").select("id,source_profile_id,source_profile_type").eq("company_id", company).eq("id", dispute.workforce_id).single();
  if (worker.error) throw new Error("Associate identity could not be verified.");
  const identity = [{ key: "workforce_id", id: dispute.workforce_id }];
  const source = worker.data.source_profile_type;
  if (["employee", "contractor", "field_executive"].includes(source) && worker.data.source_profile_id) identity.push({ key: `${source}_id`, id: worker.data.source_profile_id });
  const [current, policy, heads, stations, attendance] = await Promise.all([
    loadWorkforcePayoutRows(company, auth, from, to, { workforceIds: [dispute.workforce_id] }),
    db.from("workforce_payment_settings").select("calculation_method,paid_off_days,work_units_per_paid_off,cap_at_monthly_amount,effective_from").eq("company_id", company).lte("effective_from", to).order("effective_from"),
    db.from("workforce_deduction_heads").select("code,calculation_type,default_value,percentage_without_pan,applies_to_all,is_active").eq("company_id", company).eq("is_active", true),
    db.from("stations").select("id,station_code,parent_station_id").eq("company_id", company),
    Promise.all(identity.map(({ key, id }) => db.from("attendance_daily").select("id,location_id,station_code,punch_date,status,in_time,out_time,work_minutes").eq("company_id", company).eq(key, id).gte("punch_date", from).lte("punch_date", to).order("punch_date").limit(1000)))
  ]);
  if (policy.error || heads.error || stations.error || attendance.some(r => r.error)) throw new Error("Supporting records could not be loaded. Retry before validating.");
  const station = stations.data?.find(s => s.id === dispute.station_id);
  const root = station?.parent_station_id || dispute.station_id;
  const family = new Set((stations.data ?? []).filter(s => s.id === root || s.parent_station_id === root).map(s => s.id));
  const punches = [...new Map(attendance.flatMap(r => r.data ?? []).map(r => [r.id, r])).values()].map(p => ({ ...p, linked: family.has(p.location_id) })).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const currentRows = current.rows.filter(r => r.reviewSubjectId === dispute.workforce_id && r.locationId === dispute.station_id);
  const currentSnapshot = currentRows.length === 1 ? buildWorkforcePayoutPublicationSnapshot(currentRows[0], from, to, "dispute-evidence") : null;
  // Read all effective mappings at this station, including competing assignments.
  // A matching name or an ID mapped elsewhere in the month is not proof for this day.
  const mappingResult = await readAllRows(db.from("field_executive_provider_mappings")
    .select("id,provider_member_id,workforce_id,employee_id,contractor_id,field_executive_id,payment_method_id,effective_from,effective_to,status,providers(name,code)")
    .eq("company_id",company).eq("station_id",dispute.station_id).in("status",["active","closed"])
    .lte("effective_from",to).or(`effective_to.is.null,effective_to.gte.${from}`).order("id"));
  if (mappingResult.error) throw new Error("Dated ID mappings could not be checked.");
  const owns = (m:any) => identity.some(({key,id})=>m[key]===id);
  const mapped = (mappingResult.data??[]).map((m:any)=>({id:m.id,providerMemberId:m.provider_member_id,stationCode:station?.station_code||"",providerIdentity:`${m.providers?.name||""} ${m.providers?.code||""}`,effectiveFrom:m.effective_from,effectiveTo:m.effective_to,workforceId:owns(m)?dispute.workforce_id:(m.workforce_id||m.employee_id||m.contractor_id||m.field_executive_id||""),paymentMethodId:m.payment_method_id||""}));
  const mappings = mapped.filter(m=>m.workforceId===dispute.workforce_id);
  const shipmentResult = mappings.length && station?.station_code ? await readAllRows(db.from("cps_shipment_daily")
    .select("id,provider_employee_id,client,work_date,station_code,total_delivery,c_return,mfn,mfn_return,updated_at")
    .eq("company_id",company).eq("station_code",station.station_code).gte("work_date",from).lte("work_date",to).order("id")) : {data:[],error:null};
  if(shipmentResult.error) throw new Error("Imported delivery evidence could not be checked.");
  const ownIds=new Set(mappings.map(m=>normalizePayoutIdentity(m.providerMemberId)));
  const deliveries=(shipmentResult.data??[]).filter(r=>ownIds.has(normalizePayoutIdentity(r.provider_employee_id))).flatMap(r=>{
    const match=resolveShipmentPayoutMapping(r,mapped);
    if(match.kind==="mapped" && match.workforceId!==dispute.workforce_id)return [];
    return [{...r,mappingStatus:match.kind}];
  });
  const deductions = disputeItems(snapshot).filter(i => i.kind === "deduction");
  const refs=[...new Set(deductions.flatMap(d=>d.recoveryKey?[d.recoveryKey.split("|")[2]]:[]).filter(Boolean))];
  const [losses,manual,advances,additions]=await Promise.all([
    Promise.all(refs.map(ref=>db.rpc("nl_recovery_ledger",{p_company:company,p_from_month:null,p_ref:ref}))),
    db.from("workforce_payout_deduction_values").select("id,head_code_snapshot,head_name_snapshot,amount,source_type,created_at,updated_at,created_by").eq("company_id",company).eq("workforce_id",dispute.workforce_id).eq("station_id",dispute.station_id).eq("effective_from",from).eq("effective_to",to),
    deductions.some(d=>/ADVANCE/i.test(d.code))?db.from("workforce_advances").select("id,advance_number,advance_date,amount,opening_deducted_amount,remark,created_at").eq("company_id",company).eq("workforce_id",dispute.workforce_id).eq("station_id",dispute.station_id).lte("advance_date",to).order("advance_date",{ascending:false}).limit(100):Promise.resolve({data:[],error:null}),
    db.from("workforce_additional_payment_values").select("id,field_code_snapshot,field_name_snapshot,final_amount,input_value,rate_value,source_type,created_at,updated_at").eq("company_id",company).eq("workforce_id",dispute.workforce_id).eq("station_id",dispute.station_id).eq("effective_from",from).eq("effective_to",to)
  ]);
  const sourceDetails={losses:losses.flatMap(r=>r.data??[]).filter((r:any)=>deductions.some(d=>d.recoveryKey?.startsWith(`${r.month}|${r.case_key}|`))),manual:manual.data??[],advances:advances.data??[],additions:additions.data??[],error:losses.some(r=>r.error)||manual.error||advances.error||additions.error?"Some deduction or allowance source records could not be loaded.":null};
  const percentages: DisputePricingContext["percentageDeductions"] = [];
  let priceError = "";
  for (const head of heads.data ?? []) {
    if (head.calculation_type !== "percentage" || !head.applies_to_all) continue;
    const recorded = deductions.filter(d => d.code === head.code).reduce((n, d) => n + d.amount, 0);
    if (!recorded) { if (Number(snapshot.item.gross_amount)===0) priceError="The zero-value payout needs a source calculation to establish applicable deductions before approval."; continue; }
    const rates = [...new Set([Number(head.default_value), Number(head.percentage_without_pan)])].filter(r => Number.isFinite(r) && Math.abs(cash(Number(snapshot.item.gross_amount) * r / 100) - recorded) < 0.02);
    if (rates.length !== 1) priceError = `The ${head.code} rule differs from the published payout. Recalculate the source before approval.`;
    else percentages.push({ code: head.code, rate: rates[0] });
  }
  const data = { snapshot, currentSnapshot, punches, mappings, deliveries, sourceDetails, sourceError: current.error || sourceDetails.error || (currentRows.length !== 1 ? "Current payout could not be uniquely matched to this associate and station." : ""), pricing: { policies: policy.data ?? [], percentageDeductions: percentages, error: priceError || undefined, checkedAt: new Date().toISOString() } };
  // Only relevant financial/evidence values enter the digest, never fetch timestamps.
  const digest = createHash("sha256").update(disputeEvidenceValues({ currentSnapshot, punches, mappings, deliveries, sourceDetails, policies: policy.data, percentages, priceError, sourceError: data.sourceError })).digest("hex");
  return { ...data, digest };
}
