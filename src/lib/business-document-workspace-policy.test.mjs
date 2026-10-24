import assert from 'node:assert/strict';import test from 'node:test';
import {documentInWorkspace} from './business-document-workspace-policy.ts';
const ds=[{id:'tcc3',state:'Tamil Nadu',provider_id:'amazon-now'}];
test('DS excludes Last Mile even when company owner has broad access',()=>{
 assert.equal(documentInWorkspace({scope_type:'location',scope_id:'ktur'},ds),false);
 assert.equal(documentInWorkspace({scope_type:'location',scope_id:'tcc3'},ds),true);
 assert.equal(documentInWorkspace({scope_type:'location',scope_id:'ktur',additional_scope_ids:['tcc3']},ds),true);
});
test('shared company/state/provider documents are scoped consistently; empty workspace fails closed',()=>{
 assert(documentInWorkspace({scope_type:'company',scope_id:null},ds));
 assert(documentInWorkspace({scope_type:'state',scope_id:'TAMIL NADU'},ds));
 assert(!documentInWorkspace({scope_type:'state',scope_id:'Kerala'},ds));
 assert(documentInWorkspace({scope_type:'provider',scope_id:'amazon-now'},ds));
 assert(!documentInWorkspace({scope_type:'provider',scope_id:'amazon-lm'},ds));
 assert(!documentInWorkspace({scope_type:'company',scope_id:null},[]));
});
