import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const source = fs.readFileSync("src/components/people-ownership-refresh.tsx","utf8");
const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function mount(paused) {
  const effects=[], listeners=new Map(); let timer, refreshes=0, now=0;
  const doc={visibilityState:"hidden",addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)};
  const win={...doc,setInterval(fn,ms){assert.equal(ms,30000);timer=fn;return 1;},clearInterval(){timer=null;}};
  const mocks={
    react:{useEffect:fn=>effects.push(fn),useRef:v=>({current:v}),useTransition:()=>[false,fn=>fn()]},
    "react/jsx-runtime":{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
    "next/navigation":{useRouter:()=>({refresh(){refreshes++;}})},
  };
  const mod={exports:{}};
  new Function("require","module","exports","window","document","Date",js)(id=>mocks[id],mod,mod.exports,win,doc,{now:()=>now});
  mod.exports.PeopleOwnershipRefresh({paused});
  const cleanups=effects.map(fn=>fn()).filter(Boolean);
  return {listeners,get timer(){return timer;},get refreshes(){return refreshes;},advance(){now+=30000;},show(){doc.visibilityState="visible";},cleanup(){cleanups.forEach(fn=>fn());}};
}
const view=mount(false);
view.advance(); view.timer(); assert.equal(view.refreshes,0,"hidden screens do not poll");
view.show(); view.listeners.get("visibilitychange")(); assert.equal(view.refreshes,1,"returning from People reloads current ownership");
view.listeners.get("focus")(); assert.equal(view.refreshes,1,"focus and visibility events do not duplicate requests");
view.cleanup(); assert.equal(view.listeners.size,0); assert.equal(view.timer,null);
const editing=mount(true); assert.equal(editing.timer,undefined); assert.equal(editing.listeners.size,0,"station edit forms are never automatically refreshed");
console.log("PASS People ownership refresh: 30-second interval, visible/focus updates, duplicate suppression, edit-form protection and cleanup.");
