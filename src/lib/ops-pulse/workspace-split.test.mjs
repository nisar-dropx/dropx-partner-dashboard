import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function compile(path,mocks){const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>{if(n in mocks)return mocks[n];throw Error(n);},m.exports,m);return m.exports;}
let preference='amazon_now';
const ctx=compile('./operating-context.ts',{'next/headers':{cookies:()=>({get:k=>k==='dropx-ops-mode'?{value:preference}:undefined})},'@/lib/ops-pulse/cod':{locationModelName:l=>l.model,providerName:l=>l.provider}});
const nav=compile('./navigation.ts',{'@/lib/app-navigation':{fleetNavItem:{code:'fleet',label:'Fleet'}},'@/lib/authorization':{hasPermission:()=>true,isCompanyOwner:()=>false},'@/lib/ops-pulse/cod-pending-access':{canAccessDailyCodPending:()=>true}});
const lm={id:'l',station_code:'LM',model:'EDSP',provider:'Amazon'},ds={id:'d',station_code:'DS',model:'NOW',provider:'Amazon'};
test('workspace selection cannot use a cookie to grant another business location',()=>{preference='amazon_now';const r=ctx.resolveOperatingContext([lm]);assert.equal(r.mode,'amazon_edsp');assert.deepEqual(r.modeLocations,[lm]);assert.deepEqual(r.availableModes.map(x=>x.code),['amazon_edsp']);});
test('dual access offers both workspaces, excluding HO and hidden locations',()=>{const r=ctx.resolveOperatingContext([lm,ds,{...ds,id:'h',is_ho:true},{...ds,id:'x',hide_from_location_list:true}]);assert.equal(r.mode,'amazon_now');assert.deepEqual(r.modeLocations,[ds]);assert.equal(r.availableModes.length,2);});
test('DS has unit costs and generic menus, without last-mile specialist workflows',()=>{const menus=nav.opsNavItemsForMode('amazon_now');assert(menus.some(x=>x.href==='/cpu'));for(const code of ['ops_rostering','business_documents','payments','ops_reports','master_data','users'])assert(menus.some(x=>x.code===code));for(const code of ['cod','fleet','performance','capacity'])assert(!menus.some(x=>x.code===code));});
test('both workspaces lead to the same complete approvals queue',()=>{const approvals=mode=>nav.opsNavItemsForMode(mode).find(x=>x.code==='payments').children.find(x=>x.code==='payment_approvals');assert.deepEqual(approvals('amazon_edsp'),approvals('amazon_now'));assert.equal(approvals('amazon_now').href,'/payments/approvals');});
