import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const jsx=(type,props,key)=>({type,props,key});
const nodes=n=>!n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(nodes)];
function harness({url='https://ops.example/store-audits',blocked=false,enabled=true}={}) {
 const values=[],refs=[],effects=[],deps=[];let cursor=0,refCursor=0,effectCursor=0;
 const stored=new Map();const browser={location:new URL(url),history:{state:{},replaceState(_state,_title,path){browser.location=new URL(path,browser.location)}}};
 const saved={window:globalThis.window,document:globalThis.document,localStorage:globalThis.localStorage};
 globalThis.window=browser;globalThis.document={body:{dataset:{},classList:{toggle(){},remove(){}}}};
 globalThis.localStorage={getItem:k=>{if(blocked)throw Error('blocked');return stored.get(k)||null},setItem:(k,v)=>{if(blocked)throw Error('blocked');stored.set(k,v)}};
 const hooks={useState:v=>{const i=cursor++;if(!(i in values))values[i]=v;return [values[i],next=>values[i]=typeof next==='function'?next(values[i]):next]},useRef:v=>refs[refCursor++]??(refs[refCursor-1]={current:v}),useEffect:(cb,next)=>{const i=effectCursor++;if(!deps[i]||next.some((v,n)=>v!==deps[i][n])){effects.push(cb);deps[i]=next;}}};
 const mocks={'react':hooks,'react/jsx-runtime':{jsx,jsxs:jsx},'next/navigation':{usePathname:()=>browser.location.pathname,useSearchParams:()=>browser.location.searchParams},'lucide-react':{Menu:'icon',Paintbrush:'icon',RotateCcw:'icon',X:'icon'},'@/components/ops-design-context':{OpsDesignContext:{Provider:'Provider'}},'@/components/event-log-tracker':{EventLogTracker:'Tracker'}};
 const m={exports:{}};const code=ts.transpileModule(readFileSync(new URL('./app-shell-frame.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','exports','module',code)(name=>mocks[name]??(()=>{throw Error(name)})(),m.exports,m);
 const child=jsx('form',{children:jsx('input',{defaultValue:'Unsaved observation'})});
 return {browser,child,render(){cursor=refCursor=effectCursor=0;const tree=m.exports.AppShellFrame({children:child,sidebar:null,desktopActions:null,mobileActions:null,opsDesignPreview:enabled,pageTitle:'Store Audits'});effects.splice(0).forEach(fn=>fn());return tree},restore(){Object.assign(globalThis,saved)}};
}
test('OpsPulse uses the new shell on first render and ignores previous classic preferences',()=>{
 for(const url of ['https://ops.example/store-audits','https://ops.example/store-audits?opsUi=classic','https://ops.example/store-audits?opsUi=people']) {
  const h=harness({url,blocked:true});
  try{const tree=h.render();assert.equal(tree.props.value,true);assert(nodes(tree).includes(h.child));assert(!nodes(tree).some(n=>n.props?.className==='ops-design-toggle'));assert.equal(h.render().props.value,true)}finally{h.restore()}
 }
});
test('retired design links preserve workflow filters, hash and the existing form subtree',()=>{
 const h=harness({url:'https://ops.example/store-audits?from=2026-10-01&opsUi=classic&notice=saved#checks'});
 try{const tree=h.render();assert.equal(h.browser.location.search,'?from=2026-10-01');assert.equal(h.browser.location.hash,'#checks');assert(nodes(tree).includes(h.child));assert(nodes(h.render()).includes(h.child))}finally{h.restore()}
});
test('other portals retain their existing shell and query',()=>{
 const h=harness({url:'https://people.example/?opsUi=people',enabled:false});try{const tree=h.render();assert.equal(tree.props.value,false);assert(!nodes(tree).some(n=>n.props?.className==='ops-design-toggle'));assert.equal(h.browser.location.search,'?opsUi=people')}finally{h.restore()}
});
