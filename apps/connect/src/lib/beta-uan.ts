import type { BetaSnapshot } from './beta-verification.ts';

export type BetaUanProgress = {
  status: 'verified' | 'submitted' | 'action_required' | 'requested' | 'unknown';
  source: 'Amazon email' | 'IDfy email' | 'Provider status' | 'You' | null;
  updatedAt: string | null;
  messageId: string | null;
  syncDelayed?: boolean;
};
type Mail = {id?:string;sender?:string;subject?:string;preview?:string;received_at?:string|null};
const time = (value?:string|null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const providerState = (value?:string|null) => String(value??'').trim().toLowerCase().replace(/[_-]/g,' ');

/** Keep a confirmation even after the inbox fills with later reminders. Every
 * query is scoped to the authenticated candidate; no name-based matching. */
export async function loadBetaUanMail(db:any,companyId:string,candidateId:string) {
  const query=()=>db.from('workforce_amazon_email_pilot_messages').select('*').eq('company_id',companyId).eq('candidate_id',candidateId).order('received_at',{ascending:false});
  const [recent,confirmation]=await Promise.all([
    query().or('subject.ilike.%uan%,subject.ilike.%shram%').limit(100),
    query().ilike('subject','Your UAN has been verified%').limit(10),
  ]);
  return {messages:[...(recent.error?[]:recent.data??[]),...(confirmation.error?[]:confirmation.data??[])],unavailable:Boolean(recent.error||confirmation.error)};
}

/** A temporary read failure must not replace a previously confirmed result
 * with a reminder. Explicit, newer corrections still take effect. */
export function retainBetaUanProgress(current:BetaUanProgress,previous?:BetaUanProgress):BetaUanProgress {
  if(!current.syncDelayed||!previous||!['verified','submitted'].includes(previous.status))return current;
  if(current.status==='unknown'||current.status==='requested')return {...previous,syncDelayed:true};
  return current;
}

/** Inputs must be queried for the authenticated beta company/candidate only.
 * UAN evidence never completes Account Setup, training, or any canonical record. */
export function betaUanProgress(snapshot:BetaSnapshot|null, messages:Mail[], submittedAt?:string|null):BetaUanProgress {
  const evidence:BetaUanProgress[]=[];
  for(const mail of messages){
    const sender=String(mail.sender??'').trim().match(/^(?:[^<>]*<)?([^\s<>]+@[^\s<>]+)>?$/)?.[1]?.toLowerCase();
    const amazon=sender==='no-reply@logistics.amazon.in'||sender==='no-reply@logistics.amazon.com';
    const idfy=Boolean(sender&&/^[^@]+@(?:[a-z0-9-]+\.)*idfy\.(?:com|in)$/.test(sender));
    if((!amazon&&!idfy)||!time(mail.received_at))continue;
    const subject=String(mail.subject??'').trim(),body=String(mail.preview??'').trim();
    if(!/\bUAN\b|e[ -]?shram/i.test(subject))continue;
    let status:BetaUanProgress['status']|null=null;
    // Require the explicit confirmation template, not a link or the word "verified".
    if(amazon&&/^Your UAN has been verified[.!]?$/i.test(subject)&&/^Your Universal Account Number \(UAN\) has been successfully verified\./i.test(body))status='verified';
    else if(/\bUAN\b.{0,40}\b(rejected|verification failed|could not be verified|not verified)\b/i.test(subject)&&/\bUAN\b|Universal Account Number/i.test(body))status='action_required';
    else if(/\bUAN\b.{0,30}\b(received|submitted|under review)\b/i.test(subject)&&/\bUAN\b|Universal Account Number/i.test(body))status='submitted';
    else if(/action required|complete.*registration|submit.*uan/i.test(subject))status='requested';
    if(status)evidence.push({status,source:amazon?'Amazon email':'IDfy email',updatedAt:mail.received_at!,messageId:mail.id??null});
  }
  const raw=providerState(snapshot?.uan_status);
  const status:BetaUanProgress['status']|null=/^(green|clear|verified green|verified|complete(?:d)?|approved|passed)$/.test(raw)?'verified'
    :/^(red|failed|rejected|not verified|insufficient|insufficiency)$/.test(raw)?'action_required'
    :/^(submitted|received|under review|processing)$/.test(raw)?'submitted':null;
  const observedAt=snapshot?.idfy_observed_at??snapshot?.lsc_observed_at??null;
  if(status&&time(observedAt))evidence.push({status,source:'Provider status',updatedAt:observedAt,messageId:null});
  if(time(submittedAt))evidence.push({status:'submitted',source:'You',updatedAt:submittedAt!,messageId:null});
  const newest=(items:BetaUanProgress[])=>items.sort((a,b)=>time(b.updatedAt)-time(a.updatedAt))[0];
  const verified=newest(evidence.filter(e=>e.status==='verified'));
  // Reminder emails and null/pending fields cannot reopen a verified UAN.
  const rejection=newest(evidence.filter(e=>e.status==='action_required'));
  if(verified&&(!rejection||time(rejection.updatedAt)<time(verified.updatedAt)))return verified;
  const submitted=newest(evidence.filter(e=>e.status==='submitted'));
  if(rejection&&(!submitted||time(submitted.updatedAt)<=time(rejection.updatedAt)))return rejection;
  return submitted??newest(evidence.filter(e=>e.status==='requested'))??{status:'unknown',source:null,updatedAt:null,messageId:null};
}
