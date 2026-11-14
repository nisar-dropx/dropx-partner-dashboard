import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as rules from './lm-high-value-exceptions.ts';
import * as value from './lm-high-value.ts';
import {CodRuntime} from './lm-cod-runtime.ts';
import {requireReportFreshness} from './lm-live-report.ts';

function fixture(){
 const day=new Date(Date.now()+19800000).toISOString().slice(0,10),cache=new Map();
 let updated=new Date().toISOString(),state='HELD',calls=0,queued=0;
 const row=()=>({stationCode:'JUGF',trackingId:'375149438442',shipmentValue:5000,paymentMethod:'PREPAID',state,lastUpdatedAt:updated,driverId:'',driverName:'',edd:day});
 const module={exports:{}};
 const dependencies={
  'server-only':{}, './lm-high-value':value,'./lm-high-value-exceptions':rules,'./lm-live-report':{requireReportFreshness},
  './lm-cod-runtime':{CodRuntime},
  '@/lib/ops-pulse/edd-worker':{
   fetchLoadFlashBoard:async()=>({stations:[{stationCode:'JUGF',businessDate:day,hasSnapshot:true,fetchedAt:updated,board:{highValueVersion:2}}]}),
   fetchLoadFlashTracking:async()=>[row()],queueLoadFlashStations:async()=>{queued++;}
  },
  './lm-cod-journeys':{codCacheGet:async(c,l,d,k)=>cache.get([c,l,d,k].join(':')),codCachePut:async(c,l,d,k,v)=>cache.set([c,l,d,k].join(':'),v)},
  './lm-report-image':{tableReportSvg:async(title,columns,rows)=>JSON.stringify({title,columns,rows}),reportPngBase64:async svg=>Buffer.from(svg).toString('base64')}
 };
 const fetch=async()=>{calls++;return {ok:true,json:async()=>({status:'ok',trackingId:row().trackingId,stationCode:'JUGF',packageStatus:state,lastUpdatedTime:updated,customerName:'PRIVATE',history:[{state:'INDUCTED',time:new Date(Date.now()-4*86400000).toISOString(),source:'JUGF'}]})};};
 const js=ts.transpileModule(fs.readFileSync(new URL('./lm-high-value-output.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports','fetch','process',js)(name=>{assert.ok(name in dependencies,name);return dependencies[name];},module,module.exports,fetch,{env:{EDD_WORKER_URL:'https://source.invalid',EDD_WORKER_ADMIN_KEY:'test'}});
 const context={company:'C',locations:new Map([['JUGF','L']]),runtime:new CodRuntime(Date.now()+90000)};
 return {run:(regional=false)=>module.exports.highValueOutputs(['JUGF'],day,'23:00',regional,5000,['919999999999'],context),cache,counts:()=>({calls,queued}),change:(s,t=new Date().toISOString())=>{state=s;updated=t;}};
}
test('fresh exception produces a data image, precise caption and tags; repeated lookup is cached without customer data',async()=>{
 const f=fixture(); const result=await f.run();assert.equal(result.rows.length,1);assert.equal(result.outputs.length,1);
 assert.match(result.outputs[0].body.caption,/escalation.*1 shipment.*5,000.00/);
 assert.match(result.outputs[0].body.caption,/375149438442 · ₹5,000.00/);
 assert.match(result.outputs[0].body.caption,/No dispatch \/ attempt/);
 assert.deepEqual(result.outputs[0].body.mentions,['919999999999@s.whatsapp.net']);
 assert.match(Buffer.from(result.outputs[0].body.image_base64,'base64').toString(),/375149438442/);
 await f.run();assert.equal(f.counts().calls,1);assert.doesNotMatch(JSON.stringify([...f.cache.values()]),/PRIVATE|customerName/);
 f.change('DELIVERED');assert.equal((await f.run()).outputs.length,0);assert.equal(f.counts().calls,1);
});
test('updated scan refreshes evidence, stale board queues refresh, regional alerts are rejected',async()=>{
 const f=fixture();await f.run();f.change('DELIVERY_FAILED');await f.run();assert.equal(f.counts().calls,2);
 f.change('HELD',new Date(Date.now()-3600000).toISOString());await assert.rejects(f.run(),/Waiting for high-value source refresh/);assert.equal(f.counts().queued,1);
 await assert.rejects(f.run(true),/war-room reports only/);
});
