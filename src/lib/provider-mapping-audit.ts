export type MappingAuditEvent = { id: string; action: string; actor: string; at: string };
export type StoredMappingAuditRow = { id: string; workforce_id: string | null; provider_id: string | null; provider_member_id: string; station_id: string | null; effective_from: string; created_by: string | null; created_at: string; updated_at: string };
export type StoredMappingEvent = { id: string; workforce_id: string; event_code: string; actor_id: string | null; actor_name: string | null; created_at: string; details: Record<string, unknown> | null };
const labels: Record<string,string> = { provider_mapping_saved: 'Mapping saved', provider_mapping_cleared: 'Mapping cleared', provider_mapping_replaced: 'Associate replaced', provider_mapping_replacement_confirmed: 'Replacement confirmed', provider_mapping_location_kept: 'Location added', provider_mapping_location_moved: 'Location moved', provider_mapping_start_corrected: 'Start date corrected' };
const identity = (value: unknown) => String(value ?? '').trim().toUpperCase().replace(/\.0+$/, '');
export function mappingEventMatches(mapping: StoredMappingAuditRow, event: StoredMappingEvent) {
  if (!event.event_code.startsWith('provider_mapping_')) return false;
  const details = event.details ?? {};
  const ids = ['mapping_id','new_mapping_id','replaced_mapping_id','existing_mapping_id'].map(key => String(details[key] ?? '')).filter(Boolean);
  if (ids.length) return ids.includes(mapping.id);
  // Older save events stored the exact identity and period rather than mapping_id.
  return event.workforce_id === mapping.workforce_id && details.station_id === mapping.station_id
    && details.provider_id === mapping.provider_id && identity(details.provider_member_id) === identity(mapping.provider_member_id)
    && details.effective_from === mapping.effective_from;
}
export function mappingAuditForRow(mapping: StoredMappingAuditRow, events: StoredMappingEvent[], actorNames: Map<string,string>): MappingAuditEvent[] {
  const actor = (id: string | null, label?: string | null) => (id && actorNames.get(id))
    || (label && !/mapping reviewer/i.test(label) ? label : 'User not recorded');
  const matches = events.filter(event => mappingEventMatches(mapping,event)).map(event => ({ id:event.id, action:labels[event.event_code] ?? event.event_code.replace(/^provider_mapping_/, '').replace(/_/g, ' '), actor:actor(event.actor_id,event.actor_name), at:event.created_at }));
  // Creator is not necessarily the updater. Never attribute updated_at to created_by.
  if (mapping.created_at) matches.push({id:`created:${mapping.id}`,action:'Created',actor:actor(mapping.created_by),at:mapping.created_at});
  if (mapping.updated_at && mapping.updated_at !== mapping.created_at && !matches.some(event => Math.abs(Date.parse(event.at)-Date.parse(mapping.updated_at)) < 2000)) matches.push({id:`updated:${mapping.id}`,action:'Record updated',actor:'User not recorded',at:mapping.updated_at});
  return matches.sort((a,b) => b.at.localeCompare(a.at));
}
export function mappingAuditDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time not recorded' : new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',weekday:'short',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}).format(date) + ' IST';
}
