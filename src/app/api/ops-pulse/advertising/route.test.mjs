import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import {readFileSync} from "node:fs";
function compile(file,mocks={}){const m={exports:{}};new Function("require","module","exports",ts.transpileModule(readFileSync(new URL(file,import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name=>{if(name in mocks)return mocks[name];throw Error(name);},m,m.exports);return m.exports;}
test("unauthenticated or read-only users cannot change advertising configuration",async()=>{
 for(const auth of [null,{readOnly:true}]) {
 const route=compile("./route.ts",{"@/lib/authorization":{getAuthorization:async()=>auth,hasPermission:()=>true},"@/lib/ops-pulse/cps-data":{cpsScope(){throw Error("Read before authorization")}},"@/lib/supabase-admin":{},"@/lib/supabase-pagination":{},"@/lib/ops-pulse/advertising":{},"@/lib/ops-pulse/advertising-data":{},"@/lib/ops-pulse/advertising-sync":{}});
 const response=await route.POST(new Request("https://ops.dropxlogistics.com/api/ops-pulse/advertising",{method:"POST",body:JSON.stringify({action:"settings"})}));assert.equal(response.status,400);assert.match((await response.json()).error,/permission/);
 }
});
