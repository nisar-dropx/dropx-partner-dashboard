/** Product isolation uses Vercel's project identity, not a list of mail portals. */
export function isDashboardCronRequest(host:string, environment:{projectId?:string;deploymentHost?:string;productionHost?:string;target?:string}) {
  if(environment.projectId!=='prj_vJMLzagjGdylbkkMGYlfxpomMHx7'||environment.target!=='production')return false;
  const name=host.toLowerCase();
  return Boolean(name)&&(name===environment.deploymentHost?.toLowerCase()||name===environment.productionHost?.toLowerCase());
}
