export type RedisputeState = {enabled:boolean; workflow_status?:string; followup_status:string};
export function redisputeStage(w:RedisputeState) {
  const state=w.workflow_status||w.followup_status||'legacy';
  if(!w.enabled || ['won','lost','cancelled','closed'].includes(state)) return 'closed';
  if(state==='awaiting_review') return 'review';
  if(['approved','with_vendor','filed'].includes(state)) return 'ticket';
  return 'station';
}
export function redisputeStatus(w:RedisputeState) {
  const state=w.workflow_status||w.followup_status||'legacy';
  if (w.enabled && state === 'with_vendor' && w.followup_status === 'filed') return 'Ticket raised';
  const labels:Record<string,string>={awaiting_station:'Awaiting station evidence',awaiting_review:'Awaiting review',returned:'Station correction needed',approved:'Confirmed · ticket to raise',with_vendor:'Awaiting response from Amazon',filed:'Ticket raised',won:'Recovered · redispute successful',lost:'Unsuccessful · recovery resumed',cancelled:'Disabled',closed:'Closed',preparing:'Preparing evidence',legacy:'Earlier follow-up'};
  return !w.enabled&&!['won','lost','closed'].includes(state)?'Disabled':labels[state]||state.replaceAll('_',' ');
}

export const ticketStatuses = [
  { value: 'filed', label: 'Ticket raised' },
  { value: 'with_vendor', label: 'Awaiting response from Amazon' },
] as const;

/** Shared form/API validation; the database separately enforces workflow and version. */
export function ticketUpdateError(action: string, details: {
  tt_reference: string; tt_url: string; followup_on: unknown; followup_status?: unknown;
}) {
  if (!['tracking', 'won', 'lost'].includes(action)) return null;
  if (details.tt_reference.trim().length < 3 || details.tt_reference.trim().length > 160)
    return 'Enter the Amazon ticket ID (3–160 characters).';
  if (details.tt_url) {
    try {
      const url = new URL(details.tt_url);
      if (url.protocol !== 'https:' || url.username || url.password || details.tt_url.length > 2000) throw Error();
    } catch { return 'Use a valid HTTPS ticket link.'; }
  }
  if (action === 'tracking') {
    if (details.followup_status != null && !ticketStatuses.some(s => s.value === details.followup_status))
      return 'Choose Ticket raised or Awaiting response from Amazon.';
    const due = details.followup_on;
    if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due) ||
      !Number.isFinite(Date.parse(due)) || new Date(due).toISOString().slice(0, 10) !== due)
      return 'Set a valid next follow-up date.';
  }
  return null;
}

export function redisputeFollowup(w: RedisputeState & { followup_on?: string | null }, today: string) {
  if (redisputeStage(w) !== 'ticket' || !w.followup_on) return '';
  return w.followup_on < today ? 'overdue' : w.followup_on === today ? 'today' : 'upcoming';
}
