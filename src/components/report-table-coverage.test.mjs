import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const root=path.resolve(new URL('../',import.meta.url).pathname);
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):e.name.endsWith('.tsx')?[path.join(dir,e.name)]:[]);}
test('OpsPulse routes and shared components do not leave table sections without shared controls',()=>{
 const missed=[];
 for(const file of [...files(path.join(root,'app/ops-pulse')),...files(path.join(root,'components'))]){
  if(file.endsWith('/report-table.tsx'))continue;
  const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  function visit(n){if(ts.isJsxOpeningElement(n)&&n.tagName.getText(source)==='table')missed.push(path.relative(root,file));ts.forEachChild(n,visit)}visit(source);
 }
 assert.deepEqual(missed,[]);
});
