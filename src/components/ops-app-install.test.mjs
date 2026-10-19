import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const jsx=(type,props)=>({type,props});
const nodes=n=>!n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(nodes)];
function mount() {
 const saved=globalThis.window,values=[],events=new Map(),cleanups=[];let cursor=0,started=false;
 globalThis.window={matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),addEventListener:(n,f)=>events.set(n,f),removeEventListener:n=>events.delete(n)};
 const hooks={useState:v=>{const i=cursor++;if(!(i in values))values[i]=v;return [values[i],x=>values[i]=x]},useEffect:fn=>{if(!started)cleanups.push(fn())}};
 const mocks={'react':hooks,'react/jsx-runtime':{jsx,jsxs:jsx},'lucide-react':{Download:'svg',Monitor:'svg',Smartphone:'svg',Check:'svg'},'../../public/downloads/opspulse-android.json':JSON.parse(readFileSync(new URL('../../public/downloads/opspulse-android.json',import.meta.url),'utf8'))};
 const m={exports:{}};const code=ts.transpileModule(readFileSync(new URL('./ops-app-install.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 new Function('require','exports','module',code)(id=>mocks[id],m.exports,m);
 return {events,render(){cursor=0;const tree=m.exports.OpsAppInstall({compact:true});started=true;return tree},cleanup(){cleanups.forEach(fn=>fn?.());globalThis.window=saved}};
}
const installButton=tree=>nodes(tree).find(n=>n.type==='button'&&!n.props.className);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('install without a browser prompt opens usable platform instructions',()=>{const h=mount();try{installButton(h.render()).props.onClick();assert(nodes(h.render()).some(n=>n.props.className==='ops-install-instructions'))}finally{h.cleanup()}});
test('native install acceptance, appinstalled state and listener cleanup',async()=>{const h=mount();try{h.render();let prevented=false,prompts=0;h.events.get('beforeinstallprompt')({preventDefault(){prevented=true},async prompt(){prompts++},userChoice:Promise.resolve({outcome:'accepted'})});installButton(h.render()).props.onClick();await tick();assert(prevented);assert.equal(prompts,1);assert(!installButton(h.render()).props.disabled);h.events.get('appinstalled')();assert.equal(installButton(h.render()).props.disabled,true)}finally{h.cleanup();assert.equal(h.events.size,0)}});
test('failed installation restores controls and exposes manual instructions',async()=>{const h=mount();try{h.render();h.events.get('beforeinstallprompt')({preventDefault(){},async prompt(){throw Error('unsupported')},userChoice:Promise.resolve({outcome:'dismissed'})});installButton(h.render()).props.onClick();await tick();const tree=h.render();assert(!installButton(tree).props.disabled);assert(nodes(tree).some(n=>n.props.className==='ops-install-instructions'));assert(nodes(tree).some(n=>n.props.role==='status'))}finally{h.cleanup()}});
