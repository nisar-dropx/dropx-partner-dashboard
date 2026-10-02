import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function compile(file,deps={}){const exports={};new Function('require','exports',ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(n=>deps[n]??require(n),exports);return exports;}
const access={isCodLocationRole:code=>/(^|_)LOCATION$/.test(String(code||''))};
const review=compile('src/lib/ops-pulse/cod-review-policy.ts',{'@/lib/authorization':{hasPermission:(auth,page,action)=>page==='cod_validation'&&action==='edit'&&auth.canEdit},'./cod-pending-access':access});
const base={companyId:'company',userId:'reviewer',email:'ct@dropxlogistics.com',fullName:'Control Tower',roleCode:'OPERATIONS_CT',effectiveRoleCodes:[],hasAllLocationAccess:false,locationScopeIds:['station'],canEdit:true};
assert.equal(review.canReviewCodSlip(base),true);
for(const patch of [{readOnly:true},{isPreview:true},{roleCode:'OPERATIONS_LOCATION'},{canEdit:false}])assert.equal(review.canReviewCodSlip({...base,...patch}),false);
let auth=base,updated=null;
const db={from(){let isUpdate=false;const q={select:()=>q,eq:()=>q,is:()=>q,update:value=>{isUpdate=true;updated=value;return q;},single:async()=>({data:{location_id:'station',proof_version:2,returned_at:null},error:null}),maybeSingle:async()=>({data:isUpdate?{id:'submission'}:null,error:null})};return q;}};
const actions=compile('src/app/ops-pulse/cod/pending/actions.ts',{
 'next/cache':{revalidatePath:()=>{}},'@/lib/authorization':{requirePagePermission:async()=>auth},'@/lib/company-scope':{requireCompanyId:()=>auth.companyId},
 '@/lib/ops-pulse/cod-pending-access':{canAccessDailyCodPending:()=>true},'@/lib/ops-pulse/cod-return-policy':{canReturnCodSlip:()=>false},
 '@/lib/ops-pulse/cod-review-policy':review,'@/lib/supabase-admin':{supabaseAdmin:db}
});
const form=new FormData();form.set('submission_id','submission');form.set('proof_version','2');form.set('decision','Valid');form.set('review_confirmed','yes');
assert.equal((await actions.reviewCodSlip({ok:false,message:''},form)).ok,true);assert.equal(updated.ai_status,'Valid');assert.equal(updated.ai_result.source,'manual');assert.equal(updated.last_updater_name,'Control Tower');
form.set('decision','Not valid');form.set('reason','Seal missing');assert.equal((await actions.reviewCodSlip({ok:false,message:''},form)).ok,true);assert.equal(updated.ai_status,'Not valid');assert.equal(updated.ai_summary,'Seal missing');
form.delete('review_confirmed');assert.equal((await actions.reviewCodSlip({ok:false,message:''},form)).ok,false);
auth={...base,canEdit:false};form.set('review_confirmed','yes');assert.equal((await actions.reviewCodSlip({ok:false,message:''},form)).ok,false);
console.log('PASS COD manual review: restricted access, three-control confirmation, valid/needs-correction decisions and reviewer audit data.');
