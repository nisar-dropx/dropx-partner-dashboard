import {applyWorkforceLossRecoveries,type WorkforceLossRecoveryLine} from '../../../../src/lib/workforce-loss-recovery.ts';
/** Estimate only: actual deductions are confirmed by the payroll publication. */
export function ownLossRecoveryEstimate(workerId:string,gross:number,otherDeductions:number,due:WorkforceLossRecoveryLine[]){
 const row={reviewSubjectType:'workforce',reviewSubjectId:workerId,grossPayment:gross,deductions:otherDeductions,netAmount:Math.round((gross-otherDeductions)*100)/100,deductionBreakdown:[] as {code:string;label:string;amount:number;recoveryKey?:string}[]};
 const {carried}=applyWorkforceLossRecoveries([row],due.filter(l=>l.worker_id===workerId));
 return {deductionAmount:row.deductions,netAmount:row.netAmount,lossRecoveryAmount:Math.round(row.deductionBreakdown.reduce((n,l)=>n+l.amount,0)*100)/100,lossRecoveryDeferred:carried.reduce((n,l)=>n+Number(l.amount),0)};
}
