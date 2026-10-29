import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as grouping from '../lib/ops-pulse/permission-navigation.ts';

function compile(file,mocks={}) {
  const module={exports:{}};
  const code=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require','exports','module',code)(id=>{if(id in mocks)return mocks[id];throw Error(`Unmocked ${id}`)},module.exports,module);
  return module.exports;
}
const appNav=compile('../lib/app-navigation.ts');
const nav=compile('../lib/ops-pulse/navigation.ts',{'@/lib/app-navigation':appNav,'@/lib/authorization':{hasPermission:()=>true,isCompanyOwner:()=>false},'@/lib/ops-pulse/cod-pending-access':{canAccessDailyCodPending:auth=>auth.allowCod}});
const views=['amazon_edsp','amazon_now','flipkart_odh_mdh'].map(key=>({key,label:key,items:nav.opsNavCatalogForMode(key)}));
const codes=[...new Set(views.flatMap(view=>view.items.flatMap(item=>[item.code,...(item.permissionCodes??[]),...(item.children??[]).map(child=>child.code)])))].filter(Boolean);
const pages=codes.map(code=>({id:code,code,name:`Permission ${code}`}));
const nodes=n=>!n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(nodes)];
function mount(extra={}) {
  const state=[];let cursor=0,tree;
  const hooks={Fragment:'fragment',useState(initial){const i=cursor++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],value=>state[i]=typeof value==='function'?value(state[i]):value]},useMemo:fn=>fn(),useRef:()=>({current:null}),useEffect:()=>{}};
  const jsx=(type,props)=>({type,props});
  const {OpsPermissionMatrix}=compile('./ops-permission-matrix.tsx',{'react':hooks,'react/jsx-runtime':{jsx,jsxs:jsx},'@/lib/ops-pulse/permission-navigation':grouping});
  const props={pages,navigationViews:views,initialNavigationView:'amazon_edsp',...extra};
  return {render(){cursor=0;tree=OpsPermissionMatrix(props);return tree},all(){return nodes(tree)},payload(){return JSON.parse(nodes(tree).find(n=>n.props.name==='permissions_json').props.value)}};
}

test('editor uses actual sidebar parents, submenu labels and order; future menu entries appear automatically',()=>{
  const groups=grouping.permissionMenuGroups(pages,views[0].items,views);
  assert.deepEqual(groups.map(g=>g.label),views[0].items.map(g=>g.label));
  assert(groups.find(g=>g.label==='Workforce').rows.some(r=>r.label==='ID Mapping'));
  assert(!groups.some(g=>g.label==='ID Mapping'));
  const future={code:'future',label:'New menu',icon:'X',children:[{code:'future_page',label:'Future submenu',href:'/future'}]};
  const futurePages=[...pages,{id:'new',code:'future_page',name:'Old database label'}];
  const next=grouping.permissionMenuGroups(futurePages,[...views[0].items,future],views);
  assert.equal(next.at(-1).rows[0].label,'Future submenu');
});
test('main menus are collapsed and expanding, searching or changing workspace preserves every permission bit',()=>{
  const extra={id:'unlisted',code:'unlisted',name:'Existing action'};
  const initial=[...pages,extra].map((page,i)=>({page_id:page.id,can_view:i%2===0,can_add:i%3===0,can_edit:i%5===0}));
  const h=mount({pages:[...pages,extra],initialPermissions:initial});h.render();
  assert.equal(h.all().filter(n=>n.props.className==='ops-permission-submenu-row').length,0);
  assert.deepEqual(h.payload(),initial);
  h.all().find(n=>n.props['aria-label']==='Expand Workforce').props.onClick();h.render();
  assert(h.all().some(n=>n.props.className==='ops-permission-submenu-row'));
  h.all().find(n=>n.type==='select').props.onChange({target:{value:'amazon_now'}});h.render();
  assert(h.all().some(n=>n.props.className==='ops-permission-single'&&n.props.children==='Store Audits'));
  assert.deepEqual(h.payload(),initial);
  h.all().find(n=>n.props.placeholder==='Menu or submenu').props.onChange({target:{value:'Audit'}});h.render();
  assert.deepEqual(h.payload(),initial);
  assert.equal(grouping.additionalPermissionPages([...pages,extra],views)[0].id,'unlisted');
});
test('submenu edits sync shared grants, require View for Edit, and do not change unrelated pages',()=>{
  const h=mount();h.render();
  h.all().find(n=>n.props['aria-label']==='Expand Operations').props.onClick();h.render();
  h.all().find(n=>n.props.label==='Operations / COD Status: Edit').props.onChange(true);h.render();
  assert.equal(h.all().find(n=>n.props.label==='Operations / COD Slip Review: Edit').props.checked,true);
  assert.equal(h.all().find(n=>n.props.label==='Operations / COD Slip Review: View').props.disabled,true);
  const changed=h.payload().filter(p=>p.can_view||p.can_add||p.can_edit);
  assert.deepEqual(changed,[{page_id:'cod_reports',can_view:true,can_add:false,can_edit:true}]);
});
test('a searched menu bulk action applies only to matching permission IDs and keeps other workspaces intact',()=>{
  const h=mount();h.render();h.all().find(n=>n.props.placeholder==='Menu or submenu').props.onChange({target:{value:'ID Mapping'}});h.render();
  h.all().find(n=>n.props.label==='Displayed menus: All actions').props.onChange(true);h.render();
  assert.deepEqual(h.payload().filter(p=>p.can_view),[{page_id:'ops_provider_mapping',can_view:true,can_add:true,can_edit:true}]);
});
test('unfiltered configuration catalogue does not bypass live sidebar COD review eligibility',()=>{
  const hasSlip=items=>items.some(item=>item.children?.some(child=>child.href==='/cod/pending'));
  assert.equal(hasSlip(nav.opsNavCatalogForMode('amazon_edsp')),true);
  assert.equal(hasSlip(nav.opsNavItemsForMode('amazon_edsp',{allowCod:false})),false);
  assert.equal(hasSlip(nav.opsNavItemsForMode('amazon_edsp',{allowCod:true})),true);
});


test('attendance and roster links share the existing grant while keeping separate menu row identities',()=>{
  const groups=grouping.permissionMenuGroups(pages,views[1].items,views);
  assert.equal(new Set(groups.map(g=>g.key)).size,groups.length);
  const attendance=groups.find(g=>g.label==='Shift Attendance'),roster=groups.find(g=>g.label==='Rostering');
  assert.equal(attendance.rows[0].page.id,roster.rows[0].page.id);
  assert(attendance.rows[0].sharedWith.includes('Rostering'));
  const h=mount({initialNavigationView:'amazon_now'});h.render();
  h.all().find(n=>n.props.label==='Shift Attendance: View').props.onChange(true);h.render();
  assert.equal(h.all().find(n=>n.props.label==='Rostering: View').props.checked,true);
  assert.deepEqual(h.payload().filter(p=>p.can_view),[{page_id:'ops_rostering',can_view:true,can_add:false,can_edit:false}]);
});
