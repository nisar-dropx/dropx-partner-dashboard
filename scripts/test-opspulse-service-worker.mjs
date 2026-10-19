import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
function setup(fetcher=async()=>new Response('live')) {
 const handlers={},deleted=[],writes=[];
 const fallback=new Response('Reconnect');
 const cache={addAll:async()=>{},put:async(...v)=>writes.push(v)};
 const caches={open:async()=>cache,match:async key=>key==='/opspulse/offline.html'?fallback:undefined,keys:async()=>['another-product','dropx-opspulse-static-v2','dropx-opspulse-static-v3'],delete:async key=>deleted.push(key)};
 const self={location:{origin:'https://ops.dropxlogistics.com'},clients:{claim:async()=>{}},skipWaiting:async()=>{},addEventListener:(name,fn)=>handlers[name]=fn};
 vm.runInNewContext(script,{self,caches,fetch:fetcher,URL,Response});
 return {deleted,writes,handlers,request(path,options={}) {let response;handlers.fetch({request:{method:'GET',mode:'navigate',url:`https://ops.dropxlogistics.com${path}`,...options},respondWith:r=>response=r});return response;}};
}
test('navigation always reads live HTML and never stores private pages',async()=>{const s=setup();assert.equal(await (await s.request('/cod/status')).text(),'live');assert.equal(s.writes.length,0)});
test('offline navigation gets only a generic recovery screen',async()=>{const s=setup(async()=>{throw Error('offline')});assert.equal(await (await s.request('/payments/approvals')).text(),'Reconnect');assert.equal(s.writes.length,0)});
test('POST submissions and API/RSC requests are not intercepted or queued',()=>{const s=setup();assert.equal(s.request('/audits',{method:'POST'}),undefined);assert.equal(s.request('/api/records',{mode:'cors'}),undefined);assert.equal(s.request('/cod/status?_rsc=1',{mode:'cors'}),undefined)});
test('activation removes only retired OpsPulse caches',async()=>{const s=setup();let pending;s.handlers.activate({waitUntil:p=>pending=p});await pending;assert.deepEqual(s.deleted,['dropx-opspulse-static-v2'])});
