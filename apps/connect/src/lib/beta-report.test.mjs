import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { betaReportUrl, readBetaPdf } from './beta-report.ts';
test('report source is restricted to the observed IDfy PDF store',()=>{
 assert.equal(betaReportUrl('https://storage.googleapis.com/example/report.pdf?token=example'),'https://storage.googleapis.com/example/report.pdf?token=example');
 for(const url of ['http://storage.googleapis.com/x','https://storage.googleapis.com.evil.test/x','https://user@storage.googleapis.com/x','https://storage.googleapis.com:444/x','http://127.0.0.1/x'])assert.equal(betaReportUrl(url),null);
});
test('report download rejects HTML, disguised bytes and oversized documents',async()=>{
 assert.equal((await readBetaPdf(new Response('%PDF-example',{headers:{'content-type':'application/pdf'}}))).length,12);
 for(const response of [new Response('<html/>',{headers:{'content-type':'text/html'}}),new Response('not PDF',{headers:{'content-type':'application/pdf'}}),new Response('%PDF-example',{headers:{'content-type':'application/pdf','content-length':String(30*1024*1024)}})])await assert.rejects(readBetaPdf(response));
});
function fixture({foreign=false,source='https://storage.googleapis.com/example/report.pdf',authError=false}={}){
 const mocks={'next/server':{NextResponse:{json:(body,opts)=>Response.json(body,opts)}},'@/lib/beta-private-account':{requireBetaPrivateAccount:async()=>{if(authError)throw Error();return {account:{id:'own'},candidate:{alias_email:'own@example.test'}}}},'@/lib/beta-report':{betaReportUrl,readBetaPdf}};
 const module={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(new URL('../../app/api/connect/beta-idfy-report/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>mocks[id],module,module.exports);
 let calls=0;return {GET:module.exports.GET,fetch:async()=>{calls++;return calls===1?Response.json({candidateId:foreign?'other':'own',email:'own@example.test',profileId:'123',reportUrl:source}):new Response('%PDF-example',{headers:{'content-type':'application/pdf'}})},calls:()=>calls};
}
test('download verifies candidate before requesting PDF; unauthorized accounts never call worker',async()=>{
 const original=global.fetch;process.env.WORKFORCE_AMAZON_WORKER_URL='https://worker.example';process.env.WORKFORCE_AMAZON_WORKER_KEY='test';
 try{
  for(const options of [{foreign:true},{source:'http://127.0.0.1/private'},{authError:true},{}]){
   const f=fixture(options);global.fetch=f.fetch;const r=await f.GET({});assert.equal(r.status,options.authError?403:options.foreign||options.source?503:200);assert.equal(f.calls(),options.authError?0:options.foreign||options.source?1:2);
   if(r.status===200){assert.match(r.headers.get('content-disposition'),/attachment/);assert.match(r.headers.get('cache-control'),/private, no-store/);}
  }
 }finally{global.fetch=original;delete process.env.WORKFORCE_AMAZON_WORKER_URL;delete process.env.WORKFORCE_AMAZON_WORKER_KEY;}
});
