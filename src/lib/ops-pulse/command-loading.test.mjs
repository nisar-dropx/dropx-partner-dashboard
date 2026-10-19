import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const element=(type,props,key)=>({type,props,key});
const runtime={jsx:element,jsxs:element,Fragment:'fragment'};
function compile(path,mocks={}) {
 const m={exports:{}};
 const code=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 new Function('require','exports','module',code)(name=>{if(name==='react/jsx-runtime')return runtime;if(name in mocks)return mocks[name];throw Error(name);},m.exports,m);
 return m.exports;
}
function descendants(node){if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(descendants)];}

test('Last Mile heading, controls and checks render while the CPS snapshot is still pending',async()=>{
 const auth={locationScopeIds:['a'],hasAllLocationAccess:false};
 const locations=[{id:'a',station_code:'A'}];const period={from:'2026-10-01',to:'2026-10-15',days:15};
 let costStarted=0;
 const mod=compile('../../app/ops-pulse/page.tsx',{
  'react':{Suspense:'Suspense'},'next/link':'Link','@/components/app-shell':{AppShell:'Shell'},'@/components/page-head':{PageHead:'PageHead'},
  '@/components/ops-command-date-range':{OpsCommandDateRange:'DateRange'},'@/components/ops-command-attention':{OpsCommandAttention:'Attention'},'@/components/ops-station-manpower-board':{OpsStationManpowerBoard:'People'},'@/components/ops-command-center':{OpsCommandCenter:'Snapshots'},
  '@/lib/authorization':{requirePagePermission:async()=>auth,hasPermission:()=>true},'@/lib/company-scope':{requireCompanyId:()=> 'company'},
  '@/lib/ops-pulse/cod':{loadCodLocations:async()=>({locations}),todayKolkata:()=> '2026-10-16'},
  '@/lib/ops-pulse/operating-context':{resolveOperatingContext:()=>({mode:'amazon_edsp',selectedLocations:locations}),operatingModeLabel:()=> 'Amazon EDSP'},
  '@/lib/ops-pulse/cps':{cpsPeriod:()=>period},'@/lib/ops-pulse/command-center-data':{loadCommandCenter:()=>{costStarted++;return new Promise(()=>{});}},
  '@/lib/ops-pulse/command-center':{commandMetricAttention:()=>[]},'@/lib/ops-pulse/station-manpower':{},'@/lib/ops-pulse/edd-access':{hasEddAccess:()=>true},
  './dark-store-home':{DarkStoreHome:'DS',CommandLoading:'Loading'},'./command-center.module.css':{}
 });
 const page=await mod.default({});
 const content=descendants(page).find(node=>typeof node.type==='function');
 const rendered=content.type(content.props);
 assert.equal(typeof rendered?.then,'undefined','page content must not await the cost engine');
 const nodes=descendants(rendered);
 assert(nodes.some(node=>node.type==='h1'&&node.props.children==='Last Mile command center'));
 assert(nodes.some(node=>node.type==='Attention'&&node.props.extraItems instanceof Promise));
 assert(nodes.some(node=>node.type==='DateRange'&&node.props.from===period.from&&node.props.to===period.to));
 assert.equal(costStarted,1,'share a single snapshot across cost cards and priority flags');
 assert(nodes.filter(node=>node.type==='Link').every(node=>node.props.prefetch===false));
});

test('background refresh is age-gated, visible-only, single-flight and cleaned up',()=>{
 const effects=[],listeners=new Map(),refs=[];
 let timer,now=1000,pending=false,refreshes=0,transition;
 const saved={document:globalThis.document,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval,now:Date.now};
 globalThis.document={visibilityState:'visible',addEventListener:(k,cb)=>listeners.set(k,cb),removeEventListener:k=>listeners.delete(k)};
 globalThis.setInterval=cb=>{timer=cb;return 1;};globalThis.clearInterval=()=>{timer=null;};Date.now=()=>now;
 try {
  const mod=compile('../../components/ops-command-refresh.tsx',{
   react:{useEffect:cb=>effects.push(cb),useRef:value=>{const ref={current:value};refs.push(ref);return ref;},useTransition:()=>[pending,cb=>{transition=cb;cb();}]},
   'next/navigation':{useRouter:()=>({refresh:()=>refreshes++})}
  });
  mod.OpsCommandRefresh();const cleanup=effects.map(effect=>effect()).filter(Boolean);
  listeners.get('visibilitychange')();assert.equal(refreshes,0);
  now+=90000;document.visibilityState='hidden';timer();assert.equal(refreshes,0);
  document.visibilityState='visible';listeners.get('visibilitychange')();assert.equal(refreshes,1);assert(transition);
  now+=90000;timer();listeners.get('visibilitychange')();assert.equal(refreshes,1,'do not overlap an unfinished refresh');
  cleanup.forEach(fn=>fn());assert.equal(listeners.size,0);assert.equal(timer,null);
 }finally{globalThis.document=saved.document;globalThis.setInterval=saved.setInterval;globalThis.clearInterval=saved.clearInterval;Date.now=saved.now;}
});

test('Command Center sidebar disables both top-level and submenu preloads',()=>{
 const mod=compile('../../components/sidebar-nav.tsx',{
  react:{useCallback:fn=>fn,useEffect:()=>{},useRef:()=>({current:{}}),useState:value=>[value,()=>{}]},
  '@/components/ops-design-context':{useOpsDesign:()=>false}, '@/components/ops-design-navigation':{OpsDesignNavigation:'ModernNav'},
  '@/components/icons':{Icon:'Icon'},'@/components/payment-notification-provider':{PaymentNavBadge:'Badge'},'@/components/pending-link':{PendingLink:'Link'}
 });
 const node=mod.SidebarNav({active:'Command Center',prefetch:false,items:[{label:'Command Center',href:'/ops-pulse'},{label:'Payments',children:[{label:'Approvals',href:'/payments/approvals'}]}]});
 const links=descendants(node).filter(node=>node.type==='Link');
 assert.equal(links.length,2);assert(links.every(node=>node.props.prefetch===false));
 const shell=readFileSync(new URL('../../components/app-shell.tsx',import.meta.url),'utf8');
 assert.match(shell,/prefetch=\{!\(isOpsHost && pageCode === "ops_pulse"\)\}/);
});
