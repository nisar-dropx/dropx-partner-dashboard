export type StationReviewTargets = { clearanceCutoff: string | null; emdNoonTarget: number | null };
export const emptyStationReviewTargets: StationReviewTargets = {clearanceCutoff:null, emdNoonTarget:null};
export function parseStationReviewTargets(clearance:string, emd:string):StationReviewTargets {
  if (clearance && !/^([01]\d|2[0-3]):[0-5]\d$/.test(clearance)) throw new Error("Enter a valid station clearance cutoff.");
  const target=emd.trim()===""?null:Number(emd);
  if(target!==null&&(!Number.isFinite(target)||target<0||target>100))throw new Error("EMD target must be between 0 and 100%.");
  return {clearanceCutoff:clearance||null,emdNoonTarget:target};
}
export function clearanceVariance(timestamp:string|null,serviceDate:string,cutoff:string|null):number|null {
  if(!timestamp||!cutoff)return null;
  const variance=(Date.parse(timestamp)-Date.parse(`${serviceDate}T${cutoff}:00+05:30`))/60000;
  return Number.isFinite(variance)?Math.max(0,Math.ceil(variance)):null;
}
