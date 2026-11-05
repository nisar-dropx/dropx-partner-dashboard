const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
function load(file){
 if(!path.extname(file))file+='.ts';
 const m={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 new Function('require','module','exports',code)(id=>{
  if(id==='next/navigation')return {useRouter:()=>({refresh(){}})};
  if(id.endsWith('.css'))return new Proxy({},{get:(_,k)=>String(k)});
  if(id==='./loss-case-response')return {LossCaseResponse:({month,caseKey,embedded})=>React.createElement('section',{'data-saved-case':caseKey,'data-month':month,'data-station-view':embedded},'Saved redispute status and evidence')};
  if(id.startsWith('@/'))return load(path.join('src',id.slice(2)));
  if(id.startsWith('.') && file.includes('src/lib/'))return load(path.join(path.dirname(file),id));
  if(id.startsWith('.'))return new Proxy({},{get:()=>()=>null});
  return require(id);
 },m,m.exports);return m.exports;
}
const {RecoveryForm}=load('src/components/nl-loss-cases.tsx');
const row={month:'2026-09',case_key:'630453518946',amount:22990,report:'nl',source_status:'Recoverable',details:{},recovery:null};
function render(redispute){return renderToStaticMarkup(React.createElement(RecoveryForm,{row:{...row,redispute},outcomes:[],settings:null,canEdit:true,canRecovered:false}));}
for(const state of ['awaiting_station','awaiting_review','returned','approved','with_vendor'])test(`expanded ${state} opens saved redispute, not blank recovery`,()=>{
 const html=render({enabled:true,workflow_status:state});
 assert.match(html,/Redispute · evidence &amp; status/);
 assert.match(html,/data-saved-case="630453518946"/);
 assert.match(html,/data-station-view="true"/);
 assert.doesNotMatch(html,/Select an outcome|Save recovery|Loading recovery/);
});
test('ordinary recovery still loads its payroll checks',()=>{
 const html=render(null);assert.match(html,/Loading recovery/);assert.doesNotMatch(html,/data-saved-case/);
});
