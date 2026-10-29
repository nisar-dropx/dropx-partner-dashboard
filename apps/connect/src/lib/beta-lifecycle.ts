import { betaMilestones, type BetaProgressInput } from './beta-onboarding-progress.ts';

// Explicit pilot rollout; canonical and future accounts retain their existing flow.
export const BETA_LIFECYCLE_COMPANY = '43866344-b550-4e8a-9a2d-9d23f3d8a997';
export const BETA_LIFECYCLE_CANDIDATE = '4732e7e3-df91-4c8b-8ea4-0ed77f382313';
export function betaLifecycleEnabled(company:string|null|undefined,candidate:string|null|undefined) {
  return company===BETA_LIFECYCLE_COMPANY && candidate===BETA_LIFECYCLE_CANDIDATE;
}
export type BetaLifecycleInput = BetaProgressInput & {
  closedAt?:string|null; sourceStatus?:{amazonUpdatedAt?:string|null;unavailable?:boolean;delayed?:boolean};
};
/** Operational activation and task completion are independent provider facts.
 * This projection never grants canonical access, creates mappings or changes pay. */
export function betaLifecycleSummary(data:BetaLifecycleInput,now=Date.now()) {
  const milestones=betaMilestones(data);
  const next=milestones.find(m=>m.status==='action')??milestones.find(m=>m.status==='in_progress')??milestones.find(m=>m.status==='pending');
  const observed=Date.parse(data.sourceStatus?.amazonUpdatedAt??'');
  const freshness=data.sourceStatus?.unavailable?'unavailable':!Number.isFinite(observed)?'unknown':data.sourceStatus?.delayed||now-observed>30*60000||observed>now+300000?'delayed':'fresh';
  const amazonState=data.lifecycleEnhanced?String(data.operationalStatus??'').trim().toUpperCase():'';
  const active=amazonState==='ACTIVE';
  const followUps=milestones.filter(m=>m.status!=='complete'&&m.id!=='ready').map(m=>({
    ...m, owner:m.id==='attendance'?'Station team':m.id==='activation'?'Associate / station team':m.status==='action'?'Associate':'Amazon / station team'
  }));
  const base={milestones,next,amazonState,freshness,followUps,active:false,
    workspaceStatus:'isolated_beta' as const,
    workspaceDetail:'This test account is separate from the Workforce register. Regular work and payment access need a reviewed Workforce profile and ID/pay mapping.',
    registrationReviewPending:data.registrationStatus==='submitted'};
  if(data.closedAt)return {...base,next:null,stage:'archived',label:'Pilot archived',instruction:'The beta workspace is closed. An authorised admin can review restoration.'};
  if(data.verificationClosed||amazonState==='OFFBOARDED')return {...base,next:null,stage:'offboarded',label:'Amazon profile offboarded',instruction:'Contact your station team to review the outcome.'};
  if(data.offboardingRequested)return {...base,next:null,stage:'exit_requested',label:'Exit request in progress',instruction:'Your station team is following up on your request.'};
  if(amazonState==='INACTIVE')return {...base,next:milestones.find(m=>m.id==='ready')??null,stage:'inactive',label:'Amazon ID inactive',instruction:'Amazon lists your ID as inactive. Ask your station team to review the reason.'};
  if(active)return {...base,active:true,stage:'active',label:freshness==='fresh'?'Amazon ID active':'Amazon ID last confirmed active',
    instruction:'Amazon has activated your ID. Any remaining training or attendance records are shown separately below.'};
  return {...base,stage:next?.id??'complete',label:next?.label??'Work setup complete',instruction:next?.detail??'All tracked steps are confirmed.'};
}

/** Only a fresh, identity-verified onboarding snapshot may use the training-only exit. */
export function betaTrainingExitAllowed(live:{operational_status?:string|null;lsc_observed_at?:string|null}|null,now=Date.now()) {
 const observed=Date.parse(live?.lsc_observed_at??'');
 return live?.operational_status==='ONBOARDING'&&Number.isFinite(observed)&&observed<=now+300000&&now-observed<=15*60000;
}
