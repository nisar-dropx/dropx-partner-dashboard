const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const styles = new Proxy({}, {get:(_,key)=>String(key)});
function compile(file, mocks) {
  const m={exports:{}};
  new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}
  }).outputText)(id=>id==='react'||id.startsWith('react/')?require(id):Object.hasOwn(mocks,id)?mocks[id]:require(id),m,m.exports);
  return m.exports;
}
const {LossPeriodClose} = compile('src/components/loss-period-close.tsx',{
  'next/navigation':{useRouter:()=>({refresh(){}})},'./nl-loss.module.css':styles
});
function report(component, view) {
 const key=component==='nl-live-report'?'NlLiveReport':'NlLossReport';
 const names=['LossStationTable','LossWorkbook','LossMultiFilter','NlLiveCases','NlLossCases','NlRecoveryDownloadButton','OpsLossCases','NlLossRefresh','LossHeader','NlViewSwitch'];
 const fake=new Proxy({}, {get:(_,key)=>key==='__esModule'?true:names.includes(key)?()=>null:undefined});
 const mocks=new Proxy({
   './loss-period-close':{LossPeriodClose},'./nl-loss.module.css':styles,
   'next/link':{__esModule:true,default:({children,...props})=>React.createElement('a',props,children)},
   './nl-loss-report':{LossHeader:()=>null,NlViewSwitch:()=>null,LOSSES_PATH:'/team-ops/losses'},
   '@/lib/ops-pulse/nl-loss':{ALL_PERIODS:'all'},
   '@/lib/ops-pulse/loss-list-controls':{lossFilterValues:v=>v?[v]:[]},
   '@/lib/ops-pulse/nl-loss-policy':{monthLabel:m=>m==='2026-09'?'September 2026':m},
   '@/lib/ops-pulse/date-format':{formatOpsDate:v=>v,formatOpsDateTime:v=>v},
   '@/lib/ops-pulse/nl-dispute-policy':{WINDOW_STAGES:[],STAGE_COPY:{},daysUntil:()=>1},
 },{get:(target,key)=>key in target?target[key]:fake,getOwnPropertyDescriptor:()=>({configurable:true,enumerable:true})});
 const C=compile(`src/components/${component}.tsx`,mocks)[key];
 return renderToStaticMarkup(React.createElement(C,{view,tabs:[],facts:[],ledgerReady:true}));
}
const view={ready:true,kind:'nl',stageView:'final',month:'2026-09',months:['2026-09'],stage:{stage:null},window:{},cluster:'',station:'',reason:'',phase:'',sort:'',clusterOptions:[],stations:[],reasons:[],totals:[],cases:[],closures:[],closureStations:['KLZA'],canApprove:true,periodOptions:[{value:'2026-09',label:'September 2026'}],periodParam:'month'};
test('actual NL Final report displays close control immediately after filters',()=>{
 const html=report('nl-live-report',view);
 assert.match(html,/Final submit \/ Close period/);
 assert.ok(html.indexOf('Final loss submission')>html.indexOf('</form>'));
 assert.match(html,/September 2026/);
});
test('NL Initial and unauthorized users do not get close control',()=>{
 assert.doesNotMatch(report('nl-live-report',{...view,stageView:'initial'}),/Final submit \/ Close period/);
 assert.doesNotMatch(report('nl-live-report',{...view,canApprove:false}),/Final submit \/ Close period/);
});
test('closed NL period shows read-only state and submitter, with no close button',()=>{
 const html=report('nl-live-report',{...view,closures:[{report:'nl',period:'2026-09',station_code:'KLZA',closed_by_name:'Jamsheer',closed_at:'2026-11-05T06:00:00Z'}]});
 assert.match(html,/closed · read-only/);assert.match(html,/Jamsheer/);assert.doesNotMatch(html,/Final submit \/ Close period/);
});
test('SLP Final also renders the same close control',()=>{
 assert.match(report('nl-loss-report',{...view,kind:'slp_final'}),/Final submit \/ Close period/);
});
