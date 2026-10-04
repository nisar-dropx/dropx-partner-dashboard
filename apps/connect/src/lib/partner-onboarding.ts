/** Amazon's own background-check note uses a 7-day SLA. Older than that, the file has stopped moving. */
export const STALE_PARTNER_REPORT_DAYS = 7;

/**
 * A fresh partner report can keep a new associate on work setup until the team
 * confirms the provider ID. An associate who is already active must not stay
 * locked on a report that has not moved for longer than that SLA.
 */
export function partnerReportStillBlocksWorkspace(input: {
  accountStatus: string | null | undefined;
  mappingConfirmed: boolean;
  registrationReady: boolean;
  reportDate: string | null | undefined;
  restrictDropxOne: boolean;
  today: string;
}) {
  const locked = input.registrationReady && input.restrictDropxOne && !input.mappingConfirmed;
  if (!locked || input.accountStatus !== "Active" || !input.reportDate) return locked;
  const report = input.reportDate.slice(0, 10);
  const today = input.today.slice(0, 10);
  const ageDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${report}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(ageDays)) return true;
  return ageDays <= STALE_PARTNER_REPORT_DAYS;
}

export type PartnerOnboardingState = {
 workflow_rule_id?:string; station_id:string; reported_on:string|null; invited_on:string|null; due_kind:"invitation_due"|"progress_due"|null; due_since:string|null; transporter_id:string|null; action_item:string|null; report_date:string|null; provider_name:string;
 workforce_id:string; adapter:"amazon"|"manual"; restrict_dropx_one:boolean;
 registration_ready:boolean; mapping_confirmed:boolean; stage:string; label:string;
 instruction:string; can_trigger:boolean; invitation_status:string|null; report_updated_at:string|null;
};
export async function loadPartnerOnboardingStates(db:any,companyId:string,ids:string[]):Promise<Map<string,PartnerOnboardingState>> {
 const states=new Map<string,PartnerOnboardingState>();
 for(let offset=0;offset<ids.length;offset+=200){
  const result=await db.rpc("workforce_partner_onboarding_state",{p_company:companyId,p_ids:ids.slice(offset,offset+200)});
  if(result.error)throw new Error(`Partner workflow could not be loaded: ${result.error.message}`);
  for(const row of result.data??[])states.set(row.workforce_id,row);
 }
 return states;
}
