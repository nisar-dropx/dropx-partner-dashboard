import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import {readFileSync} from 'node:fs';
import * as policy from '../../../../lib/ops-pulse/assistant-policy.ts';
import * as languages from '../../../../lib/ops-pulse/assistant-language.ts';
import * as answers from '../../../../lib/ops-pulse/assistant-answer.ts';
const source=ts.transpileModule(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness({signedIn=true,scopeError=false,deny=false,model=false}={}){
 const calls=[],auth={userId:'user',companyId:'company',locationScopeIds:['store'],hasAllLocationAccess:false};
 const locations=[{id:'store',station_code:'TCC3',station_name:'Adyar'},{id:'lm',station_code:'KTUR',station_name:'LM'}];
 const mocks={
 '@/lib/ops-pulse/assistant-model-read':{assistantModelRead:r=>r},
    '@/lib/ops-pulse/assistant-report-token':{signAssistantReport:()=>null},
 '@/lib/ops-pulse/assistant-language':languages,
 '@/lib/ops-pulse/assistant-speech':{translateAssistantText:async(text,lang)=>lang==='ml-IN'?'TCC3: ഇന്ന് 3 പേർ ഹാജരായി.':text},
 '@/lib/authorization':{getAuthorization:async()=>signedIn?auth:null,hasPermission:()=>!deny},
 '@/lib/company-scope':{requireCompanyId:()=>auth.companyId},
 '@/lib/ops-pulse/cod':{loadCodLocations:async()=>({locations,error:scopeError?'unavailable':null})},
 '@/lib/ops-pulse/operating-context':{resolveOperatingContext:()=>({mode:'amazon_now',selectedLocations:[locations[0]]}),operatingModeLabel:()=> 'Dark Store'},
 '@/lib/mcp/dates':{indiaDate:()=> '2026-10-25'},
 '@/lib/ops-pulse/assistant-policy':policy,
 '@/lib/ops-pulse/assistant-answer':answers,
 '@/lib/ops-pulse/assistant-data':{readAssistantData:async(a,l,ds,name,args,defaults)=>{calls.push({a,l,ds,name,args,defaults}); if(!policy.assistantCatalog(()=>true,ds).some(t=>t.name===name))throw Error('Not in workspace'); policy.checkedArguments(args,l.map(x=>x.station_code),defaults); return {asOf:defaults.asOf,rows:[{stationCode:'TCC3',dataAvailable:true,scheduled:6,punched:3,notReported:1,upcoming:2,late:0,onLeave:0,noRoster:0,rosterPending:0}]};}}
 };
 const module={exports:{}};new Function('require','module','exports',source)(n=>{if(!mocks[n])throw Error(n);return mocks[n]},module,module.exports);
 return {calls,post:async(body)=>{const r=await module.exports.POST(new Request('https://ops.dropxlogistics.com/api/ops-pulse/ai-chat',{method:'POST',body:JSON.stringify(body)}));return {status:r.status,cache:r.headers.get('cache-control'),body:await r.json()}}};
}
const geminiEnv=process.env.GEMINI_API_KEY;delete process.env.GEMINI_API_KEY;
const env=process.env.OPENAI_API_KEY;delete process.env.OPENAI_API_KEY;
test.after(()=>{if(geminiEnv)process.env.GEMINI_API_KEY=geminiEnv;else delete process.env.GEMINI_API_KEY;if(env)process.env.OPENAI_API_KEY=env;else delete process.env.OPENAI_API_KEY;});
test('unauthenticated and unauthorized requests do not query data',async()=>{
 for(const [settings,status] of [[{signedIn:false},401],[{deny:true},403]]){const h=harness(settings);assert.equal((await h.post({question:'shift'})).status,status);assert.equal(h.calls.length,0);}
});
test('scope load failure fails closed rather than producing zero figures',async()=>{
 const h=harness({scopeError:true}),r=await h.post({question:'shift'});assert.equal(r.status,503);assert.equal(h.calls.length,0);assert.match(r.body.error,/couldn’t verify/);
});
test('reported TCC3 regression fetches todays shifts, not SPR or page-context capacity',async()=>{
 const h=harness(),r=await h.post({question:"what’s the current shift status of tcc3?",context:'/capacity',history:[{role:'assistant',text:'999 present'}]});
 assert.equal(r.status,200);assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'ops_shift_status');assert.equal(h.calls[0].defaults.asOf,'2026-10-25');assert.deepEqual(h.calls[0].l.map(l=>l.station_code),['TCC3']);assert.match(r.body.answer,/3 punched/);assert.doesNotMatch(r.body.answer,/SPR|999/);assert.match(r.cache,/no-store/);assert.equal(r.body.sources[0].label,'Shift Attendance');
});
test('LM location in DS question cannot silently fall back to all stores',async()=>{
 const h=harness(),r=await h.post({question:'current shift KTUR'});assert.equal(h.calls.length,0);assert.match(r.body.answer,/outside the selected workspace/);
});
test('unknown questions ask for detail and do not read unrelated datasets',async()=>{
 const h=harness(),r=await h.post({question:'Tell me the meaning of life'});assert.equal(h.calls.length,0);assert.match(r.body.answer,/specify/);assert.doesNotMatch(r.body.answer,/SPR/);
});
test('model calls are executed through approved tools and returned before final answer',async()=>{
 const previousFetch=globalThis.fetch;process.env.OPENAI_API_KEY='test-placeholder';const sent=[];
 globalThis.fetch=async(url,init)=>{sent.push(JSON.parse(init.body));return Response.json(sent.length===1?{output:[{type:'function_call',name:'ops_shift_status',arguments:JSON.stringify({stationCodes:['TCC3']}),call_id:'one'}]}:{output:[{type:'message',content:[{type:'output_text',text:'TCC3 has 3 punched people in the current roster. Source: Shift Attendance, 25 October.'}]}]});};
 try{const h=harness(),r=await h.post({question:'TCC3 current shift status'});assert.equal(h.calls.length,1);assert.equal(sent[0].store,false);assert.equal(sent[0].model,'gpt-4.1-mini');assert(sent[1].input.some(i=>i.type==='function_call_output'));assert.match(r.body.answer,/3 punched/);}
 finally{globalThis.fetch=previousFetch;delete process.env.OPENAI_API_KEY;}
});

test('configured Gemini executes live reads and preserves signed tool context',async()=>{
 const previousFetch=globalThis.fetch;process.env.GEMINI_API_KEY='test-placeholder';const sent=[];
 globalThis.fetch=async(url,init)=>{assert.match(url,/gemini-3.5-flash-lite:generateContent/);sent.push(JSON.parse(init.body));return Response.json({candidates:[{content:sent.length===1?{role:'model',parts:[{thoughtSignature:'signature',functionCall:{name:'ops_shift_status',args:{stationCodes:['TCC3']},id:'call1'}}]}:{role:'model',parts:[{text:'TCC3: 3 people punched in today.'}]}}]});};
 try{const h=harness(),r=await h.post({question:'TCC3 shift status'});assert.equal(h.calls.length,1);assert.equal(sent[0].toolConfig.functionCallingConfig.mode,'ANY');assert.equal(sent[1].contents[1].parts[0].thoughtSignature,'signature');assert.equal(sent[1].contents[2].parts[0].functionResponse.id,'call1');assert.equal(r.body.mode,'assistant');assert.match(r.body.answer,/3 people/);}
 finally{globalThis.fetch=previousFetch;delete process.env.GEMINI_API_KEY;}
});

test('selected Malayalam controls model instructions and returned answer even for an English question',async()=>{
 const previousFetch=globalThis.fetch;process.env.OPENAI_API_KEY='test-placeholder';const sent=[];
 globalThis.fetch=async(url,init)=>{sent.push(JSON.parse(init.body));return Response.json(sent.length===1?{output:[{type:'function_call',name:'ops_shift_status',arguments:'{}',call_id:'one'}]}:{output:[{type:'message',content:[{type:'output_text',text:'TCC3: 3 punched.'}]}]});};
 try{const h=harness(),r=await h.post({question:'TCC3 shift',language:'ml-IN'});assert.match(sent[0].instructions,/in Malayalam using its native script/);assert.equal(r.body.language,'ml-IN');assert.match(r.body.answer,/ഹാജരായി/);}
 finally{globalThis.fetch=previousFetch;delete process.env.OPENAI_API_KEY;}
});
