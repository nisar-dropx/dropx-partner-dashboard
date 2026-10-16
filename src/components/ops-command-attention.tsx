import { Suspense } from 'react';
import type { AuthorizationContext } from '@/lib/authorization';
import type { CodLocationRow } from '@/lib/ops-pulse/cod';
import { startCommandAttention } from '@/lib/ops-pulse/command-attention-data';
import type { AttentionItem } from '@/lib/ops-pulse/command-attention';
import { LiveCommandAttention, CommandAttentionResult } from './ops-command-attention-live';
import { OpsCommandRefresh } from './ops-command-refresh';

async function Source({id,result}:{id:number;result:Promise<AttentionItem[]>}) {
  return <CommandAttentionResult id={id} items={await result}/>;
}
export function OpsCommandAttention({authorization,locations,today,mode,extraItems=[]}:{authorization:AuthorizationContext;locations:CodLocationRow[];today:string;mode:string;extraItems?:AttentionItem[]|Promise<AttentionItem[]>}) {
  const sources=[...startCommandAttention(authorization,locations,today,mode),Promise.resolve(extraItems)];
  // Reset completed batches on each server refresh or scope change. Nothing from
  // a previous date/location selection may be labelled as a fresh result.
  return <><OpsCommandRefresh/><LiveCommandAttention key={crypto.randomUUID()} today={today} total={sources.length}>
    {sources.map((result,id)=><Suspense key={id} fallback={null}><Source id={id} result={result}/></Suspense>)}
  </LiveCommandAttention></>;
}
