// Local UI QA only. Explicit synthetic fixtures; never reads or writes production.
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup,renderToString} from 'react-dom/server';
const require=createRequire(import.meta.url);
const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const transpile=(s,fileName='view.tsx')=>ts.transpileModule(`import * as React from 'react';\n${s}`,{fileName,compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const styleMap=new Proxy({},{get:(_t,k)=>k==='__esModule'?false:String(k)});
const Link=({children,prefetch,...props})=>React.createElement('a',props,children);
const mods={'react':React,'next/link':Link,'lucide-react':require('lucide-react'),'@/app/ops-pulse/command-center.module.css':styleMap};
function compile(path,mocks={}){const m={exports:{}};new Function('require','exports','module',transpile(read(path),path))(n=>{if(n in mocks)return mocks[n];if(n in mods)return mods[n];throw Error(`Unmocked ${n}`);},m.exports,m);return m.exports;}
mods['./cps']=compile('src/lib/ops-pulse/cps.ts');
mods['./hawkeye']=compile('src/lib/ops-pulse/hawkeye.ts');
mods['./performance-source-policy']=compile('src/lib/ops-pulse/performance-source-policy.ts');
mods['@/lib/ops-pulse/command-center']=compile('src/lib/ops-pulse/command-center.ts');
const period={from:'2026-10-01',to:'2026-10-14',days:14};
const places=[{code:'LM01',name:'North station',owner:'Example manager A'},{code:'XP01',name:'North satellite',parent:'LM01',isXpt:true,owner:'Example manager A'},{code:'LM02',name:'City station',owner:'Example manager B'},{code:'LM03',name:'South station',owner:'Example manager C'}];
const daily=places.flatMap((p,i)=>Array.from({length:i===3?12:14},(_,n)=>{const delivered=150+i*40+(n%4)*17,total=delivered*(18+i*2);return {station_code:p.code,work_date:`2026-10-${String(n+1).padStart(2,'0')}`,deliveries:delivered,c_return:10,activity:delivered+10,associate_rows:5,unmapped:0,unpaid:0,da:total*.6,utr:total*.15,van:total*.1,rent:total*.08,overhead:total*.02,other:total*.05,total,target:i===2?null:18,shipment_present:true,utr_configured:true};}));
const performance=places.map(p=>({id:p.code,batch_id:'qa',source_type:'amazon_hawkeye_daily',report_date:period.to,created_at:'2026-10-15T00:00:00Z',station_code:p.code,values_json:{metrics:{'AFN Std PDD DSR%':p.code==='LM02'?82:98}}}));
const model=mods['@/lib/ops-pulse/command-center'].buildCommandCenter({snapshot:{daily,breakup:[],gaps:[{station_code:'LM03',first_date:period.from,last_date:period.to}],source_dates:{shipments:period.to,fuel:period.to,cashbook:'2026-10-13'}},places,period,performance,targets:[{metricKey:'dsr',target:.95,direction:'higher',isActive:true}],reviews:[{id:'r1',station_code:'LM02'},{id:'r2',station_code:'LM03'}],performanceDate:period.to});
const props={model,period,codes:places.map(p=>p.code),canCost:true,canCostAttention:true,canPerformance:true,canReview:true,performanceDate:period.to,errors:[]};
const lm=compile('src/components/ops-command-center.tsx');
const attentionFixture=[
 {key:'audits',title:'Audits',value:'3 to action',detail:'1 overdue · 1 due today · 1 follow-up · 2 next 7 days',action:'Open my audit queue',href:'#',tone:'urgent'},
 {key:'cod',title:'COD daily controls',value:'2 stations to check',detail:'1 overdue update · 1 verification pending · deposit date 14 Oct',action:'Review COD updates',href:'#',tone:'urgent'},
 {key:'people',title:'Shift readiness',value:'2 locations to check',detail:'3 not reported · 1 punch-out · 0 shift times missing',action:'Check today’s shifts',href:'#',tone:'action'},
 {key:'payments',title:'Your payment approvals',value:'2 pending',detail:'Assigned to you · across authorized LM + DS locations',action:'Open approval inbox',href:'#',tone:'action'},
 {key:'vehicles',title:'Vehicle confirmations',value:'0 vehicle-days',detail:'0 overdue · 0 today · daily assignment confirmations',action:'Open mappings',href:'#',tone:'clear'},
 {key:'documents',title:'Location documents',value:'0 renewals',detail:'0 expired · 0 due within 30 days',action:'Review documents',href:'#',tone:'clear'}
];
const attentionDomain=compile('src/lib/ops-pulse/command-attention.ts',{'./station-audit-planning':compile('src/lib/ops-pulse/station-audit-planning.ts')});
const attention=compile('src/components/ops-command-attention.tsx',{'@/lib/ops-pulse/command-attention-data':{loadCommandAttention:async()=>attentionFixture},'@/lib/ops-pulse/command-attention':attentionDomain,'./ops-command-refresh':{OpsCommandRefresh:()=>null},'./ops-command-attention.module.css':styleMap});
mods['@/components/ops-command-attention']={OpsCommandAttention:({extraItems=[]})=>React.createElement(attention.CommandAttentionView,{items:attentionDomain.attentionOrder([...attentionFixture.filter(i=>!['cod','people','vehicles'].includes(i.key)),...extraItems]),today:'2026-10-15'})};
const jsx=(name,props,...children)=>React.createElement(name,props,...children);
function header(){return jsx('header',{className:'hero'},jsx('div',null,jsx('p',{className:'eyebrow'},'LM · AMAZON EDSP · 4 SELECTED LOCATIONS'),jsx('h1',null,'Last Mile command center'),jsx('p',null,'Shipment economics, station priorities and your next action.')),jsx('form',{className:'dateForm'},jsx('label',null,'From',jsx('input',{type:'date',defaultValue:period.from})),jsx('label',null,'Through',jsx('input',{type:'date',defaultValue:period.to})),jsx('button',{type:'button'},'Refresh')));}
const toolbar=jsx(React.Fragment,null,jsx('nav',{className:'tools'},...['Review Desk','Shift attendance','Capacity','Workforce','COD workspace','Live delivery view'].map(x=>jsx('a',{key:x,href:'#'},x+' ↗'))),jsx('style',null,read('src/components/ops-command-attention.module.css')),jsx(attention.CommandAttentionView,{items:attentionFixture,today:'2026-10-15'}));
const definitions=[['./cps','src/lib/ops-pulse/cps.ts'],['./hawkeye','src/lib/ops-pulse/hawkeye.ts'],['./performance-source-policy','src/lib/ops-pulse/performance-source-policy.ts'],['@/lib/ops-pulse/command-center','src/lib/ops-pulse/command-center.ts'],['view','src/components/ops-command-center.tsx']];
const client=`const modules={'react':React,'next/link':({children,prefetch,...p})=>React.createElement('a',p,children),'lucide-react':LucideReact,'@/app/ops-pulse/command-center.module.css':new Proxy({},{get:(_t,k)=>k==='__esModule'?false:String(k)})};const factories={${definitions.map(([id,path])=>`${JSON.stringify(id)}:(require,exports,module)=>{${transpile(read(path),path)}}`).join(',')}};function req(n){if(n in modules)return modules[n];const m={exports:{}};factories[n](req,m.exports,m);return modules[n]=m.exports;}ReactDOM.hydrateRoot(document.getElementById('lm-view'),React.createElement(req('view').OpsCommandCenter,${JSON.stringify(props)}));`;
async function darkStoreMarkup(){
 const ds=compile('src/lib/ops-pulse/ds-command-center.ts');
 const locations=[{id:'s1',station_code:'DS01',station_name:'City Centre',city:'Chennai'},{id:'s2',station_code:'DS02',station_name:'West Market',city:'Chennai'}];
 const people={active:20,reported:15,working:12,completed:3,due:18,dueReported:15,notReported:3,upcoming:2,off:0,leave:0,unplanned:0,missingOut:1};
 const stores=locations.map((l,i)=>({...l,id:l.id,code:l.station_code,name:l.station_name,people:i?{...people,notReported:0,reported:18,dueReported:18}:people,units:i?{units:null,status:'missing',through:null}: {units:24000,status:'current',through:'2026-10-14',upd:1714}}));
 const mocks={'./dark-store-home.module.css':styleMap,'next/navigation':{useRouter:()=>({push:()=>{},refresh:()=>{}})},'@/components/app-shell':{AppShell:({children})=>children},'@/lib/authorization':{hasPermission:()=>true},'@/lib/ops-pulse/cod':{todayKolkata:()=> '2026-10-15'},'@/lib/finance/pricing':{validMonth:()=>true},'@/lib/date-format':{formatDashboardDate:x=>x},'@/lib/ops-pulse/date-format':{formatOpsDate:x=>x,formatOpsDateTime:x=>x},'@/lib/ops-pulse/ds-command-center':ds,'@/lib/ops-pulse/ds-command-data':{loadDsCommandData:async()=>({stores,canPeople:true,canUnits:true,peopleError:false,unitError:false,expectedThrough:'2026-10-14'}),loadDsApprovals:async()=>({payment:{count:2},rosterCount:1})},'@/lib/ops-pulse/dark-store':{loadCpu:async()=>({rows:locations.map((l,i)=>({code:l.station_code,units:i?null:24000,cost:i?45000:48000,days:14,through:'2026-10-14',cpu:i?null:2}))})}};
 mocks['./dark-store-controls']=compile('src/app/ops-pulse/dark-store-controls.tsx',mocks);
 const module={exports:{}};
 new Function('require','exports','module',transpile(read('src/app/ops-pulse/dark-store-home.tsx')+'\nexport {StoreCommand,StoreEconomics};'))(n=>n in mocks?mocks[n]:mods[n],module.exports,module);
 async function resolve(node){if(!React.isValidElement(node))return Array.isArray(node)?await Promise.all(node.map(resolve)):node;if(typeof node.type==='function'&&node.type.constructor.name==='AsyncFunction')return resolve(await node.type(node.props));if(node.type===React.Suspense)return resolve(node.props.children);return React.cloneElement(node,{},...await Promise.all(React.Children.toArray(node.props.children).map(resolve)));}
 return renderToStaticMarkup(jsx(React.Fragment,null,jsx('style',null,read('src/components/ops-command-attention.module.css')),await resolve(module.exports.DarkStoreHome({authorization:{},locations,searchParams:{month:'2026-10'}}))));
}
const vendor={
 '/react.js':join(dirname(require.resolve('react/package.json')),'umd/react.production.min.js'),
 '/react-dom.js':join(dirname(require.resolve('react-dom/package.json')),'umd/react-dom.production.min.js'),
 '/icons.js':join(dirname(require.resolve('lucide-react/package.json')),'dist/umd/lucide-react.min.js')
};
createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;if(vendor[path]){res.writeHead(200,{'content-type':'text/javascript'});return res.end((path==='/icons.js'?'window.react=window.React;\n':'')+readFileSync(vendor[path],'utf8'));}if(path==='/client.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(client);}const dark=path==='/dark-store';const content=dark?await darkStoreMarkup():renderToString(jsx('main',{className:'command'},header(),toolbar,jsx('div',{id:'lm-view'},jsx(lm.OpsCommandCenter,props))));res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpsPulse — local design QA</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f7fa;font-family:Arial,sans-serif}.qa{padding:10px 24px;background:#fff1c5;color:#604411;font-size:12px;display:flex;gap:20px;flex-wrap:wrap}.qa a{color:#604411}${read(dark?'src/app/ops-pulse/dark-store-home.module.css':'src/app/ops-pulse/command-center.module.css')}</style></head><body><div class="qa"><b>LOCAL PREVIEW · SYNTHETIC TEST DATA · NOT LIVE</b><a href="/">Last Mile</a><a href="/dark-store">Dark Store</a></div>${content}${dark?'':'<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/icons.js"></script><script src="/client.js"></script>'}</body></html>`);}catch(e){res.writeHead(500);res.end(String(e.stack));}}).listen(4319,'127.0.0.1',()=>console.log('Synthetic UI QA: http://127.0.0.1:4319'));
