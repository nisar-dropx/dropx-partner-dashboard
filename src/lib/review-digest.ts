import type {DigestBuilder} from './portal-digest-delivery';
import {buildReviewMessages} from './review-digest-template.mjs';
import {allRoutingRows, loadPeopleReviewGraph, syncPeopleReviewRoutes} from './ops-pulse/people-review-routing';
import {resolvePeopleReviewRoute} from './ops-pulse/people-review-route';
export const buildReviewDigest:DigestBuilder=async(db,control,date)=>{
 await syncPeopleReviewRoutes(control.company_id,{from:date,to:date},db);
 const result=await db.rpc('portal_ops_review_digest_snapshot',{p_company_id:control.company_id,p_report_date:date});
 if(result.error)throw new Error(result.error.message);
 if(result.data?.performanceDate!==date)throw new Error('Performance date mismatch');
 if(!control.subject_template)throw new Error('Configure the monthly email subject.');
 const graph=await loadPeopleReviewGraph(control.company_id,db);
 const snapshot=result.data;
 snapshot.routes=Object.fromEntries(snapshot.stations.map((station:{id:string})=>[station.id,resolvePeopleReviewRoute(graph,station.id)]));
 snapshot.reviews=await allRoutingRows(db.from('ops_performance_reviews').select('id,station_id,status,source_date,routing_error').eq('company_id',control.company_id).eq('source_date',date).eq('review_type','daily_operations').order('id'));
 snapshot.steps=[];
 for(let i=0;i<snapshot.reviews.length;i+=100){
  snapshot.steps.push(...await allRoutingRows(db.from('ops_performance_review_steps').select('review_id,step_order,reviewer_name,reviewer_role,status,completed_at,proxy_reviewer_name,bypassed_at,route_superseded_at').eq('company_id',control.company_id).in('review_id',snapshot.reviews.slice(i,i+100).map((r:{id:string})=>r.id)).order('id')));
 }
 return {checkedAt:snapshot.generated_at,messages:buildReviewMessages(snapshot,control.config,control.subject_template)};
};
