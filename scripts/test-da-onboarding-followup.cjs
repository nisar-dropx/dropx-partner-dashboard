const fs=require('node:fs'),assert=require('node:assert/strict'),ts=require('typescript');
function load(file,stubs={}){const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>stubs[id]||require(id),m,m.exports);return m.exports;}
const view=load('src/lib/da-onboarding-view.ts',{'./dependent-filters':load('src/lib/dependent-filters.ts'),'./da-onboarding-registry':{daNeedsAttention:r=>r.conflict}});
const person={key:'p',stationId:'s1',stationCode:'QLDA',name:'=Test person',phone:'001234567890',email:'person@example.test',status:'ACTIVE',origin:'Existing Amazon ID',next:'Account active',conflict:false,owner:{dropx_id:'000000012345678901',full_name:'Owner'},amazon:{providerId:'amzn1.flex.provider.v1.test',transporterId:'A1234567',bgc:{status:'Stage2 Green',address:{state:'candidate_pending',label:'Address pending · candidate'},checks:[{needsResponse:true}]}}};
const f={query:'',statuses:[],origins:[],verification:[],attention:false};
assert.equal(view.filterDA([person],{...f,query:'qlda 001234'}).length,1);
assert.equal(view.filterDA([person],{...f,query:'missing'}).length,0);
assert.equal(view.filterDA([person],{...f,statuses:['ONBOARDING','ACTIVE'],verification:['red','details_needed']}).length,1);
assert.equal(view.filterDA([person],{...f,statuses:['OFFBOARDED']}).length,0);
assert.equal(view.filterDA([person],{...f,origins:['System email']}).length,0);
assert.equal(view.filterDA([{...person,amazon:null}],{...f,verification:['unknown']}).length,0);
assert.equal(view.filterDA([{...person,amazon:{...person.amazon,bgc:null}}],{...f,verification:['unknown']}).length,1);
const records=view.daExportRows(Array.from({length:51},(_,i)=>({...person,key:String(i)})));assert.equal(records.length,51);
const x=require('xlsx'),sheet=x.utils.json_to_sheet(records);assert.equal(sheet.B2.t,'s');assert.equal(sheet.B2.f,undefined);assert.equal(sheet.C2.v,'001234567890');assert.equal(sheet.E2.v,'000000012345678901');
const wb=x.utils.book_new();x.utils.book_append_sheet(wb,sheet,'Associates');const reopened=x.read(x.write(wb,{bookType:'xlsx',type:'buffer'}),{type:'buffer'});assert.equal(x.utils.sheet_to_json(reopened.Sheets.Associates).length,51);
let permission=true,reads=0,queried=[];const db={from(){let ids=[];const q={select(){return q},eq(){return q},in(_k,v){ids=v;queried.push(v);return q},order(){return q},range:async()=>{reads++;return {data:ids.includes('s1')?[{station_id:'s1',idfy:{checks:[{needsResponse:true}]},idfy_at:'2026-11-08T00:00:00Z'}]:[]}}};return q;}};
const mod=load('src/lib/amazon-da-attention.ts',{'./authorization':{hasPermission:()=>permission},'./supabase-admin':{supabaseAdmin:db},'./ops-workforce-locations':{loadOpsWorkforceLocations:async()=>[{id:'s1',providers:{name:'Amazon'},location_models:{code:'XPT'}},{id:'s2',providers:{name:'Amazon'},location_models:{code:'NOW'}},{id:'s3',providers:{name:'Flipkart'},location_models:{code:'EDSP'}}]}});
(async()=>{assert.equal(mod.amazonDeskLocation({providers:{name:'Amazon'},location_models:{code:'EDSP'}}),true);assert.equal(mod.amazonDeskLocation({providers:{name:'Amazon'},location_models:{code:'NOW'}}),false);
 const a=await mod.loadAmazonDaAttention({companyId:'c'},['s1','s2']);assert.equal(a.count,1);assert.deepEqual(queried,[['s1']]);assert(a.href.includes('bgc-pending'));assert(!a.href.includes('s2'));
 assert.equal(await mod.loadAmazonDaAttention({companyId:'c'},['unauthorized']),null);permission=false;assert.equal(await mod.loadAmazonDaAttention({companyId:'other'},['s1']),null);assert.equal(reads,1);
 console.log('Onboarding: cross-field search, multi-select combinations, all-record export, text IDs/phones/formula safety, eligible Amazon locations and scoped BGC notification counts passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

const noAmazon={...person,key:'missing',amazon:null,status:'ID_NOT_LINKED',origin:'Existing registration'};
const facet=view.daFacets([person,noAmazon],{...f,verification:['details_needed'],origins:['Existing registration']});
assert.equal(facet.rows.length,0);
assert.deepEqual(facet.values('origins'),['Existing Amazon ID','Existing registration']);
assert.deepEqual(facet.values('verification'),['details_needed']);
assert.deepEqual(view.daFacets([person,noAmazon],{...f,query:'missing station'}).values('statuses'),[]);
