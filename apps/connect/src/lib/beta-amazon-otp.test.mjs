import assert from 'node:assert/strict';
import test from 'node:test';
import { latestAmazonOtp, amazonOtpView, isIsolatedAmazonOtpAccount } from './beta-amazon-otp.ts';

const now = Date.parse('2026-10-10T08:00:00Z');
const message = (changes={}) => ({ id:'first', sender:'account-update@amazon.co.uk', subject:'Verify your new Amazon account',
  preview:'To verify your email address, please use the following One Time Password (OTP): 123456 Do not share this OTP.',
  received_at:new Date(now-30_000).toISOString(), ...changes });

test('extracts the emailed code with leading zeros; never exposes raw mail',()=>{
  const result=latestAmazonOtp([message({preview:'Your security code is 001234.'})],now);
  assert.equal(result.code,'001234');assert.equal(result.state,'received');assert.deepEqual(Object.keys(result).sort(),['code','id','receivedAt','state']);
});
test('invitation, IDfy, unrelated mail and deceptive sender domains do not become OTPs',()=>{
  for(const changes of [{sender:'no-reply@logistics.amazon.co.uk'},{sender:'account-update@amazon.co.uk.evil.test'},
    {sender:'Amazon <phishing@evil.test>'},{subject:'Join DROPX for delivery services'},
    {subject:'Reset your password'},{preview:'Reference number 123456'}]) assert.equal(latestAmazonOtp([message(changes)],now),null);
  assert.equal(latestAmazonOtp([message({sender:'Amazon <account-update@amazon.in>'})],now).code,'123456');
});
test('newest email wins even if code repeats; out-of-order arrival cannot restore the old code',()=>{
  const second=message({id:'second',received_at:new Date(now-1000).toISOString(),preview:'OTP: 654321'});
  assert.equal(latestAmazonOtp([second,message()],now).code,'654321');
  second.preview='OTP: 123456';assert.equal(latestAmazonOtp([message(),second],now).id,'second');
});
test('unreadable or ambiguous newest email never falls back to an older OTP',()=>{
  for(const preview of ['OTP: unreadable','OTP: 1234567','OTP: 123456 or security code: 654321']) {
    const latest=latestAmazonOtp([message(),message({id:'second',received_at:new Date(now).toISOString(),preview})],now);
    assert.equal(latest.state,'unreadable');assert.equal(latest.code,null);
  }
});
test('old codes are withheld without claiming Amazon expiry; malformed dates are ignored',()=>{
  assert.equal(latestAmazonOtp([message({received_at:new Date(now-601_000).toISOString()})],now).code,null);
  assert.equal(latestAmazonOtp([message({received_at:'invalid'})],now),null);
  assert.equal(latestAmazonOtp([message({received_at:new Date(now+120_000).toISOString()})],now),null);
  const latest=latestAmazonOtp([message()],now);
  assert.equal(amazonOtpView(latest,null,now+601_000).state,'older');
});
test('resend hides old code until a later message, handles same-code resend and delayed mail',()=>{
  const latest=latestAmazonOtp([message()],now);
  const wait={messageId:latest.id,receivedAt:latest.receivedAt,startedAt:now};
  assert.deepEqual(amazonOtpView(latest,wait,now),{state:'waiting',code:null,delayed:false});
  assert.equal(amazonOtpView(latest,wait,now+91_000).delayed,true);
  assert.equal(amazonOtpView({...latest,id:'older-duplicate',receivedAt:new Date(now-60_000).toISOString()},wait,now).state,'waiting');
  assert.equal(amazonOtpView({...latest,id:'resent',receivedAt:new Date(now+1000).toISOString()},wait,now+1000).code,'123456');
  const emptyWait={messageId:null,receivedAt:null,startedAt:now};
  assert.equal(amazonOtpView(latest,emptyWait,now).state,'waiting');
  assert.equal(amazonOtpView(null,emptyWait,now).state,'waiting');
  assert.equal(amazonOtpView(null,null,now).state,'empty');
});
test('only isolated beta workforce accounts can access OTPs; preview and canonical accounts excluded',()=>{
  const beta={workspace:'workforce',profileType:'workforce',onboardingBeta:true,activationStage:'amazon_email_pilot:sent'};
  assert.equal(isIsolatedAmazonOtpAccount(beta),true);
  for(const change of [{onboardingBeta:false},{readOnlyPreview:true},{activationStage:'amazon_pilot:sent'},{workspace:'people'},{profileType:'contractor'}])assert.equal(isIsolatedAmazonOtpAccount({...beta,...change}),false);
});
