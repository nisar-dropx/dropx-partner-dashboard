export type FleetAuditContext = { actorId:string|null; actorLabel:string; viewerId:string|null; requestId:string; action:string; route:string; companyId:string|null };
let readContext:()=>FleetAuditContext|undefined=()=>undefined;
export function setFleetAuditContextReader(reader:typeof readContext){readContext=reader;}
export function fleetAuditFetch(fetcher:typeof fetch):typeof fetch {
 return (input,init)=>{
  const context=readContext();
  if(!context)return fetcher(input,init);
  const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
  const {actorLabel,...safeContext}=context;
  headers.set('x-fleet-audit',JSON.stringify(safeContext));
  return fetcher(input,{...init,headers});
 };
}
