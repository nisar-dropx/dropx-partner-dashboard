import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {opsDesignPreference} from '../lib/ops-pulse/design-navigation.ts';
const jsx=(type,props,key)=>({type,props,key});
const nodes=n=>!n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(nodes)];
function harness({url='https://ops.example/store-audits',blocked=false,enabled=true}={}) {
 const values=[],refs=[],effects=[],deps=[];let cursor=0,refCursor=0,effectCursor=0;
 const stored=new Map();const browser={location:new URL(url),history:{state:{},replaceState(_state,_title,path){browser.location=new URL(path,browser.location)}}};
 const saved={window:globalThis.window,document:globalThis.document,localStorage:globalThis.localStorage};
 globalThis.window=browser;globalThis.document={body:{dataset:{},classList:{toggle(){},remove(){}}}};
 globalThis.localStorage={getItem:k=>{if(blocked)throw Error('blocked');return stored.get(k)||null},setItem:(k,v)=>{if(blocked)throw Error('blocked');stored.set(k,v)}};
 const hooks={useState:v=>{const i=cursor++;if(!(i in values))values[i]=v;return [values[i],next=>values[i]=typeof next==='function'?next(values[i]):next]},useRef:v=>refs[refCursor++]??(refs[refCursor-1]={current:v}),useEffect:(cb,next)=>{const i=effectCursor++;if(!deps[i]||next.some((v,n)=>v!==deps[i][n])){effects.push(cb);deps[i]=next;}}};
 const mocks={'react':hooks,'react/jsx-runtime':{jsx,jsxs:jsx},'next/navigation':{usePathname:()=>browser.location.pathname,useSearchParams:()=>browser.location.searchParams},'lucide-react':{Menu:'icon',Paintbrush:'icon',RotateCcw:'icon',X:'icon'},'@/components/ops-design-context':{OpsDesignContext:{Provider:'Provider'}},'@/lib/ops-pulse/design-navigation':{opsDesignPreference},'@/components/event-log-tracker':{EventLogTracker:'Tracker'}};
 const m={exports:{}};const code=ts.transpileModule(readFileSync(new URL('./app-shell-frame.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','exports','module',code)(name=>mocks[name]??(()=>{throw Error(name)})(),m.exports,m);
 const child=jsx('form',{children:jsx('input',{defaultValue:'Unsaved observation'})});
 return {browser,child,render(){cursor=refCursor=effectCursor=0;const tree=m.exports.AppShellFrame({children:child,sidebar:null,desktopActions:null,mobileActions:null,opsDesignPreview:enabled,pageTitle:'Store Audits'});effects.splice(0).forEach(fn=>fn());return tree},restore(){Object.assign(globalThis,saved)}};
}
test('design switch keeps the same child subtree and leaves existing query filters intact',()=>{
 const h=harness({url:'https://ops.example/store-audits?from=2026-10-01&opsUi=people&notice=saved#checks'});
 try{h.render();let tree=h.render();assert.equal(tree.props.value,true);assert.equal(h.browser.location.search,'?from=2026-10-01');assert.equal(h.browser.location.hash,'#checks');assert(nodes(tree).includes(h.child));nodes(tree).find(n=>n.type==='button'&&n.props.className==='ops-design-toggle').props.onClick();tree=h.render();assert.equal(tree.props.value,false);assert(nodes(tree).includes(h.child));}finally{h.restore()}
});
test('consuming the preview query does not undo the choice when browser storage is blocked',()=>{
 const h=harness({url:'https://ops.example/store-audits?opsUi=people',blocked:true});try{h.render();assert.equal(h.render().props.value,true);assert.equal(h.render().props.value,true)}finally{h.restore()}
});
test('other portals never expose the preview or consume its query',()=>{
 const h=harness({url:'https://people.example/?opsUi=people',enabled:false});try{const tree=h.render();assert.equal(tree.props.value,false);assert(!nodes(tree).some(n=>n.props?.className==='ops-design-toggle'));assert.equal(h.browser.location.search,'?opsUi=people')}finally{h.restore()}
});
