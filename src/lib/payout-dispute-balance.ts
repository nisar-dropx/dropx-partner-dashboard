export type LossBalanceChoice = "outstanding" | "write_off";
export function lossDisputeReduction(plan: any) {
  return Math.round((plan?.items??[]).filter((i:any)=>i.selector==="deduction"&&i.recovery_key)
    .reduce((n:number,i:any)=>n+Math.max(0,Number(i.current_value)-Number(i.proposed_value)),0)*100)/100;
}
export function validateLossBalance(plan:any, choice:unknown, reason:unknown) {
  if(!lossDisputeReduction(plan))return null;
  if(choice!=="outstanding"&&choice!=="write_off")throw Error("Choose whether the reduced loss stays outstanding or is written off.");
  const note=String(reason??"").trim();
  if(note.length<10||note.length>1000)throw Error("Add a short reason for the loss balance decision (10–1,000 characters).");
  return {treatment:choice as LossBalanceChoice,reason:note};
}
export function validateBulkDisputeSelection(value:unknown) {
  if(!Array.isArray(value)||!value.length||value.length>10)throw Error("Select 1–10 disputes per batch.");
  const seen=new Set<string>();
  return value.map(row=>{
    if(!row||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)||!Number.isSafeInteger(row.version)||row.version<1||typeof row.digest!=="string"||row.digest.length<20||row.reviewed!==true)throw Error("Check the evidence for every selected dispute.");
    if(seen.has(row.id))throw Error("A dispute was selected more than once.");seen.add(row.id);
    return {id:row.id,version:row.version,digest:row.digest,treatment:row.treatment,reason:row.reason};
  });
}
