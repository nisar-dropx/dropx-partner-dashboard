export type AmazonDaPerson = {
  providerId: string; name: string; transporterId: string | null; status: string;
  email: string | null; phone: string | null; stage: string | null; nextAction: string | null;
  progress: number | null; completedSteps: number | null; totalSteps: number | null;
  health: string | null; qualifications: string | null; licenseExpiry: string | null;
};
export type AmazonDaOption = { action: 'OFFBOARD' | 'INACTIVATE'; reasonCode: string; label: string };
export type AmazonDaProfile = {person: AmazonDaPerson; options: AmazonDaOption[]; canResend: boolean; checkedAt: string};
export type AmazonDaCommand = {
  id: string; provider_id: string; associate_name: string; actor_name: string; actor_role: string;
  action: string; reason_code: string; remarks: string; expected_status: string; status: string;
  result_message: string | null; observed_status: string | null; created_at: string; updated_at: string;
  events?: Array<{status:string;message:string|null;observed_status:string|null;created_at:string}>;
};
