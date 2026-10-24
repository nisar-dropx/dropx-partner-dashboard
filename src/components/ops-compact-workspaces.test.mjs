import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const jsx=(type,props)=>({type,props});
const nodes=n=>!n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(nodes)];
function mount(file,exportName,props,extra={}){
 const values=[];let cursor=0,tree;const pushes=[];
 const hooks={useId:()=> 'controls-id',useState:v=>{const i=cursor++;if(!(i in values))values[i]=v;return [values[i],x=>values[i]=typeof x==='function'?x(values[i]):x]},useEffect:()=>{},useMemo:fn=>fn(),useRef:v=>({current:v}),useTransition:()=>[false,fn=>fn()],createContext:()=>({}),useContext:()=>()=>{}};
 const router={push:(url,options)=>pushes.push({url,options})};
 const mocks={'react':hooks,'react/jsx-runtime':{jsx,jsxs:jsx},'lucide-react':new Proxy({},{get:()=> 'svg'}),'next/link':'a','@/lib/ops-pulse/command-attention':{attentionOrder:x=>x},'@/lib/ops-pulse/date-format':{formatOpsDate:v=>v??'-',formatOpsDateTime:v=>v??'-'},'next/navigation':{useRouter:()=>router,usePathname:()=>'/payments/approvals',useSearchParams:()=>new URLSearchParams('view=scope&status=pending&page=3')},...extra};
 const m={exports:{}};const code=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 new Function('require','exports','module',code)(id=>id.endsWith('.css')?{__esModule:true,default:new Proxy({},{get:(_,key)=>key})}:mocks[id],m.exports,m);
 return {pushes,render(){cursor=0;tree=m.exports[exportName](props);return tree},get tree(){return tree}};
}
test('mobile filter disclosure preserves unsaved multi-selections and scope when applied',()=>{
 const h=mount('./payment-approval-filters.tsx','PaymentApprovalFilters',{search:'',status:'pending',oversight:true,stationOptions:[],paymentHeadOptions:[],dateOptions:[],selectedStations:[],selectedPaymentHeads:[],selectedDates:[]});
 let tree=h.render();const toggle=()=>nodes(h.tree).find(n=>n.props.className?.includes('payment-mobile-filter-toggle'));
 assert.equal(toggle().props['aria-expanded'],false);toggle().props.onClick();tree=h.render();
 nodes(tree).find(n=>n.props.label==='Stations').props.onChange(['ST01','ST02']);h.render();
 toggle().props.onClick();h.render();toggle().props.onClick();tree=h.render();
 assert.deepEqual(nodes(tree).find(n=>n.props.label==='Stations').props.selectedValues,['ST01','ST02']);
 const apply=nodes(tree).find(n=>n.props['aria-label']==='Apply station, payment head, and date filters');assert.equal(apply.props.disabled,false);apply.props.onClick();
 const url=new URL(h.pushes[0].url,'https://example.test');assert.equal(url.searchParams.get('view'),'scope');assert.deepEqual(url.searchParams.getAll('station'),['ST01','ST02']);assert.equal(url.searchParams.has('page'),false);
});
test('compact priorities keep every authorized link and toggle details without replacing queues',()=>{
 const items=Array.from({length:14},(_,i)=>({key:String(i),tone:'urgent',title:'Queue '+i,value:'3 pending',detail:'Explanation',action:'Review',href:'/queue/'+i}));
 const h=mount('./ops-command-attention-live.tsx','CommandAttentionView',{items,today:'2026-10-20'});let tree=h.render();
 assert.equal(tree.props['data-details'],false);assert.equal(nodes(tree).filter(n=>n.type==='a').length,14);
 nodes(tree).find(n=>n.props.className==='showAll').props.onClick();tree=h.render();assert.equal(tree.props['data-all'],true);
 nodes(tree).find(n=>n.props.className==='detailToggle').props.onClick();tree=h.render();assert.equal(tree.props['data-details'],true);assert.equal(nodes(tree).filter(n=>n.type==='a').length,14);
});
test('priority station filter defaults to all stations and keeps the date range when applied',()=>{
 const items=[{key:'audits',tone:'action',title:'Audits',value:'2 to action',detail:'Detail',action:'Review',href:'/audits'}];
 const stations=[{code:'KOZA',name:'Kochi'},{code:'BLRA',name:'Bangalore'}];
 const h=mount('./ops-command-attention-live.tsx','CommandAttentionView',{items,today:'2026-10-20',stations,station:'',range:{from:'2026-10-01',to:'2026-10-19'}});
 let tree=h.render();
 const select=nodes(tree).find(n=>n.type==='select');
 assert.equal(select.props.value,'');
 assert.equal(select.props.children[0].props.value,'');
 assert.equal(select.props.children[0].props.children,'All stations');
 assert.ok(nodes(tree).find(n=>n.props.className==='detailToggle'));
 select.props.onChange({target:{value:'KOZA'}});tree=h.render();
 assert.equal(h.pushes[0].url,'/ops-pulse?from=2026-10-01&to=2026-10-19&station=KOZA');
});
test('opening and closing mobile date controls keeps the same form, date names and bounds',()=>{
 const h=mount('./ops-command-date-range.tsx','OpsCommandDateRange',{from:'2026-10-01',to:'2026-10-19',today:'2026-10-20',station:'KOZA'});let tree=h.render();
 const inputs=nodes(tree).filter(n=>n.type==='input').map(n=>n.props);
 assert.deepEqual(inputs.map(p=>[p.name,p.defaultValue??p.value,p.max]),[['station','KOZA',undefined],['from','2026-10-01','2026-10-20'],['to','2026-10-19','2026-10-20']]);
 nodes(tree).find(n=>n.props.className==='dateToggle').props.onClick();tree=h.render();assert.equal(tree.props['data-open'],true);assert.equal(nodes(tree).find(n=>n.type==='form').props.action,'/ops-pulse');
});

test('frequent workspace shortcuts retain scoped destinations when mobile More is opened and closed',()=>{
 const items=['Shift Attendance','Review Desk','COD workspace','Capacity','Payment Approvals'].map((label,i)=>({label,href:`/workspace/${i}?location=assigned&date=2026-10-20`}));
 const h=mount('./ops-workspace-shortcuts.tsx','OpsWorkspaceShortcuts',{items});let tree=h.render();
 const links=()=>nodes(h.tree).filter(n=>n.type==='a').map(n=>({href:n.props.href,label:n.props.children[0].props.children}));
 assert.equal(tree.props['data-expanded'],false);assert.equal(nodes(tree).find(n=>n.props.className==='ops-workspace-shortcuts-extra').props.children.length,2);
 const before=links();nodes(tree).find(n=>n.type==='button').props.onClick();tree=h.render();assert.equal(tree.props['data-expanded'],true);assert.deepEqual(links(),before);
 nodes(tree).find(n=>n.type==='button').props.onClick();tree=h.render();assert.equal(tree.props['data-expanded'],false);assert.deepEqual(links(),before);
 assert.equal(mount('./ops-workspace-shortcuts.tsx','OpsWorkspaceShortcuts',{items:[]}).render(),null);
});
