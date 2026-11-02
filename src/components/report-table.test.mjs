import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript'),React=require('react');
const cache=new Map();
function load(path){
 if(cache.has(path))return cache.get(path);
 const exports={};const source=ts.transpileModule(fs.readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{exports,require:(name)=>name.endsWith('.css')?{}:name.includes('ops-design-context')?{useOpsDesign:()=>false,useOpsReportExport:()=>false}:name.includes('download-report-excel')?{}:name.includes('report-table-values')?load('../lib/report-table-values.ts'):require(name)});
 cache.set(path,exports);return exports;
}
const {sortReportBody}=load('./report-table.tsx'),h=React.createElement;
const row=(key,name,amount)=>h('tr',{key},h('td',null,name),h('td',null,amount));
const names=(groups)=>Array.from(groups,g=>{const nodes=React.Children.toArray(g.props.children);let r=nodes[0];if(r.type===React.Fragment)r=React.Children.toArray(r.props.children)[0];return React.Children.toArray(r.props.children)[0].props.children;});
test('React sorting keeps expanded rows, fragments and total together',()=>{
 const expanded=h(React.Fragment,{key:'b'},row('b','Bravo','₹2,000'),h('tr',null,h('td',{colSpan:2},'Bravo history')));
 const groups=sortReportBody([expanded,row('a','Alpha','₹100'),row('total','Total','₹2,100')],{column:1,direction:'asc'});
 assert.deepEqual(names(groups),['Alpha','Bravo','Total']);
 assert.equal(React.Children.toArray(React.Children.toArray(groups[1].props.children)[0].props.children).length,2);
});
test('row spans stay attached and sorting never crosses total/group boundaries',()=>{
 const first=h('tr',{key:'b'},h('td',{rowSpan:2},'Bravo'),h('td',null,'2'));
 const continuation=h('tr',{key:'b2'},h('td',null,'detail'));
 const groups=sortReportBody([first,continuation,row('a','Alpha','1'),row('total','Total','3')],{column:0,direction:'asc'});
 assert.deepEqual(names(groups),['Alpha','Bravo','Total']);
 assert.equal(React.Children.count(groups[1].props.children),2);
});
test('rendered custom cell values are used without invoking component functions',()=>{
 const Badge=()=>{throw Error('Do not call a component outside React');};
 const children=[h('tr',{key:'a'},h('td',null,'Alpha'),h('td',null,h(Badge))),h('tr',{key:'b'},h('td',null,'Bravo'),h('td',null,h(Badge)))];
 const keys=React.Children.toArray(children).map(r=>r.key);
 const rendered={[keys[0]]:['Alpha','100'],[keys[1]]:['Bravo','2']};
 assert.deepEqual(names(sortReportBody(children,{column:1,direction:'asc'},rendered)),['Bravo','Alpha']);
});
