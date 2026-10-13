import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as periods from '../lib/provider-mapping-schedule.ts';
const require=createRequire(import.meta.url);
const compiled=ts.transpileModule(readFileSync(new URL('./provider-mapping-schedule.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const method={id:'m',name:'Per package',components:[{code:'DELIVERY',label:'Delivery'}]};
function modal(save,onSaved=()=>{}){
 const slots=[];let cursor=0,tree;
 const module={exports:{}};
 const deps={'react':{useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>slots[i]=typeof value==='function'?value(slots[i]):value];}},'@/components/searchable-select':{SearchableSelect:'SearchableSelect'},'@/lib/provider-mapping-schedule':periods,'@/app/provider-mapping/actions':{saveProviderMappingSchedule:save}};
 new Function('require','exports','module',compiled)(key=>deps[key]??require(key),module.exports,module);
 const row={workforceId:'w',stationId:'a',providerId:'p',providerMemberId:'111',providerMemberName:'Asha',dropxId:'DX1',dropxName:'Asha',mappingId:'m1',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31',paymentMethodId:'m',paymentValues:{DELIVERY:'10'},productionThresholdMinimumUnits:''};
 const render=()=>{cursor=0;tree=module.exports.ProviderMappingSchedule({row,methods:[method],onSaved,onClose:()=>{}});};
 const all=(fn,node=tree)=>Array.isArray(node)?node.flatMap(child=>all(fn,child ?? null)):!node||typeof node!=='object'?[]:[...(fn(node)?[node]:[]),...all(fn,node.props?.children ?? null)];
 const button=text=>all(n=>n.type==='button'&&n.props.children===text)[0];
 render();return{render,all,button,async save(){await button('Save 2 payment periods').props.onClick();render();}};
}
test('plus requires an end, next period defaults to following month, required rates gate save and errors keep entries',async()=>{
 let data,saved=false,fail=true;
 const ui=modal(async form=>{data=form;return fail?{ok:false,message:'Locked payroll',mappings:[]}:{ok:true,mappings:[{id:'new'}]};},()=>saved=true);
 assert.equal(ui.all(n=>n.type==='input'&&n.props.type==='date')[2].props.value,'2026-11-01');
 assert.equal(ui.button('+ Add payment period').props.disabled,true);
 assert.equal(ui.button('Save 2 payment periods').props.disabled,true);
 ui.all(n=>n.type==='SearchableSelect')[1].props.onValueChange('m');ui.render();
 assert.equal(ui.button('Save 2 payment periods').props.disabled,true);
 ui.all(n=>n.type==='input'&&n.props.type==='number')[1].props.onChange({target:{value:'12'}});ui.render();
 assert.equal(ui.button('Save 2 payment periods').props.disabled,false);
 await ui.save();assert.equal(saved,false);assert.equal(data.get('rows[1][effective_from]'),'2026-11-01');assert.equal(data.get('rows[1][effective_to]'),'');
 assert.equal(ui.all(n=>n.props?.role==='alert')[0].props.children,'Locked payroll');
 assert.equal(ui.all(n=>n.type==='input'&&n.props.type==='number')[1].props.value,'12');
 fail=false;await ui.save();assert.equal(saved,true);
});
test('changing an end adjusts only next start and enables another period',()=>{
 const ui=modal(async()=>({ok:false,mappings:[]}));
 ui.all(n=>n.type==='input'&&n.props.type==='date')[1].props.onChange({target:{value:'2026-10-20'}});ui.render();
 assert.equal(ui.all(n=>n.type==='input'&&n.props.type==='date')[2].props.value,'2026-10-21');
 ui.all(n=>n.type==='input'&&n.props.type==='date')[3].props.onChange({target:{value:'2026-11-30'}});ui.render();
 assert.equal(ui.button('+ Add payment period').props.disabled,false);
 ui.button('+ Add payment period').props.onClick();ui.render();
 assert.equal(ui.all(n=>n.type==='input'&&n.props.type==='date')[4].props.value,'2026-12-01');
});
