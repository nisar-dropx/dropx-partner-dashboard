import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
function compile(path,aliases={}){
  const code=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  new Function('require','exports','module',code)(name=>name.startsWith('@/')?aliases[name]||{}:require(name),module.exports,module);
  return module.exports;
}
const targets=compile('../lib/ops-pulse/station-review-targets.ts');
const {PerformanceConnections}=compile('./performance-connections.tsx',{
  '@/lib/ops-pulse/station-review-targets':targets,
  '@/components/review-action-form':{ReviewActionForm:({children})=>React.createElement('form',{},children)}
});
const base={id:'10000000-0000-0000-0000-000000000001',version:2,label:'Vehicle A',arrival_at:'2026-09-03T01:30:00Z',unloading_at:'2026-09-03T02:30:00Z',clearance_at:'2026-09-03T03:00:00Z'};
const second={...base,id:'10000000-0000-0000-0000-000000000002',label:'Vehicle B',arrival_at:'2026-09-03T04:30:00Z'};
const render=props=>renderToStaticMarkup(React.createElement(PerformanceConnections,{date:'2026-09-03',stationCode:'TEST',...props}));
test('every saved vehicle remains editable with its own ID and version',()=>{
  const html=render({connections:[base,second],canEdit:true,clearanceCutoff:'08:00'});
  assert.match(html,/Vehicle A/);assert.match(html,/Vehicle B/);assert.match(html,/Add vehicle/);
  assert.equal((html.match(/name="connection_id"/g)||[]).length,2);
  assert.match(html,new RegExp(base.id));assert.match(html,new RegExp(second.id));
  assert.match(html,/30 min late/);
});
test('read-only station review shows all connections but no save/add actions',()=>{
  const html=render({connections:[base,second],canEdit:false});
  assert.match(html,/Vehicle A/);assert.match(html,/Vehicle B/);
  assert.ok(!html.includes('<form'));assert.ok(!html.includes('Add vehicle'));
});
test('empty editable station starts one new vehicle without replacing existing records',()=>{
  const html=render({connections:[],canEdit:true});
  assert.match(html,/name="connection_id" value=""/);
  assert.match(html,/Save this vehicle, then use/);
  assert.match(html,/Save vehicle timings/);
});
