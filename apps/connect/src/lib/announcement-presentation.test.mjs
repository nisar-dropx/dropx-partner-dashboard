import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { announcementParagraphs } from './announcement-presentation.ts';
const deadline = 'on or before 15 October 2026';
const sentence = `For this first-month transition only, one additional payout for approved corrections will be processed ${deadline}.`;
const body = `Attendance update.\n\n${sentence}\n\nContact your Cluster Manager.`;
const presentation = { emphasis: [deadline], callouts: [sentence] };
test('deadline is bold inside one callout while other paragraphs stay unchanged', () => {
  const blocks = announcementParagraphs(body, presentation);
  assert.equal(blocks.length, 3); assert.deepEqual(blocks.map(block => block.callout), [false,true,false]);
  assert.deepEqual(blocks[1].parts.filter(part => part.bold), [{text: deadline, bold:true}]);
  assert.equal(blocks.map(block => block.parts.map(part => part.text).join('')).join('\n\n'), body);
});
test('no date or salary rule is hardcoded; malformed options and unmatched emphasis remain safe', () => {
  for (const data of [undefined,null,3,{}, {emphasis:[null,5],callouts:'invalid'}]) {
    assert.ok(announcementParagraphs(body,data).every(block => !block.callout && !block.parts.some(part => part.bold)));
  }
  assert.deepEqual(announcementParagraphs('Pay (A+B) <script>alert(1)</script>', {emphasis:['(A+B)']}), [{callout:false,parts:[{text:'Pay ',bold:false},{text:'(A+B)',bold:true},{text:' <script>alert(1)</script>',bold:false}]}]);
});
test('popup and Updates share the same safe renderer; mobile callout wraps', () => {
  const component = fs.readFileSync(new URL('../components/announcement-body.tsx',import.meta.url),'utf8');
  const css = fs.readFileSync(new URL('../components/announcement-body.module.css',import.meta.url),'utf8');
  assert.match(component, /<strong/); assert.doesNotMatch(component, /dangerouslySetInnerHTML/);
  for (const file of ['connect-notice.tsx','connect-communication-center.tsx']) assert.match(fs.readFileSync(new URL(`../components/${file}`,import.meta.url),'utf8'), /<AnnouncementBody/);
  assert.match(css, /overflow-wrap: anywhere/); assert.match(css, /font-weight: 800/); assert.match(css, /max-width: 600px/);
});
