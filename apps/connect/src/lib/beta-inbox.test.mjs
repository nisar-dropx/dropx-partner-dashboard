import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as mail from './beta-inbox.ts';
import { isIsolatedAmazonOtpAccount } from './beta-amazon-otp.ts';

test('password reset links keep their token but reject lookalike hosts, scripts and credentials', () => {
 const m={sender:'Amazon <account-update@amazon.in>',subject:'Reset password'};
 const urls=['https://www.amazon.in/ap/forgotpassword?token=example','https://amazon.in.evil.test/ap/reset','https://evil@amazon.in/ap/reset','http://amazon.in/ap/reset','https://amazon.in:444/ap/reset','javascript:alert(1)'];
 assert.deepEqual(mail.betaMailLinks(m,urls.join(' ')),[{url:urls[0],label:'Open Amazon password reset'}]);
 assert.deepEqual(mail.betaMailLinks({...m,sender:'support@notamazon.in'},urls[0]),[]);
});
test('IDfy emails keep verification and UAN actions without tracking pixels',()=>{
 const m={sender:'operations@email.idfy.in',subject:'Your verification'};
 assert.equal(mail.betaMailLinks(m,'https://portal.idfy.com/tokens?p=example https://360.idfy.com/noauth/example https://idfy.com/logo.png').length,2);
});
test('full message must match both reserved recipient and the stored internet message ID',()=>{
 const m={id:'source',message_id:'<message>',to:['person@drivers.example']};
 assert.equal(mail.receivedMailMatches(m,'PERSON@drivers.example','<message>'),true);
 assert.equal(mail.receivedMailMatches(m,'other@drivers.example','<message>'),false);
 assert.equal(mail.receivedMailMatches(m,'person@drivers.example','<another>'),false);
});
test('only a single fresh Amazon code gets a copy action; old and ambiguous codes do not',()=>{
 const m={sender:'account-update@amazon.in',received_at:'2026-10-16T10:00:00Z'};
 assert.equal(mail.mailCode(m,'OTP: 123456',Date.parse('2026-10-16T10:02:00Z')),'123456');
 assert.equal(mail.mailCode(m,'OTP: 123456',Date.parse('2026-10-16T11:02:00Z')),null);
 assert.equal(mail.mailCode(m,'OTP: 123456 OTP: 654321',Date.parse('2026-10-16T10:02:00Z')),null);
 assert.equal(mail.mailCode({...m,sender:'untrusted@example.test'},'OTP: 123456',Date.parse('2026-10-16T10:02:00Z')),null);
});
test('mail HTML is rendered as inert text without remote images or executable tags',()=>{
 const body=mail.plainMail('<script>bad()</script><style>x{}</style><p>Hello &amp; welcome</p><img src="https://example.test/track"><p>Next</p>');
 assert.equal(body,'Hello & welcome\nNext');
});

function load(file,mocks){const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{assert.ok(id in mocks,id);return mocks[id]},m,m.exports);return m.exports;}
function fixture(changes={}){
 const account={id:'11111111-1111-1111-1111-111111111111',companyId:'company',profileType:'workforce',workspace:'workforce',onboardingBeta:true,activationStage:'amazon_email_pilot:sent',...changes};
 const own={id:'22222222-2222-2222-2222-222222222222',company_id:'company',candidate_id:account.id,subject:'Own mail',sender:'account-update@amazon.in',preview:'Saved mail',received_at:'2026-10-16T10:00:00Z',internet_message_id:'own'};
 const rows={workforce_amazon_email_pilot_candidates:[{id:account.id,company_id:'company',alias_email:'own@example.test',closed_at:null}],workforce_amazon_email_pilot_messages:[own,{...own,id:'33333333-3333-3333-3333-333333333333',candidate_id:'other',subject:'Foreign'},{...own,company_id:'another',subject:'Other company'}]};
 const db={from(table){assert.ok(table in rows);let list=rows[table],single=false;const q={select(){return q},eq(k,v){list=list.filter(r=>r[k]===v);return q},is(k,v){list=list.filter(r=>(r[k]??null)===v);return q},order(){return q},range(a,b){list=list.slice(a,b+1);return q},maybeSingle(){single=true;return q},then(resolve){return Promise.resolve({data:single?list[0]??null:list,error:null}).then(resolve)}};return q}};
 const helper=load('./beta-private-account.ts',{'./connect-auth':{requireConnectAccount:async(t,id)=>{if(id!==account.id)throw Error();return account}},'./connect-preview':{resolveConnectPreview:async()=>changes.preview?{}:null},'./supabase-admin':{supabaseAdmin:db},'./beta-amazon-otp':{isIsolatedAmazonOtpAccount}});
 let sourceCalls=0;
 const api=load('../../app/api/connect/beta-inbox/route.ts',{'next/server':{NextResponse:{json:(v,o)=>Response.json(v,o)}},'@/lib/beta-private-account':helper,'@/lib/beta-inbox':mail,'@/lib/beta-inbox-source':{betaReceivedMail:async()=>{sourceCalls++;return null}}});
 return {api,account,sourceCalls:()=>sourceCalls};
}
const request=(account,extra='')=>({nextUrl:new URL(`https://one.example/api/connect/beta-inbox?profileType=workforce&accountId=${account.id}${extra}`)});
test('inbox list and detail return only the signed-in beta candidate in their company',async()=>{
 const f=fixture();let r=await f.api.GET(request(f.account));assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/private, no-store/);const data=await r.json();assert.equal(data.messages.length,1);assert.equal(data.messages[0].subject,'Own mail');
 r=await f.api.GET(request(f.account,'&messageId=33333333-3333-3333-3333-333333333333'));assert.equal(r.status,404);assert.equal(f.sourceCalls(),0);
 r=await f.api.GET(request(f.account,'&messageId=22222222-2222-2222-2222-222222222222'));assert.equal(r.status,200);const detail=await r.json();assert.equal(detail.excerpt,true);assert.equal(detail.internet_message_id,undefined);
});
test('canonical, preview, non-beta and arbitrary account selectors cannot access inbox',async()=>{
 for(const change of [{onboardingBeta:false},{activationStage:null},{readOnlyPreview:true},{preview:true},{workspace:'people'}]){const f=fixture(change);assert.equal((await f.api.GET(request(f.account))).status,403);assert.equal(f.sourceCalls(),0);}
 const f=fixture();assert.equal((await f.api.GET(request({id:'someone-else'}))).status,403);
});
