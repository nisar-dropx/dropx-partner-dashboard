import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConnectUnread } from './connect-unread.ts';
import { pushSignature, validPushSignature } from './connect-push-auth.ts';

test('Connect counts use all scoped notices, only owned cases and currently published updates', async () => {
  const calls=[];
  const tables={communication_announcement_recipients:[{announcement_id:'a'}],communication_announcements:[{id:'a'}],communication_case_reporters:[{case_id:'mine'}],mob_app_notifications:[{id:'n1',data:{caseId:'mine'}},{id:'n2',data:{caseId:'other'}},{id:'n3',data:{caseId:'mine'}}]};
  const db={from(table){ const q={then(resolve){return Promise.resolve({data:tables[table],error:null}).then(resolve)}}; for(const method of ['select','eq','is','in','or'])q[method]=(...args)=>{calls.push([table,method,...args]);return q};return q; }};
  assert.deepEqual(await loadConnectUnread(db,{companyId:'co',profileType:'employee',id:'me'}),{updates:1,cases:{mine:['n1','n3']},total:3});
  for(const table of Object.keys(tables)) assert(calls.some(c=>c[0]===table && c[1]==='eq' && c[2]==='company_id' && c[3]==='co'));
  assert(calls.some(c=>c[2]==='recipient_account_id'&&c[3]==='me'));
  assert(calls.some(c=>c[2]==='reporter_account_id'&&c[3]==='me'));
  assert(calls.some(c=>c[0]==='mob_app_notifications'&&c[2]==='read_at'&&c[3]===null));
  assert(!calls.some(c=>c[1]==='limit')); // Never capped at the bell's latest 50.
});
test('database failures do not become a false zero unread count', async()=>{
  const db={from(){const q={select(){return q},eq(){return q},is(){return q},then(resolve){return Promise.resolve({error:new Error('offline')}).then(resolve)}};return q;}};
  await assert.rejects(loadConnectUnread(db,{companyId:'co',profileType:'employee',id:'me'}),/offline/);
});
test('relay rejects missing credentials, tampering and stale requests',()=>{
  const secret='a'.repeat(64), timestamp=String(Date.now()), body=JSON.stringify({notificationId:'id'}), signature=pushSignature(secret,timestamp,body);
  assert(validPushSignature(secret,timestamp,body,signature));
  assert(!validPushSignature('',timestamp,body,signature));
  assert(!validPushSignature(secret,timestamp,body+'x',signature));
  assert(!validPushSignature(secret,timestamp,body,signature,Number(timestamp)+61000));
  assert(!validPushSignature(secret,timestamp,body,'bad'));
});
test('read receipts are preview-safe, account/case scoped and only clear displayed IDs',()=>{
  const route=readFileSync(new URL('../../app/api/connect/communication-center/route.ts',import.meta.url),'utf8');
  const read=route.slice(route.indexOf('export async function PATCH'));
  assert(read.indexOf('connectPreviewCookieName')<read.indexOf('read_case'));
  assert.match(read,/ownsCase\(account.companyId, account.profileType, account.id, caseId\)/);
  assert.match(read,/contains\("data", \{ caseId \}\)\.in\("id", ids\)/);
});
test('Connect menu badges exist in desktop and mobile, and conversation deep links are passed',()=>{
  const ui=readFileSync(new URL('../components/connect-login-flow.tsx',import.meta.url),'utf8');
  assert.equal((ui.match(/className="dx-connect-unread"/g)||[]).length,4);
  const css=readFileSync(new URL('../../app/globals.css',import.meta.url),'utf8');
  assert.match(css,/\.dx-desktop-nav nav button:has\(> \.dx-connect-unread\)\s*\{\s*grid-template-columns: 20px minmax\(0, 1fr\) auto;/);
  assert.match(ui,/initialCaseId=\{connectTarget.caseId\}/);
  assert.match(ui,/readOnly=\{userPreview\}/);
  const bridge=readFileSync(new URL('../components/connect-native-bridge.tsx',import.meta.url),'utf8');
  assert(bridge.indexOf('await listen(push, "registration"') < bridge.indexOf('await push.register()'));
});
