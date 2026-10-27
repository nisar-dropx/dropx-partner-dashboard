const ts=require('typescript'),fs=require('fs'),assert=require('node:assert/strict');
let auth,station='KLZA',raiser='associate',calls=0,filters=[];
const db={from(){const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:{id:'q',raised_by:raiser,nl_loss_month_cases:{station_code:station}}}),in(k,v){filters.push([k,v]);return q},order(){return q}};return q},rpc:async()=>{calls++;return{data:{},error:null}}};
function load(file){const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{
if(id.endsWith('/authorization'))return{getAuthorization:async()=>auth,hasPermission:()=>!auth.denied};
if(id.endsWith('/loss-recovery-controls'))return load('src/lib/ops-pulse/loss-recovery-controls.ts');
if(id.endsWith('/nl-loss'))return{nlStationScope:async()=>({company:'C',stations:[{source_code:'KLZA'}]})};
if(id.endsWith('/supabase-admin'))return{supabaseAdmin:db};
if(id.endsWith('/supabase-pagination'))return{readAllRows:async()=>({data:[],error:null})};
throw Error(id)},m,m.exports);return m.exports;}
(async()=>{const api=load('src/app/api/ops-pulse/losses/clarifications/route.ts');
const base={userId:'reviewer',roleCode:'OPERATIONS_SLPM',readOnly:false,isMasterOwner:false};
const post=(body={},origin='https://ops.dropxlogistics.com')=>api.POST(new Request('https://ops.dropxlogistics.com/api/ops-pulse/losses/clarifications',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({id:'q',version:1,note:'Reviewed the shipment evidence',...body})}));
for(const roleCode of ['OPERATIONS_SLPM','OPERATIONS_NH','OPERATIONS_FINMGR','OPERATIONS_MANAGING_PARTNER']){auth={...base,roleCode};assert.equal((await api.GET()).status,200);assert.equal((await post()).status,200)}
assert.ok(filters.some(([k,v])=>k==='nl_loss_month_cases.station_code'&&v[0]==='KLZA'));
const before=calls;
for(const roleCode of ['OPERATIONS_SI','OPERATIONS_CLM','OPERATIONS_GM']){auth={...base,roleCode};assert.equal((await api.GET()).status,403);assert.equal((await post()).status,403)}
auth={...base,readOnly:true};assert.equal((await post()).status,403);
auth=base;station='OTHER';assert.equal((await post()).status,403);station='KLZA';raiser='reviewer';assert.equal((await post()).status,403);raiser='associate';
assert.equal((await post({},'https://evil.example')).status,403);assert.equal((await post({note:'short'})).status,400);assert.equal((await post({version:null})).status,400);assert.equal(calls,before);
console.log('PASS clarification API: role, station, independent reviewer, preview, origin and version checks.');})().catch(e=>{console.error(e);process.exitCode=1});
