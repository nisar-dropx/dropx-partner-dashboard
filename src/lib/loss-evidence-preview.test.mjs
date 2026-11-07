import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const m={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync(new URL('./loss-evidence-preview.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(m,m.exports);
const {lossEvidencePreview:preview}=m.exports;
test('Drive file and folder stay on the source host and retain access resource keys',()=>{
 assert.equal(preview('https://drive.google.com/file/d/abc_123/view?resourcekey=key-4').embedUrl,'https://drive.google.com/file/d/abc_123/preview?resourcekey=key-4');
 assert.equal(preview('https://drive.google.com/drive/u/0/folders/abc_123').embedUrl,'https://drive.google.com/embeddedfolderview?id=abc_123#list');
 assert.equal(preview('https://drive.google.com/open?id=abc_123').embedUrl,'https://drive.google.com/file/d/abc_123/preview');
});
test('direct signed media URL is preserved intact',()=>{
 const url='https://files.example.test/photo.jpg?token=private';assert.equal(preview(url).href,url);assert.equal(preview(url).fileName,'photo.jpg');
 assert.equal(preview('https://files.example.test/video.mp4').video,true);
});
test('unsafe schemes and credentials cannot reach the viewer',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,x','http://files.test/a.pdf','https://user:password@files.test/a.pdf','not a link']) assert.equal(preview(url),null);
 assert.equal(preview('https://drive.google.com.evil.test/file/d/abc/view').embedUrl,undefined);
});
test('documents use the original provider without a third-party proxy',()=>{
 assert.equal(preview('https://docs.google.com/spreadsheets/d/abc-123/edit').embedUrl,'https://docs.google.com/spreadsheets/d/abc-123/preview');
 assert.equal(preview('https://unknown.test/file').embedUrl,undefined);
});
