export type RedisputeState = {enabled:boolean; workflow_status?:string; followup_status:string};
export function redisputeStage(w:RedisputeState) {
  const state=w.workflow_status||w.followup_status;
  if(!w.enabled || ['won','lost','cancelled','closed'].includes(state)) return 'closed';
  if(state==='awaiting_review') return 'review';
  if(['approved','with_vendor','filed'].includes(state)) return 'ticket';
  return 'station';
}
export function redisputeStatus(w:RedisputeState) {
  const state=w.workflow_status||w.followup_status;
  const labels:Record<string,string>={awaiting_station:'Awaiting station evidence',awaiting_review:'Awaiting review',returned:'Station correction needed',approved:'Approved · ticket to file',with_vendor:'With vendor',filed:'Ticket filed',won:'Won · recovery stopped',lost:'Unsuccessful · recovery resumed',cancelled:'Disabled',closed:'Closed',preparing:'Preparing evidence',legacy:'Earlier follow-up'};
  return !w.enabled&&!['won','lost','closed'].includes(state)?'Disabled':labels[state]||state.replaceAll('_',' ');
}
