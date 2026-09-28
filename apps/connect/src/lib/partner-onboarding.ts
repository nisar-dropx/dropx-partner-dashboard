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
