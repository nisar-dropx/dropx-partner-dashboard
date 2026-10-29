const ts = require('typescript'), fs = require('fs'), assert = require('node:assert/strict');
function load(file, dependencies = {}) {
  const m = {exports:{}};
  new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id => {
    if (id in dependencies) return dependencies[id];
    throw Error(`Unexpected dependency: ${id}`);
  }, m, m.exports);
  return m.exports;
}
(async () => {
  const retired = load('src/app/api/ops-pulse/losses/clarifications/route.ts');
  for (const method of ['GET','POST']) {
    const response = await retired[method]();
    assert.equal(response.status,410);
  }
  const lifecycle = load('src/app/api/ops-pulse/losses/lifecycle/route.ts', {
    '@/lib/authorization': {getAuthorization: async()=>({userId:'reviewer'}),hasPermission:()=>true},
    '@/lib/ops-pulse/nl-loss-lifecycle': new Proxy({}, {get(){return ()=>{throw Error('Retired request reached mutation');}}}),
  });
  const response = await lifecycle.POST(new Request('https://ops.test/api/lifecycle', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({month:'2026-09',case_key:'shipment',action:'clarify',note:'Old client request',version:1}),
  }));
  assert.equal(response.status,410);
  console.log('PASS retired clarification read/write and lifecycle endpoints; no database mutation');
})().catch(e=>{console.error(e);process.exitCode=1});
