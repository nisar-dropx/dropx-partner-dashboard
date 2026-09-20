import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url), React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
function compile(path,deps={}){const out={};new Function('require','exports',ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(name=>deps[name]??require(name),out);return out;}
const details=compile('src/components/review-details.tsx');
let focused=false;
const native={open:true,querySelector:()=>({focus:()=>{focused=true;}})};
const input={value:'unsaved reason',closest:()=>native};
details.closeReviewDetails(input);
assert.equal(native.open,false);assert.equal(focused,true);assert.equal(input.value,'unsaved reason');
native.open=true;let stopped=false;
details.ReviewDetails({children:'body'}).props.onKeyDown({target:input,key:'Escape',preventDefault(){},stopPropagation(){stopped=true;}});
assert.equal(native.open,false);assert.equal(stopped,true,'nested Escape does not also close an outer panel');
const component=compile('src/components/performance-connections.tsx',{
  '@/components/review-details':details,
  '@/app/ops-pulse/performance/actions':{savePerformanceConnection(){}},
  '@/components/review-action-form':{ReviewActionForm:({children,...props})=>React.createElement('form',{className:props.className},children)},
  '@/components/performance-trends':{TrendButton:()=>null}
});
const html=renderToStaticMarkup(React.createElement(component.PerformanceConnections,{connections:[{id:'a',version:1,label:'Vehicle 1',arrival_at:'2026-09-09T07:35:00+05:30',unloading_at:'2026-09-09T08:25:00+05:30',clearance_at:'2026-09-09T09:00:00+05:30'}],date:'2026-09-09',stationCode:'GDRD',canEdit:true}));
assert.ok(html.includes('Arrived 07:35 · Unloaded 08:25'));
assert.ok(!/clearance|Vehicle cleared|09:00/.test(html),'retired field absent from summary, read and edit views');
assert.ok(!/<details[^>]+open/.test(html),'existing vehicles start collapsed');
assert.ok(html.includes('Close Vehicle 1 timings')&&html.includes('aria-controls="review-new-vehicle"'));
const css=read('src/app/ops-pulse/performance/review-desk.css');
assert.ok(css.includes('position: static; width: auto; max-width: 100%'),'drilldowns stay inline');
assert.ok(css.includes('min-height: 44px')&&css.includes('overflow-x: auto'),'touch targets and contained mobile scrolling');
assert.ok(!read('src/lib/ops-pulse/review-trends-data.ts').includes('Last station clearance'));
const scorecard=compile('src/components/review-scorecard.tsx',{'@/components/review-details':details,'@/components/performance-trends':{TrendButton:()=>null}});
const scorecardHtml=renderToStaticMarkup(React.createElement(scorecard.ReviewScorecard,{metrics:[{key:'pass',short:'Passing metric',actual:.98,target:.95,direction:'higher',severity:'green'},{key:'miss',short:'Missed metric',actual:.8,target:.95,direction:'higher',severity:'red'}]}));
assert.ok(scorecardHtml.includes('Passing metric')&&scorecardHtml.includes('Missed metric'),'one scorecard shows passing metrics and misses together');
assert.ok(!scorecardHtml.includes('Needs attention')&&!scorecardHtml.includes('Scorecard view'),'no redundant scorecard switch');
const action=read('src/app/ops-pulse/performance/actions.ts').split('export async function savePerformanceConnection')[1].split('/** Explicit exception')[0];
assert.ok(!action.includes('text(data, "clearance")'));
const migration=read('supabase/migrations/20260910142408_retire_review_vehicle_clearance.sql');
assert.ok(!migration.includes('clearance_at=')&&!migration.includes('delete from'));
console.log('PASS compact Review Desk: retired field, closed vehicle rows, close/Escape/focus, preserved drafts, mobile targets and inline panels.');
