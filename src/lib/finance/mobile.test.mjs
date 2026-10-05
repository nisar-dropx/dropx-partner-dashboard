import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
function compile(path,mocks={}){const m={exports:{}};new Function('require','exports','module',ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(id=>id in mocks?mocks[id]:require(id),m.exports,m);return m.exports;}
const {PnlInsights}=compile('../../app/finance/business/pnl-insights.tsx');
const total={revenue:2000,cost:1500,da:700,utr:300,van:200,rent:200,other:100};
test('charts use report values and exclude dates without delivered data',()=>{
 const html=renderToStaticMarkup(React.createElement(PnlInsights,{total,daily:[{key:'2026-10-01',deliveries:100,revenue:2000,cost:1500,profit:500},{key:'2026-10-02',deliveries:null,revenue:null,cost:null}]}));
 assert.match(html,/₹2,000/);assert.match(html,/₹1,500/);assert.match(html,/₹500/);assert.match(html,/46.7%/);assert.doesNotMatch(html,/2 Oct/);assert.doesNotMatch(html,/NaN/);
});
test('empty trends and expense credits are explicitly explained',()=>{
 const empty=renderToStaticMarkup(React.createElement(PnlInsights,{total:{...total,cost:0,da:0,utr:0,van:0,rent:0,other:0},daily:[]}));assert.match(empty,/when delivery reports are available/);assert.doesNotMatch(empty,/NaN|Infinity/);
 const credit=renderToStaticMarkup(React.createElement(PnlInsights,{total:{...total,other:-50},daily:[]}));assert.match(credit,/Credits are included/);assert.doesNotMatch(credit,/stroke-dasharray/);
});
test('offline worker does not cache finance responses or intercept mutations/API requests',async()=>{
 const listeners={},cached=[];let network=0,fallback=0;
 const response={ok:true};
 runInNewContext(read('../../../public/finance-sw.js'),{URL,Response,self:{location:{origin:'https://fin.dropxlogistics.com'},addEventListener:(name,handler)=>listeners[name]=handler,skipWaiting(){},clients:{claim:async()=>{}}},caches:{open:async()=>({add:async path=>cached.push(path)}),keys:async()=>[],match:async()=>{fallback++;return response;}},fetch:async()=>{network++;return response;}});
 await new Promise(resolve=>listeners.install({waitUntil:p=>p.then(resolve)}));assert.deepEqual(cached,['/finance-app/offline.html']);
 for(const request of [{method:'POST',mode:'navigate',url:'https://fin.dropxlogistics.com/payments'},{method:'GET',mode:'cors',url:'https://fin.dropxlogistics.com/finance/business/details'}]) listeners.fetch({request,respondWith(){throw Error('private request intercepted');}});
 let pending;listeners.fetch({request:{method:'GET',mode:'navigate',url:'https://fin.dropxlogistics.com/finance'},respondWith:p=>pending=p});assert.equal(await pending,response);assert.equal(network,1);assert.equal(fallback,0);assert.equal(cached.length,1);
});
test('Finance asset links never inherit the OpsPulse Android identity',async()=>{
 let host='fin.dropxlogistics.com';
 const {GET}=compile('../../app/.well-known/assetlinks.json/route.ts',{'next/headers':{headers:()=>({get:()=>host})},'@/lib/finance/surface':{isFinanceHostName:h=>h==='fin.dropxlogistics.com'}});
 let result=await GET().json();assert.equal(result[0].target.package_name,'com.dropxlogistics.finance');assert.equal(result[0].target.sha256_cert_fingerprints[0],'6A:4C:F6:3F:65:D7:2E:DB:74:A0:38:19:93:AB:67:AB:9B:2D:D9:37:34:54:E4:0B:59:8C:6E:6B:C2:EF:AB:B0');
 host='ops.dropxlogistics.com';result=await GET().json();assert.equal(result[0].target.package_name,'com.dropxlogistics.opspulse');
});
test('published release matches the signed APK and Finance install identity',()=>{
 const {financeAndroidRelease:release}=compile('./android-release.ts');
 const apk=readFileSync(new URL('../../../public'+release.path,import.meta.url));assert.equal(createHash('sha256').update(apk).digest('hex'),release.sha256);
 const manifest=JSON.parse(read('../../../public/finance-app/manifest.webmanifest'));assert.equal(manifest.display,'standalone');assert.equal(manifest.id,'https://fin.dropxlogistics.com/');assert.ok(manifest.icons.some(i=>i.purpose==='maskable'));
 const android=read('../../../apps/dropx-finance-android/app/src/main/AndroidManifest.xml');assert.match(android,/usesCleartextTraffic="false"/);assert.doesNotMatch(android,/ACCESS_FINE_LOCATION|CAMERA|READ_CONTACTS|POST_NOTIFICATIONS/);
});
test('anonymous installs can read the manifest while financial pages still require sign-in',async()=>{
 const {NextRequest}=require('next/server');
 const {middleware}=compile('../../middleware.ts',{
  '@/lib/people/surface':{isPeopleHostName:()=>false,isPeoplePortalPath:()=>false},
  '@/lib/finance/surface':compile('./surface.ts'),
  '@/lib/provider-mapping-host':{providerMappingPageCodeForHost:()=>null},
  '@/lib/timeout-fetch':{timeoutFetch:()=>fetch},
  '@/lib/with-timeout':{TimeoutError:class extends Error{},withTimeout:p=>p},
  '@supabase/supabase-js':{createClient:()=>({auth:{getUser:async()=>({data:{user:null},error:null})}})}
 });
 for(const path of ['/finance-app/manifest.webmanifest','/finance-sw.js','/downloads/DropX-Finance-1.0.0.apk']){
  const response=await middleware(new NextRequest('https://fin.dropxlogistics.com'+path,{headers:{host:'fin.dropxlogistics.com'}}));
  assert.equal(response.status,200,path);assert.equal(response.headers.get('location'),null,path);
 }
 const page=await middleware(new NextRequest('https://fin.dropxlogistics.com/finance',{headers:{host:'fin.dropxlogistics.com'}}));
 assert.equal(page.status,307);assert.match(page.headers.get('location'),/\/login/);
});
