/** Different daily editions share one root, while each keeps its own message id. */
export function digestThreadEvents(event:string):string[]{
 const loss=/^loss_reminder_(recovery|dispute|response)_(morning|afternoon)$/.exec(event);
 if(loss)return [`loss_reminder_${loss[1]}_morning`,`loss_reminder_${loss[1]}_afternoon`];
 if(event.startsWith('cod_pending_'))return ['cod_pending_evening','cod_pending_morning'];
 if(event.startsWith('id_mapping_'))return ['id_mapping_morning','id_mapping_afternoon'];
 if(event.startsWith('registration_pendency_'))return ['registration_pendency_morning','registration_pendency_afternoon'];
 if(['now_review_digest','now_activity_digest','now_insight_morning','now_insight_evening'].includes(event))return ['now_review_digest','now_activity_digest','now_insight_morning','now_insight_evening'];
 return [event];
}

/** Preserve an existing morning root when upgrading from two separate threads.
 * The most recent reply within that root is used, never the old afternoon root.
 * If the first pending edition of a month is afternoon, it becomes the root.
 */
export function selectDigestThread<T extends {event_key:string;root_message_id:string;last_sent_at:string}>(event:string,threads:T[]):T|null {
 const sorted=[...threads].sort((a,b)=>b.last_sent_at.localeCompare(a.last_sent_at));
 if(!event.startsWith('registration_pendency_'))return sorted[0]||null;
 const anchor=sorted.find(t=>t.event_key==='registration_pendency_morning')||sorted[0];
 return sorted.find(t=>t.root_message_id===anchor?.root_message_id)||null;
}

export function registrationThreadEvent(event:string) {
 return event.startsWith('registration_pendency_')?'registration_pendency_morning':event;
}

export function registrationMessageSuffix(event:string) {
 return event.startsWith('registration_pendency_')?'-'+event.split('_').at(-1):'';
}
