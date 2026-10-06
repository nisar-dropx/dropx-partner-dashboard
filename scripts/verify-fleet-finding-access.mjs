import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
const load=(file,mocks)=>{const exports={};new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(exports,n=>{if(!(n in mocks))throw Error(n);return mocks[n];});return exports;};
let auth={userId:'u',companyId:'c',isMasterOwner:false,hasAllLocationAccess:true,readOnly:false,locationScopeIds:['station']};let station='KTUB';let ownership='own';let edit=true;
const query=(table)=>{const b={select:()=>b,eq:()=>b,in:()=>b,single:async()=>({data:{status:'failed',fleet_vehicles:{station_code:'KTUB',ownership_type:ownership}},error:null}),then:r=>r({data:[{station_code:station}],error:null})};return b;};
const {auditAccess}=load('src/lib/fleet/audit-access.ts',{'server-only':{},'@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:(_,code,action)=>action==='access'||edit},'@/lib/company-scope':{requireCompanyId:()=>auth.companyId},'@/lib/fleet-control':{hasActiveFleetMembership:async()=>true},'@/lib/supabase-admin':{supabaseAdmin:{from:query}}});
assert.equal((await auditAccess('a','followup')).userId,'u');
await assert.rejects(()=>auditAccess('a',true),/already completed/);
auth.readOnly=true;auth.isMasterOwner=true;await assert.rejects(()=>auditAccess('a','followup'),/read-only/);
auth.readOnly=false;auth.isMasterOwner=false;edit=false;await assert.rejects(()=>auditAccess('a','followup'),/permission denied/);
edit=true;auth.hasAllLocationAccess=false;station='OTHER';await assert.rejects(()=>auditAccess('a','followup'),/outside your assigned/);
station='KTUB';await auditAccess('a','followup');
console.log('Finding access: completed audit follow-up allowed; original audit editing, read-only owner preview, missing permission and cross-station access rejected.');

for(const source of ['odcd','rented',null]){ownership=source;await assert.rejects(()=>auditAccess('a','followup'),/DropX-owned/);await auditAccess('a',false);}
console.log('Non-owned audit changes rejected; historical report read allowed.');
