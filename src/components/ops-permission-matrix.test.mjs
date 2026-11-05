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
const nav=compile('../lib/ops-pulse/navigation.ts',{'@/lib/app-navigation':appNav,'@/lib/authorization':{hasPermission:()=>true,isCompanyOwner:()=>false},'@/lib/ops-pulse/cod-pending-access':{canAccessDailyCodPending:auth=>auth.allowCod},'@/lib/ops-pulse/last-mile-report-bot-access':{canAccessLastMileReportBot:email=>Boolean(email)}});
const views=['amazon_edsp','amazon_now','flipkart_odh_mdh'].map(key=>({key,label:key,items:nav.opsNavCatalogForMode(key)}));
const codes=[...new Set(views.flatMap(view=>view.items.flatMap(item=>[item.code,...(item.permissionCodes??[]),...(item.children??[]).flatMap(child=>[child.code,...(child.permissionSections??[]).map(section=>section.code)])])))].filter(Boolean);
const pages=codes.map(code=>({id:code,code,name:`Permission ${code}`}));
const nodes=n=>!n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(nodes)];
function mount(extra={}) {
  const state=[];let cursor=0,tree;
  const hooks={Fragment:'fragment',useState(initial){const i=cursor++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],value=>state[i]=typeof value==='function'?value(state[i]):value]},useMemo:fn=>fn(),useRef:()=>({current:null}),useEffect:()=>{}};
  const jsx=(type,props)=>({type,props});
  const {OpsPermissionMatrix}=compile('./ops-permission-matrix.tsx',{
    'react':hooks,
    'react/jsx-runtime':{jsx,jsxs:jsx},
    '@/lib/ops-pulse/permission-navigation':grouping,
  });
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
  const performance=groups.find(g=>g.label==='Performance');
  const live=performance.rows.find(r=>r.label==='Live performance');
  assert.deepEqual(live.sections.map(section=>section.label),['Ops Live','Station board','Ageing','Performance','EDDs','Scorecard']);
});
test('compact dashboard-style matrix expands menus and in-page sections without changing saved permissions',()=>{
  const extra={id:'unlisted',code:'unlisted',name:'Existing action'};
  const initial=[...pages,extra].map((page,i)=>({page_id:page.id,can_view:i%2===0,can_add:i%3===0,can_edit:i%5===0}));
  const h=mount({pages:[...pages,extra],initialPermissions:initial});h.render();
  assert.equal(h.all().filter(n=>n.type==='table').length,1);
  assert(!h.all().some(n=>n.props.className==='report-table-tools'));
  h.all().find(n=>n.props['aria-label']==='Expand Workforce').props.onClick();h.render();
  assert(h.all().some(n=>n.props['aria-label']==='Workforce / ID Mapping: View'));
  h.all().find(n=>n.props['aria-label']==='Expand Performance').props.onClick();h.render();
  h.all().find(n=>n.props['aria-label']==='Expand Performance / Live performance').props.onClick();h.render();
  assert(h.all().some(n=>n.props['aria-label']==='Performance / Live performance / Station board: View'));
  h.all().find(n=>n.props['aria-label']==='Workspace').props.onChange({target:{value:'amazon_now'}});h.render();
  assert(h.all().some(n=>n.props['aria-label']==='Expand Store Audits'));
  h.all().find(n=>n.props.placeholder==='Menu, submenu or section').props.onChange({target:{value:'Audit'}});h.render();
  assert.equal(grouping.additionalPermissionPages([...pages,extra],views)[0].id,'unlisted');
});
test('submenu edits sync shared grants, require View for Edit, and do not change unrelated pages',()=>{
  const h=mount();h.render();
  h.all().find(n=>n.props['aria-label']==='Expand Operations').props.onClick();h.render();
  h.all().find(n=>n.props['aria-label']==='Operations / COD Status: Edit').props.onChange({target:{checked:true}});h.render();
  assert.equal(h.all().find(n=>n.props['aria-label']==='Operations / COD Slip Review: Edit').props.checked,true);
  assert.equal(h.all().find(n=>n.props['aria-label']==='Operations / COD Slip Review: View').props.checked,true);
  const changed=h.payload().filter(p=>p.can_view||p.can_add||p.can_edit);
  assert.deepEqual(changed,[{page_id:'cod_reports',can_view:true,can_add:false,can_edit:true}]);
});
test('search opens the matching leaf, which can be granted without any menu-level bulk access',()=>{
  const h=mount();h.render();h.all().find(n=>n.props.placeholder==='Menu, submenu or section').props.onChange({target:{value:'ID Mapping'}});h.render();
  assert(h.all().some(n=>n.props['aria-label']==='Workforce / ID Mapping: View'));
  h.all().find(n=>n.props['aria-label']==='Workforce / ID Mapping: View').props.onChange({target:{checked:true}});h.render();
  assert.deepEqual(h.payload().filter(p=>p.can_view),[{page_id:'ops_provider_mapping',can_view:true,can_add:false,can_edit:false}]);
});
test('unfiltered configuration catalogue does not bypass live sidebar COD review eligibility',()=>{
  const hasSlip=items=>items.some(item=>item.children?.some(child=>child.href==='/cod/pending'));
  assert.equal(hasSlip(nav.opsNavCatalogForMode('amazon_edsp')),true);
  assert.equal(hasSlip(nav.opsNavItemsForMode('amazon_edsp',{allowCod:false})),false);
  assert.equal(hasSlip(nav.opsNavItemsForMode('amazon_edsp',{allowCod:true})),true);
});

test('Last Mile Report Bot stays under Settings and is Joseph-only in the live sidebar',()=>{
  const hasLm=items=>items.some(item=>item.children?.some(child=>child.code==='ops_lm_report_bot'));
  const settings=nav.opsNavCatalogForMode('amazon_edsp').find(item=>item.label==='Settings');
  assert.equal(settings?.children?.some(child=>child.code==='ops_lm_report_bot'&&child.href==='/report-bot?workspace=last_mile'),true);
  assert.equal(hasLm(nav.opsNavItemsForMode('amazon_edsp',{allowCod:true})),false);
  assert.equal(hasLm(nav.opsNavItemsForMode('amazon_edsp',{allowCod:true,email:'tech@dropxlogistics.com'})),true);
});


test('attendance and roster links share the existing grant while keeping separate menu row identities',()=>{
  const groups=grouping.permissionMenuGroups(pages,views[1].items,views);
  assert.equal(new Set(groups.map(g=>g.key)).size,groups.length);
  const attendance=groups.find(g=>g.label==='Shift Attendance'),roster=groups.find(g=>g.label==='Rostering');
  assert.equal(attendance.rows[0].page.id,roster.rows[0].page.id);
  assert(attendance.rows[0].sharedWith.includes('Rostering'));
  const h=mount({initialNavigationView:'amazon_now'});h.render();
  h.all().find(n=>n.props['aria-label']==='Expand Shift Attendance').props.onClick();h.render();
  h.all().find(n=>n.props['aria-label']==='Shift Attendance / Shift Attendance: View').props.onChange({target:{checked:true}});h.render();
  h.all().find(n=>n.props['aria-label']==='Expand Rostering').props.onClick();h.render();
  assert.equal(h.all().find(n=>n.props['aria-label']==='Rostering / Rostering: View').props.checked,true);
  assert.deepEqual(h.payload().filter(p=>p.can_view),[{page_id:'ops_rostering',can_view:true,can_add:false,can_edit:false}]);
});

test('Live performance sections are independently configurable and parent bulk controls remain optional',()=>{
  const h=mount();h.render();
  h.all().find(n=>n.props['aria-label']==='Expand Performance').props.onClick();h.render();
  h.all().find(n=>n.props['aria-label']==='Expand Performance / Live performance').props.onClick();h.render();
  h.all().find(n=>n.props['aria-label']==='Performance / Live performance / Station board: View').props.onChange({target:{checked:true}});h.render();
  assert.deepEqual(h.payload().filter(p=>p.can_view),[{page_id:'edd_station_board',can_view:true,can_add:false,can_edit:false}]);
  assert.equal(h.all().find(n=>n.props['aria-label']==='Performance / Live performance / Ops Live: View').props.checked,false);
  h.all().find(n=>n.props['aria-label']==='Performance / Live performance: All').props.onChange({target:{checked:true}});h.render();
  const liveCodes=['edd_live_ops','edd_station_board','edd_ageing','edd_performance','edd_edds','edd_scorecard'];
  assert.equal(h.payload().filter(p=>liveCodes.includes(p.page_id)).every(p=>p.can_view&&p.can_add&&p.can_edit),true);
  assert.equal(h.payload().find(p=>p.page_id==='edd_scrub').can_view,false);
});
