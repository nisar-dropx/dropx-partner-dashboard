import { idfyActionUrl } from './onboarding-action-url.ts';

export type VerificationState = 'complete' | 'action' | 'in_progress' | 'pending';
export type BetaCheck = {code:string;label:string;status:VerificationState;result?:string;notRequested?:boolean;detail:string;owner:string;source:string;updatedAt:string|null;actionUrl?:string|null};
export type BetaSnapshot = {amazon_profile_id?:string|null;identity_email?:string|null;driver_id?:string|null;idfy_profile_id?:string|null;id_created_at?:string|null;bgc_submitted_at?:string|null;operational_status?:string|null;bgc_status?:string|null;uan_status?:string|null;checks?:unknown;amazon_tasks?:unknown;learning_status?:string|null;learning_confirmed_at?:string|null;lsc_observed_at?:string|null;idfy_observed_at?:string|null;sync_error?:string|null};
export type BetaInboxAction = {kind:'uan'|'assisted'|'verification';url:string;receivedAt:string|null;label:string};
export function verificationState(value:unknown):VerificationState {
 const valueText=String(value??'').trim().toLowerCase().replace(/[_-]/g,' ');
 // Negations and insufficiencies take precedence over words such as "verified".
 if(/\b(red|fail(?:ed)?|reject(?:ed)?|insufficien\w*|mismatch|action required)\b/.test(valueText))return 'action';
 if(/\b(not|unverified|pending|progress|processing|review|initiated|submitted)\b/.test(valueText))return 'in_progress';
 if(/^(green|clear|verified green|verified|complete(?:d)?|approved|pass(?:ed)?|success(?:ful)?)$/.test(valueText))return 'complete';
 return 'pending';
}
export function betaInboxActions(messages:Array<{sender?:string;subject?:string;preview?:string;action_url?:string|null;action_urls?:unknown;received_at?:string|null}>):BetaInboxAction[]{
 const result=new Map<string,BetaInboxAction>();
 for(const m of [...messages].sort((a,b)=>String(b.received_at??'').localeCompare(String(a.received_at??'')))){
  const senderDomain=String(m.sender??'').trim().match(/@([a-z0-9.-]+)>?$/i)?.[1]?.toLowerCase();
  if(!senderDomain||!/(^|\.)idfy\.(com|in)$/.test(senderDomain))continue;
  const uan=/uan|e.?shram|ई.?श्रम/i.test(`${m.subject} ${m.preview}`);
  const verification=/\b(video|address|background|bgv|kyc)\b/i.test(`${m.subject} ${m.preview}`);
  const links=[m.action_url,...(Array.isArray(m.action_urls)?m.action_urls.filter((x):x is string=>typeof x==='string'):[]),...String(m.preview??'').match(/https:\/\/[^\s<>"\]]+/g)??[]];
  for(const raw of links){const url=idfyActionUrl(raw?.replace(/[).,;]+$/,''));if(!url)continue;
   const parsed=new URL(url);const host=parsed.hostname;
   if(parsed.username||parsed.password||parsed.port)continue;
   const capture=host==='capture.kyc.idfy.com'&&/^\/v2\/captures\/?$/.test(parsed.pathname)&&Boolean(parsed.searchParams.get('t'));
   const portal=host==='portal.idfy.com'&&/^\/tokens\/?$/.test(parsed.pathname)&&Boolean(parsed.searchParams.get('p'));
   const uanForm=host==='360.idfy.com'&&/^\/noauth\/[^/]+\/?$/.test(parsed.pathname);
   const kind:BetaInboxAction['kind']|null=uan?(capture?'assisted':uanForm?'uan':null):verification&&(capture||portal)?'verification':null;
   if(!kind)continue;
   if(!result.has(url))result.set(url,{kind,url,receivedAt:m.received_at??null,label:kind==='uan'?'Submit UAN number & card':kind==='assisted'?'Get help with UAN from IDfy':'Open video verification link'});
  }
 }
 return [...result.values()];
}
export function betaChecks(snapshot:BetaSnapshot|null):BetaCheck[]{
 if(!snapshot||!Array.isArray(snapshot.checks))return [];
 return snapshot.checks.filter(x=>x&&typeof x==='object'&&typeof x.code==='string'&&typeof x.label==='string').map(x=>({code:x.code,label:x.label,status:verificationState(x.result??x.status),result:String(x.result??x.status??''),notRequested:String(x.result??x.status??'').toLowerCase()==='cannot request for verification',detail:String(x.detail??'Status received from IDfy.'),owner:verificationState(x.result??x.status)==='action'?'You / station team':'IDfy',source:'IDfy profile',updatedAt:snapshot.idfy_observed_at??null}));
}
export function betaLearning(snapshot:BetaSnapshot|null,now=Date.now()){
 const parsed=snapshot?.id_created_at?Date.parse(snapshot.id_created_at):NaN;
 const dueAt=snapshot?.bgc_submitted_at&&Number.isFinite(parsed)?new Date(parsed+48*3600000).toISOString():null;
 const complete=verificationState(snapshot?.learning_status)==='complete'&&Boolean(snapshot?.learning_confirmed_at);
 return {status:complete?'complete':snapshot?.bgc_submitted_at&&snapshot?.driver_id?'action':'pending',dueAt,overdue:!complete&&Boolean(dueAt)&&Date.parse(dueAt!)<now,confirmedAt:snapshot?.learning_confirmed_at??null,bgcSubmitted:Boolean(snapshot?.bgc_submitted_at),source:'Amazon LSC training task'};
}
export function verifiedBetaSnapshot(snapshot:BetaSnapshot|null,email:string,providerId:string|null):BetaSnapshot|null{
 if(!snapshot||!providerId||snapshot.amazon_profile_id!==providerId||snapshot.identity_email?.trim().toLowerCase()!==email.trim().toLowerCase())return null;
 return snapshot;
}

export function betaTaskComplete(snapshot:BetaSnapshot|null,name:string):boolean {
 if(!Array.isArray(snapshot?.amazon_tasks))return false;
 const matches=snapshot.amazon_tasks.filter(x=>x&&typeof x==='object'&&x.name===name);
 return matches.length===1&&verificationState(matches[0].status)==='complete';
}

/** Each source advances only the task it confirms; an email is never completion. */
export function betaSourceProgress(snapshot:BetaSnapshot|null) {
 const accepted=betaTaskComplete(snapshot,'Accept Invitation');
 const tasks=Array.isArray(snapshot?.amazon_tasks)?snapshot.amazon_tasks:[];
 const submitted=Boolean(snapshot?.bgc_submitted_at)||tasks.some(t=>t.name==='Background Check'&&Array.isArray(t.subtasks)&&t.subtasks.some((s:{name:string;status:string})=>s.name==='Data Submitted'&&verificationState(s.status)==='complete'));
 const registrationComplete=submitted||['ACTIVE','INACTIVE'].includes(snapshot?.operational_status??'');
 const addressChecks=betaChecks(snapshot).filter(c=>/^address(?:_|$)/.test(c.code)&&!c.notRequested);
 return {invitationAccepted:accepted||registrationComplete,amazonRegistrationConfirmed:registrationComplete,
  videoVerificationComplete:addressChecks.length>0&&addressChecks.every(c=>c.status==='complete'),
  accountSetupConfirmed:betaTaskComplete(snapshot,'Account Setup'),
  amazonRegistrationStarted:accepted, bgcSubmitted:submitted};
}
