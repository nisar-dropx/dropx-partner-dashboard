import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {base,evaluate} from './model.ts';
const code=ts.transpileModule(readFileSync(new URL('../../app/notifications/mail-health/view.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const mod={exports:{}};
const jsx=await import('react/jsx-runtime');
vm.runInNewContext(code,{module:mod,exports:mod.exports,require(name){if(name==='react')return React;if(name==='react/jsx-runtime')return jsx;if(name==='./view.css')return {};throw new Error(name);},Date,Set,Map});
test('overview renders discovered portal, truthful failed coverage and read-only controls',()=>{
 const source={...base,key:'unexpected',table:'unexpected_mail_logs',label:'Newly connected mail',portal:'Future portal',statusField:'status',timeField:'created_at'};
 const fixture={checkedAt:new Date().toISOString(),watchdogAt:null,warnings:['Catalog connection is incomplete'],health:[evaluate(source,[],new Date(),undefined,['Fixture query failed'])]};
 const html=renderToStaticMarkup(React.createElement(mod.exports.MailHealthView,{canEdit:false,initialData:fixture}));
 assert.match(html,/Future portal/);assert.match(html,/Newly connected mail/);assert.match(html,/Unverified/);assert.match(html,/watchdog is not yet verified/i);assert.match(html,/coverage unknown/);assert.doesNotMatch(html,/Monitoring settings &amp; history/);assert.match(html,/role="alert"/);
});
