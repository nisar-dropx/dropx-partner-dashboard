/** Different daily editions share one root, while each keeps its own message id. */
export function digestThreadEvents(event:string):string[]{
 if(event.startsWith('cod_pending_'))return ['cod_pending_evening','cod_pending_morning'];
 if(event.startsWith('id_mapping_'))return ['id_mapping_morning','id_mapping_afternoon'];
 if(['now_review_digest','now_activity_digest'].includes(event))return ['now_review_digest','now_activity_digest'];
 if(['now_insight_morning','now_insight_evening'].includes(event))return ['now_insight_morning','now_insight_evening'];
 return [event];
}
