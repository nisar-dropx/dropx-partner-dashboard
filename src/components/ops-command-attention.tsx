import { Suspense } from 'react';
import type { AuthorizationContext } from '@/lib/authorization';
import type { CodLocationRow } from '@/lib/ops-pulse/cod';
import { startCommandAttention } from '@/lib/ops-pulse/command-attention-data';
import type { AttentionItem } from '@/lib/ops-pulse/command-attention';
import { LiveCommandAttention, CommandAttentionResult, type AttentionStation } from './ops-command-attention-live';
import { OpsCommandRefresh } from './ops-command-refresh';

async function Source({id,result}:{id:number;result:Promise<AttentionItem[]>}) {
  return <CommandAttentionResult id={id} items={await result}/>;
}
export function OpsCommandAttention({authorization,locations,today,mode,extraItems=[],station='',stations,range}:{authorization:AuthorizationContext;locations:CodLocationRow[];today:string;mode:string;extraItems?:AttentionItem[]|Promise<AttentionItem[]>;station?:string;stations?:AttentionStation[];range?:{from:string;to:string}}) {
  const sources=[...startCommandAttention(authorization,locations,today,mode),Promise.resolve(extraItems)];
  const options=stations??locations.filter(l=>!l.is_ho&&!l.hide_from_location_list).map(l=>({code:l.station_code,name:l.station_name||l.city||l.station_code}));
  // Reset completed batches on each server refresh or scope change. Nothing from
  // a previous date/location selection may be labelled as a fresh result.
  // Remount on every server refresh so background router.refresh() cannot keep
  // stale source batches in the client aggregator.
  return <><OpsCommandRefresh/><LiveCommandAttention key={crypto.randomUUID()} today={today} total={sources.length} stations={options} station={station} range={range}>
    {sources.map((result,id)=><Suspense key={id} fallback={null}><Source id={id} result={result}/></Suspense>)}
  </LiveCommandAttention></>;
}
