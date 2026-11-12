import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as bank from './lm-bank-message.ts';
const centralCt='919000000004',tl='919000000001',clm='919000000002';
function fixture(){
 const query={select(){return this},eq(){return this},gte(){return this},ilike(){return this},order(){return this},limit:async()=>({data:[],error:null})};
 const deps={
 './lm-cod-workflow-data':{loadCodWorkflow:async()=>({sections:[{key:'prepare',title:'Prepare Deposit pending',columns:['Cash'],rows:[['₹8,523.42']],owner:'team',action:'Click Prepare Deposit now. Reminders continue until completed.'}],slips:[{key:'s',code:'AC1',amount:500,at:1}],bankRows:[],acks:[],shortAcks:[]})},
 './lm-cod-runtime':{},'./lm-cod-journeys':{},
 './lm-cod-workflow':{codMoney:String,codClock:String},
 './lm-dispatch-mentions':{resolveBankReminderMentions:async(_c,_s,route)=>{assert.deepEqual(route.mentions,[centralCt]);return {tl:[tl],ct:route.mentions,cluster:[clm],aom:[]}},resolveRouteMentionNumbers:async()=>[]},
 './lm-bank-message':bank,'./lm-cod-alerts':{},'./lm-report-image':{codSectionsPng:async()=>'image'},'./settings':{reportBotDb:()=>({from:()=>query})}
 };
 const module={exports:{}};
 const js=ts.transpileModule(fs.readFileSync(new URL('./lm-cod-workflow-output.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',js)(key=>deps[key],module,module.exports);
 return module.exports.codWorkflowOutputs;
}
test('combined COD preserves explicitly configured CT and station CLM tags; slip tags TL only',async()=>{
 const outputs=await fixture()('C',{id:'S',station_code:'KTUO'},'2026-11-12','10:00',{group_id:'G',mentions:[centralCt]},{});
 assert.deepEqual(outputs[0].body.mentions,[tl,centralCt,clm].map(n=>n+'@s.whatsapp.net'));
 assert.match(outputs[0].body.caption,new RegExp('FYI: CT @'+centralCt+' · Cluster Manager @'+clm));
 assert.deepEqual(outputs[1].body.mentions,[tl+'@s.whatsapp.net']);
});
