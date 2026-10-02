export type PilotEvidence = {
 providerId?: string | null; transporterId?: string | null; employeeId?: string | null;
 invitationStatus?: string | null; invitationError?: string | null; invitationAt?: string | null;
 lscStatus?: string | null; report?: Record<string,string> | null; reportDate?: string | null;
 reportSyncedAt?: string | null; sccAt?: string | null; sccSource?: string | null;
 firstDelivery?: string | null; conflict?: boolean;
};
export type Pilot = {workforce_id:string;company_id:string;station_id:string;reported_on:string;trial_days:number;trial_completed_at:string|null;readiness_note?:string|null;closed_at:string|null;evidence:PilotEvidence;last_checked_at:string|null;sync_error:string|null;created_at:string};
export const pilotStages = {
 invitation_pending:'Amazon invitation pending', registration_pending:'DA In-App Registration Pending',
 verification_pending:'Amazon Verification Pending', station_pending:'Station setup pending',
 learning_pending:'Amazon learning pending', scc_pending:'Waiting for SCC',
 scc_available:'Available in SCC', delivery_started:'Delivery started', exception:'Needs attention', closed:'Closed'
} as const;
export function pilotStatus(pilot:Pick<Pilot,'evidence'|'trial_completed_at'|'closed_at'>,now=Date.now()) {
 const e=pilot.evidence??{},report=e.report??{};
 const category=String(report.categories??''),action=String(report.action_item??'');
 const text=`${category} ${action}`.toLowerCase();
 const stale=Boolean(e.reportDate && now-new Date(`${e.reportDate}T00:00:00+05:30`).getTime()>48*3600000);
 let stage:keyof typeof pilotStages='registration_pending';
 let instruction='Open the invitation sent to your Amazon email and complete the pending steps in the Flex Pro app.';
 let owner='Associate';
 if(pilot.closed_at){stage='closed';instruction='Your onboarding has been closed. Contact your station team if you wish to rejoin.';owner='Station team';}
 else if(e.conflict){stage='exception';instruction='Your Amazon identifiers need a team review. Your records have been retained.';owner='Station team';}
 else if(/failed|rejected|blocked|insufficien|mismatch/.test(text)){stage='exception';instruction=action||'Your verification needs attention. Contact your station team.';}
 else if(e.firstDelivery && e.employeeId){stage='delivery_started';instruction=`Delivery activity is recorded from ${e.firstDelivery}.`;owner='No action';}
 else if(e.employeeId&&e.sccAt && now-new Date(e.sccAt).getTime()<=48*3600000){stage='scc_available';instruction='Your ID was found in SCC. Your station team can check package assignment.';owner='Station team';}
 else if(e.invitationStatus==='failed'){stage='exception';instruction='Your Amazon invitation needs a team review before another attempt.';owner='Station team';}
 else if(!e.providerId && e.invitationStatus!=='sent'){stage='invitation_pending';instruction='Your station team has requested your Amazon invitation. Check here for its delivery status.';owner='Station team';}
 else if(/station and supervisor|dsp.*need.*enter service/.test(text)){stage='station_pending';instruction=action||'Your station team needs to complete the Amazon station setup.';owner='Station team';}
 else if(/filling|upload|consent|accept.*invitation/.test(text)){instruction=action||instruction;}
 else if(/training course|learning app|learning completion/.test(text)){stage='learning_pending';instruction=action||'Complete your assigned Amazon learning course.';}
 else if(/verification|bgc clearance|provisioning|verify dl/.test(text)){stage='verification_pending';instruction=action||'Amazon or its verification partner is reviewing your details.';owner='Amazon / verification partner';}
 else if(/no further action required/i.test(action)||['ACTIVE','PROVISIONED'].includes(String(e.lscStatus??'').toUpperCase())){stage='scc_pending';instruction='Amazon setup is complete. Waiting for a current SCC record to connect your delivery ID.';owner='Station team';}
 else if(action) instruction=action;
 return {stage,label:pilotStages[stage],instruction,owner,category,action,stale};
}
