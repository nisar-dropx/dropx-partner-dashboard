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
  const labels:Record<string,string>={awaiting_station:'Awaiting station evidence',awaiting_review:'Awaiting review',returned:'Station correction needed',approved:'Approved · ticket to file',with_vendor:'Pending with Amazon',filed:'Ticket filed',won:'Non-recoverable · recovery stopped',lost:'Recoverable · recovery resumed',cancelled:'Disabled',closed:'Closed',preparing:'Preparing evidence',legacy:'Earlier follow-up'};
  return !w.enabled&&!['won','lost','closed'].includes(state)?'Disabled':labels[state]||state.replaceAll('_',' ');
}

/** Classification uses workflow state, never the station's Cloak reference. */
export function isLscFollowup(w: RedisputeState) {
  return ['approved', 'with_vendor', 'filed', 'won', 'lost'].includes(w.workflow_status || w.followup_status);
}
export type QueueDimension = 'station' | 'cluster' | 'region' | 'status' | 'month' | 'type' | 'due';
export type QueueFilters = Record<QueueDimension, string[]>;
export const emptyQueueFilters = (): QueueFilters => ({station:[],cluster:[],region:[],status:[],month:[],type:[],due:[]});
export type QueueFacts = Record<QueueDimension, string[]>;
export function matchesQueueFilters(facts: QueueFacts, filters: QueueFilters, except?: QueueDimension) {
  return (Object.keys(filters) as QueueDimension[]).every(key => key === except || !filters[key].length || filters[key].some(value => facts[key].includes(value)));
}
export function queueFacetOptions(facts: QueueFacts[], filters: QueueFilters, dimension: QueueDimension) {
  return [...new Set([...filters[dimension], ...facts.filter(row => matchesQueueFilters(row, filters, dimension)).flatMap(row => row[dimension])])].sort();
}
