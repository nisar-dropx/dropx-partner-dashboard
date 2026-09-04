import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolvePeopleOperationalHierarchy } from '../src/lib/people-operational-hierarchy-core.ts';
import { managerReviewChain } from '../src/lib/ops-pulse/review-policy.ts';

// Dry-run by default. Uses the same pure People resolver as the live Review Desk.
// A connector-provided dataset can be supplied on stdin to produce a plan without credentials.
if (process.argv.includes('--plan-json')) {
  const dataset = JSON.parse(readFileSync(0, 'utf8'));
  const hierarchy = resolvePeopleOperationalHierarchy(dataset.reviews.map(r => r.station_id), dataset.assignments, dataset.relationships);
  const users = new Map(dataset.links.map(link => [link.person_id, link.user_id]));
  console.log(JSON.stringify(dataset.reviews.map(review => ({
    companyId: review.company_id,
    reviewId: review.id,
    station: review.station_code,
    date: review.source_date,
    chain: managerReviewChain(hierarchy.get(review.station_id)?.managerReportingChain.length ? hierarchy.get(review.station_id).managerReportingChain : hierarchy.get(review.station_id)?.primaryReportingChain ?? []).map(p => ({
      reviewerName: p.name, reviewerRole: p.role, reviewerUserId: users.get(p.personId) ?? null
    }))
  }))));
  process.exit(0);
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  if (process.argv.includes('--env-file')) process.loadEnvFile(process.argv[process.argv.indexOf('--env-file') + 1]);
  else throw new Error('Provide Supabase server environment variables, --env-file PATH, or use --plan-json with a dataset on stdin.');
}
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
const {data:reviews,error}=await db.from('ops_performance_reviews').select('id,company_id,station_id,station_code,source_date').neq('status','closed').lt('routing_version',2);
if(error)throw error;
const one=value=>Array.isArray(value)?value[0]:value;
let changed=0,blocked=0;
for(const company of new Set(reviews.map(r=>r.company_id))){
  const companyReviews=reviews.filter(r=>r.company_id===company);
  const results=await Promise.all([
    db.from('hr_work_assignments').select('id,engagement_id,location_id,designation_id,position_title').eq('company_id',company).eq('is_primary',true).lte('effective_from',day).or(`effective_to.is.null,effective_to.gte.${day}`),
    db.from('hr_engagements').select('id,person_id').eq('company_id',company).eq('status','active'),
    db.from('hr_people').select('id,display_name').eq('company_id',company).eq('status','active'),
    db.from('designations').select('id,code,name').eq('company_id',company).eq('is_active',true),
    db.from('hr_reporting_relationships').select('subject_assignment_id,manager_assignment_id').eq('company_id',company).eq('relationship_type','solid_line').eq('is_primary',true).lte('effective_from',day).or(`effective_to.is.null,effective_to.gte.${day}`).order('effective_from',{ascending:false}),
    db.from('hr_user_person_links').select('person_id,user_id,profiles!hr_user_person_links_user_id_fkey(is_active)').eq('company_id',company).eq('status','active')
  ]);
  for(const result of results)if(result.error)throw result.error;
  const [assignments,engagements,people,designations,relationships,links]=results.map(r=>r.data);
  const engagementMap=new Map(engagements.map(r=>[r.id,r]));const peopleMap=new Map(people.map(r=>[r.id,r]));const designationMap=new Map(designations.map(r=>[r.id,r]));
  const rows=assignments.flatMap(row=>{
    const person=peopleMap.get(engagementMap.get(row.engagement_id)?.person_id);if(!person)return [];
    const designation=designationMap.get(row.designation_id);
    return [{id:row.id,personId:person.id,displayName:person.display_name,locationId:row.location_id,designationCode:designation?.code,designationName:designation?.name,positionTitle:row.position_title}];
  });
  const hierarchy=resolvePeopleOperationalHierarchy(companyReviews.map(r=>r.station_id),rows,relationships.map(r=>({subjectAssignmentId:r.subject_assignment_id,managerAssignmentId:r.manager_assignment_id})));
  const users=new Map(links.filter(link=>one(link.profiles)?.is_active).map(link=>[link.person_id,link.user_id]));
  for(const review of companyReviews){
    const location=hierarchy.get(review.station_id);
    const chain=managerReviewChain(location?.managerReportingChain.length?location.managerReportingChain:location?.primaryReportingChain??[]).map(p=>({reviewerName:p.name,reviewerRole:p.role,reviewerUserId:users.get(p.personId)??null}));
    if(!chain.length){console.log(`${review.station_code} ${review.source_date}: NEEDS PEOPLE REPORTING LINE`);blocked++;continue;}
    console.log(`${review.station_code} ${review.source_date}: ${chain.map(p=>`${p.reviewerName} (${p.reviewerRole}${p.reviewerUserId?'':'; login not linked'})`).join(' → ')}`);
    if(process.argv.includes('--apply')){const saved=await db.rpc('ops_reconcile_manager_review',{p_company:company,p_review:review.id,p_chain:chain});if(saved.error)throw saved.error;}
    changed++;
  }
}
console.log(JSON.stringify({mode:process.argv.includes('--apply')?'applied':'dry-run',reviews:changed,needsSetup:blocked}));
