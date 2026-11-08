export type AddressVerification={state:string;label:string;pending?:boolean;followUp?:boolean;stage?:string;detail?:string;needsResponse?:boolean;verificationUrl?:null};
export type AmazonBgcStatus={profileId:string;status:string;reportAvailable:boolean;checkedAt:string;address?:AddressVerification;checks:Array<{id:string;label:string;status:string;needsResponse:boolean;address?:AddressVerification|null}>};
export type AmazonDaPerson = {
  dropxLinkState?:'linked'|'missing'|'review'|'unknown';
  bgc?:AmazonBgcStatus|null;
  providerId: string; name: string; transporterId: string | null; status: string; photoUrl?:string|null;photoTicket?:string|null;
  email: string | null; phone: string | null; stage: string | null; nextAction: string | null;
  progress: number | null; completedSteps: number | null; totalSteps: number | null;
  health: string | null; qualifications: string | null; licenseExpiry: string | null;
};
export type AmazonDaList = { rows:AmazonDaPerson[];checkedAt:string;nextOffset:number|null;snapshot:string;reset?:boolean };
export type AmazonDaOption = { action: 'OFFBOARD' | 'INACTIVATE'; reasonCode: string; label: string };
export type AmazonDaProfile = {person: AmazonDaPerson; options: AmazonDaOption[]; canResend: boolean; checkedAt: string};
export type AmazonDaCommand = {
  station_id:string;reviewed_by:string|null;reviewer_name:string|null;reviewer_role:string|null;reviewed_at:string|null;review_decision:string|null;review_remarks:string|null;
  id: string; provider_id: string; associate_name: string; actor_name: string; actor_role: string;
  action: string; reason_code: string; remarks: string; expected_status: string; status: string;
  result_message: string | null; observed_status: string | null; created_at: string; updated_at: string;
  events?: Array<{status:string;message:string|null;observed_status:string|null;created_at:string}>;
};
export type AmazonDaMilestone={name:string;status:string;subtasks:Array<{name:string;status:string}>};
