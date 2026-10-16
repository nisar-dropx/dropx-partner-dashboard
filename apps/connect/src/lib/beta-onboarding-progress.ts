import { betaJourney } from './beta-journey.ts';
export type BetaStage = "overview" | "attendance" | "registration" | "amazon" | "bgc" | "account" | "activation";
export type CheckState = "complete" | "action" | "in_progress" | "pending";
export type BetaMilestone = { id:Exclude<BetaStage,"overview">;label:string;detail:string;status:CheckState;source:string };
export type BetaProgressInput = {
 isolatedBeta?:boolean; stage:string; registrationStatus?:string|null; registrationRequired?:boolean;
 verificationClosed?:boolean; continuationStatus?:"pending"|"continuing"|"not_continuing";
 amazonRegistrationConfirmed?:boolean; invitationAccepted?:boolean; invitationAvailable?:boolean;
 offboardingRequested?:boolean; bgcStatus?:string|null; accountSetupConfirmed?:boolean;
 bgcChecks?:Array<{status:CheckState}>; inboxActions?:Array<{kind:string}>;
 driverId?:string|null; learning?:{status:string}; latestAttendance?:{inTime:string|null;outTime:string|null}|null;
};
export function betaMilestones(data:BetaProgressInput):BetaMilestone[]{
  const attendanceComplete=Boolean(data.latestAttendance?.inTime&&data.latestAttendance?.outTime);
  const registrationComplete=["submitted","confirmed"].includes(data.registrationStatus??"")||(!data.isolatedBeta&&!data.registrationRequired);
  const journey=betaJourney({continuationStatus:data.verificationClosed?"not_continuing":data.continuationStatus,registrationStatus:data.registrationStatus});
  const invitationComplete=Boolean(data.amazonRegistrationConfirmed)||["verification_pending","station_pending","learning_pending","scc_pending","scc_available","delivery_started"].includes(data.stage);
  const bgcAction=Boolean(data.bgcChecks?.some(item=>item.status==="action"));
  const bgcComplete=data.isolatedBeta?/^(green|clear|verified|approved|passed|verified_green)$/i.test(data.bgcStatus??"")&&!bgcAction:Boolean(data.bgcChecks?.length)&&data.bgcChecks!.every(item=>item.status==="complete");
  const uanAction=Boolean(data.inboxActions?.some(item=>item.kind==="uan"));
  const accountComplete=data.isolatedBeta?Boolean(data.accountSetupConfirmed):!uanAction&&["scc_pending","scc_available","delivery_started"].includes(data.stage);
  return [
    {id:"attendance",label:"Biometric & buddy training",detail:journey.ready?attendanceComplete?"Buddy training confirmed; IN and OUT punches received.":"Readiness confirmed. Biometric punches not yet received.":"Enrol your biometric ID and learn with your station buddy for up to 2 days.",status:journey.ready?(attendanceComplete?"complete":"in_progress"):"action",source:"Biometric punches + your readiness confirmation"},
    {id:"registration",label:"DropX registration",detail:registrationComplete?"Registration submitted.":journey.ready?"Confirm your details and submit the registration.":"Continue here after learning the role with your buddy.",status:registrationComplete?"complete":journey.ready?"action":"pending",source:"DropX registration + Workforce review"},
    {id:"amazon",label:"Amazon registration",detail:data.offboardingRequested?"Your station team will follow up.":!registrationComplete?"Your invitation is kept ready while you complete the first two steps.":invitationComplete?"Amazon registration received; follow the remaining checks.":data.invitationAvailable?data.invitationAccepted?"Finish your details in Amazon Flex.":"Open the invitation and create your Amazon login.":"Waiting for your Amazon invitation link.",status:invitationComplete?"complete":registrationComplete?(data.invitationAvailable?"action":"in_progress"):"pending",source:data.isolatedBeta?"Amazon LSC registration submission":"Amazon LSC / DA In-App registration evidence"},
    {id:"bgc",label:"Background verification",detail:bgcAction?`${data.bgcChecks?.filter(item=>item.status==="action").length} check(s) need attention.`:bgcComplete?"IDfy has confirmed clearance.":"Verification is continuing check by check.",status:bgcAction?"action":bgcComplete?"complete":invitationComplete?"in_progress":"pending",source:data.isolatedBeta?"IDfy profile":"IDfy; DA In-App only as fallback"},
    {id:"account",label:data.isolatedBeta?"Account setup & e-Shram UAN":"Account setup and UAN",detail:accountComplete?"Amazon account setup is complete.":uanAction?"Submit your e-Shram UAN number and card.":"Waiting for Amazon account setup confirmation.",status:accountComplete?"complete":uanAction?"action":invitationComplete?"in_progress":"pending",source:data.isolatedBeta?"Amazon LSC account setup task":"Amazon LSC profile; DA In-App fallback"},
    {id:"activation",label:data.isolatedBeta?"Amazon training & first delivery":"Driver ID and first delivery",detail:data.learning?.status==="complete"?"Training complete. Waiting for your first delivery.":data.learning?.status==="action"?"Complete your assigned LM Learning course.":data.driverId?`LSC Driver ID ${data.driverId} received.`:"Waiting for a confirmed Amazon Driver ID.",status:data.learning?.status==="complete"&&data.stage==="delivery_started"?"complete":data.learning?.status==="action"?"action":data.learning?.status==="complete"?"in_progress":"pending",source:"Amazon LSC / SCC + daily shipment count"}
  ];
}

