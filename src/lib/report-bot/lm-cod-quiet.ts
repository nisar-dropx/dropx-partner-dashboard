export type CodIssue={ids:string[];amount:number};
export type CodQuietState=CodIssue&{firstSentAt:number;lastSentAt:number;escalated:boolean};
export function quietCodDecision(prior:CodQuietState|null,issue:CodIssue,now:number){
 if(!issue.ids.length)return {send:false,reason:'cleared' as const,next:null};
 const ids=[...new Set(issue.ids)].sort();
 if(!prior)return {send:true,reason:'initial' as const,next:{...issue,ids,firstSentAt:now,lastSentAt:now,escalated:false}};
 if(now-prior.lastSentAt<2*3600000)return {send:false,reason:'cooldown' as const,next:prior};
 const worsening=ids.some(id=>!prior.ids.includes(id))||issue.amount>prior.amount+10;
 // One escalation after the immediate-action deadline's two-hour grace.
 // Further unchanged checks stay silent, including the closing sweep.
 if(!prior.escalated||worsening)return {send:true,reason:!prior.escalated?'escalation' as const:'changed' as const,next:{...prior,...issue,ids,lastSentAt:now,escalated:true}};
 return {send:false,reason:'unchanged' as const,next:prior};
}
