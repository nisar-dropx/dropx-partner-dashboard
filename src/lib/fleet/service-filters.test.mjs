import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
function load(file,mocks={}){const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const exports={};vm.runInNewContext(code,{exports,require:key=>{if(!(key in mocks))throw Error(key);return mocks[key];}});return exports;}
const policy=load('src/lib/fleet/vehicle-status-policy.ts');
const types=load('src/lib/fleet/vehicle-type.ts');
const core=load('src/lib/dependent-filters.ts');
const {serviceFilterFacets}=load('src/lib/fleet/service-filters.ts',{'../dependent-filters':core,'./vehicle-status-policy':policy,'./vehicle-type':types});
const vehicles=[['1','A','Van','active'],['2','A','Truck','breakdown'],['3','B','Van','active']].map(([id,stationCode,model,status])=>({id,vehicleNo:id,stationCode,model,status,ownershipType:'own',statusComment:'',nextServiceDate:null}));
const data={today:'2026-11-08',stationOptions:[{code:'A',region:'North'},{code:'B',region:'South'}],vehicleStatuses:[],adHocRows:[],serviceHistory:[],payments:[],settings:{serviceWarningDays:14}};
const defaults={stations:[],regions:[],models:[],ownership:[],statuses:[],search:'',date:'2026-11-08'};
const facets=(view,selection={},context=data)=>serviceFilterFacets(context,vehicles,view,{...defaults,...selection},new Map(),new Map());
const values=(result,key)=>Array.from(result.available[key]).sort();
test('affected daily status follows candidate model instead of any other model at the station',()=>{const result=facets('daily_status',{statuses:['affected']});assert.deepEqual(values(result,'model'),['Truck']);assert.deepEqual(values(result,'station'),['A']);assert.deepEqual(values(facets('daily_status',{models:['Van']}),'status'),[]);assert.deepEqual(values(facets('daily_status',{models:['Van'],statuses:['affected']}),'station'),[]);});
test('approved vans allow the matching operational model but unapproved requests do not',()=>{const van={date:'2026-11-08',requestType:'Van',source:'Request',approvalStatus:'approved',stationCode:'B',region:'South'};assert.deepEqual(values(facets('daily_status',{models:['Van'],statuses:['affected']},{...data,adHocRows:[van]}),'station'),['B']);assert.deepEqual(values(facets('daily_status',{models:['Van'],statuses:['affected']},{...data,adHocRows:[{...van,approvalStatus:'pending'}]}),'station'),[]);});
test('service schedule and unavailable vehicles use their own data context',()=>{assert.deepEqual(values(facets('schedule'),'status'),['not_planned']);assert.deepEqual(values(facets('non_operational'),'model'),['Truck']);assert.deepEqual(values(facets('non_operational'),'station'),['A']);});
test('history and bill filters ignore hidden selectors and respect search',()=>{const context={...data,serviceHistory:[{vehicleId:'2',vehicleNo:'2',stationCode:'A',status:'completed',serviceType:'Repair',vendorName:'Workshop'}],payments:[{stationCode:'B',requestNo:'P1',head:'Rent',remarks:'',statusLabel:'Paid'}]};assert.deepEqual(values(facets('history',{search:'Workshop',ownership:['irrelevant']},context),'model'),['Truck']);assert.deepEqual(values(facets('bills',{models:['Truck']},context),'station'),['B']);});

test('historical van regions do not offer impossible model combinations',()=>{const context={...data,adHocRows:[{date:'2026-11-08',requestType:'Van',source:'Cashbook',stationCode:'B',region:'Historical'}]};assert.deepEqual(values(facets('daily_status',{models:['Van'],statuses:['affected']},context),'region'),[]);assert.deepEqual(values(facets('daily_status',{statuses:['affected']},context),'region'),['Historical','North']);});
