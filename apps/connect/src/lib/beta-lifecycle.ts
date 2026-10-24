import { betaMilestones, type BetaProgressInput } from './beta-onboarding-progress.ts';

// Explicit pilot rollout; canonical and future accounts retain their existing flow.
export const BETA_LIFECYCLE_COMPANY = '43866344-b550-4e8a-9a2d-9d23f3d8a997';
export const BETA_LIFECYCLE_CANDIDATE = '4732e7e3-df91-4c8b-8ea4-0ed77f382313';
export function betaLifecycleEnabled(company:string|null|undefined,candidate:string|null|undefined) {
  return company===BETA_LIFECYCLE_COMPANY && candidate===BETA_LIFECYCLE_CANDIDATE;
}
export function betaLifecycleSummary(data:BetaProgressInput & {closedAt?:string|null;operationalStatus?:string|null}) {
  const milestones=betaMilestones(data);
  const next=milestones.find(m=>m.status==='action')??milestones.find(m=>m.status==='in_progress')??milestones.find(m=>m.status==='pending');
  if(data.closedAt)return {milestones,next:null,stage:'archived',label:'Pilot archived',instruction:'The beta workspace is closed. An authorised admin can review restoration.'};
  if(data.verificationClosed||data.operationalStatus==='OFFBOARDED')return {milestones,next:null,stage:'offboarded',label:'Amazon profile offboarded',instruction:'Contact your station team to review the outcome.'};
  if(data.offboardingRequested)return {milestones,next:null,stage:'exit_requested',label:'Exit request in progress',instruction:'Your station team is following up on your request.'};
  return {milestones,next,stage:next?.id??'complete',label:next?.label??'Work setup complete',instruction:next?.detail??'All tracked steps are confirmed.'};
}
