/** Different daily editions share one root, while each keeps its own message id. */
export function digestThreadEvents(event:string):string[]{
 const loss=/^loss_reminder_(recovery|dispute|response)_(morning|afternoon)$/.exec(event);
 if(loss)return [`loss_reminder_${loss[1]}_morning`,`loss_reminder_${loss[1]}_afternoon`];
 if(event.startsWith('cod_pending_'))return ['cod_pending_evening','cod_pending_morning'];
 if(event.startsWith('id_mapping_'))return ['id_mapping_morning','id_mapping_afternoon'];
 if(['now_review_digest','now_activity_digest','now_insight_morning','now_insight_evening'].includes(event))return ['now_review_digest','now_activity_digest','now_insight_morning','now_insight_evening'];
 return [event];
}
