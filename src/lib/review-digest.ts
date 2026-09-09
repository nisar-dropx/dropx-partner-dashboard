import type {DigestBuilder} from './portal-digest-delivery';
import {buildReviewMessages} from './review-digest-template.mjs';
export const buildReviewDigest:DigestBuilder=async(db,control,date)=>{
 const result=await db.rpc('portal_ops_review_digest_snapshot',{p_company_id:control.company_id,p_report_date:date});
 if(result.error)throw new Error(result.error.message);
 if(result.data?.performanceDate!==date)throw new Error('Performance date mismatch');
 if(!control.subject_template)throw new Error('Configure the monthly email subject.');
 return {checkedAt:result.data.generated_at,messages:buildReviewMessages(result.data,control.config,control.subject_template)};
};
