import test from 'node:test';
import assert from 'node:assert/strict';
import { betaFlexGuide, betaFlexGuideEnabled, flexGuideSteps } from './beta-flex-guide.ts';
import { betaAmazonOtpCopy } from './beta-amazon-otp-copy.ts';
import { guidanceLanguages, stationGuidanceLanguage } from './beta-guidance.ts';
import { flexScreenExamples, flexScreenCopy } from './beta-flex-screens.ts';
import { readFileSync, readdirSync } from 'node:fs';

test('guide requires both the isolated response and the exact selected email-pilot account', () => {
  const beta = { workspace:'workforce', profileType:'workforce', onboardingBeta:true, activationStage:'amazon_email_pilot:sent' };
  assert.equal(betaFlexGuideEnabled(beta, true), true);
  for (const change of [{workspace:'people'}, {profileType:'employee'}, {onboardingBeta:false}, {activationStage:null}, {activationStage:'legacy_pilot:sent'}]) {
    assert.equal(betaFlexGuideEnabled({...beta, ...change}, true), false);
  }
  for (const isolated of [false, undefined]) assert.equal(betaFlexGuideEnabled(beta, isolated), false);
  // A different ordinary profile on the same login must never inherit the beta UI.
  assert.equal(betaFlexGuideEnabled({workspace:'workforce',profileType:'workforce',id:'DF1095'},true),false);
});

test('every supported station language has all guide screens and all OTP/resend/error states', () => {
  const ids = flexGuideSteps.map(step => step.id).sort();
  const copyKeys = Object.keys(betaFlexGuide.en).sort();
  const otpKeys = Object.keys(betaAmazonOtpCopy.en).sort();
  for (const {code} of guidanceLanguages) {
    const copy = betaFlexGuide[code];
    assert.deepEqual(Object.keys(copy).sort(),copyKeys,code);
    assert.deepEqual(Object.keys(copy.steps).sort(),ids,code);
    assert.deepEqual(Object.keys(betaAmazonOtpCopy[code]).sort(),otpKeys,code);
    for (const [key, text] of Object.entries(copy)) if(key !== 'steps') assert.ok(text.trim(),`${code}.${key}`);
    for (const [key, text] of Object.entries(betaAmazonOtpCopy[code])) assert.ok(text.trim(),`${code}.otp.${key}`);
    for (const id of ids) {
      const item = copy.steps[id];
      assert.ok(item.title && item.expect && item.help,`${code}.${id}`);
      assert.equal(item.actions.length,2,`${code}.${id} stays compact`);
      if(code !== 'en') {
        assert.notEqual(item.title,betaFlexGuide.en.steps[id].title);
        assert.notDeepEqual(item.actions,betaFlexGuide.en.steps[id].actions);
      }
    }
  }
  assert.equal(stationGuidanceLanguage('Kerala'),'ml');
  assert.equal(stationGuidanceLanguage('Andhra Pradesh'),'te');
  assert.equal(stationGuidanceLanguage(null),'en');
});

test('source-backed guide keeps UAN type, old-account consequences, training and status boundaries explicit', () => {
  assert.equal(flexGuideSteps.find(step=>step.id==='uan').source,'dropx');
  assert.equal(flexGuideSteps.find(step=>step.id==='uan').pages,'16');
  for(const {code} of guidanceLanguages) {
    const copy=betaFlexGuide[code];
    assert.match(copy.steps.uan.actions.join(' '),/e-Shram/);
    assert.match(copy.steps.uan.actions.join(' '),/EPFO\/PF/);
    assert.match(copy.steps.account.actions.join(' '),/Agree and Remove/);
    assert.match(copy.steps.learning.actions.join(' '),/LM Learning/);
    assert.match(copy.steps.learning.actions.join(' '),/buddy training/i);
  }
  assert.match(betaFlexGuide.en.evidence,/does not change your registration status/);
  assert.match(betaFlexGuide.en.statusBody,/not yet confirmed here/);
  assert.match(betaFlexGuide.en.steps.signin.expect,/password alone does not finish/);
  assert.doesNotMatch(JSON.stringify(betaFlexGuide),/Amazon@123|500419|7f382313/);
});

test('each guide step has redacted examples and complete regional captions', () => {
  assert.deepEqual(Object.keys(flexScreenExamples).sort(), flexGuideSteps.map(s => s.id).sort());
  const ids = Object.values(flexScreenExamples).flat().sort();
  const base = new URL('../../public/guide/amazon-onboarding/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'));
  assert.deepEqual(manifest.map(s => s.id).sort(), ids);
  assert.deepEqual(readdirSync(base).sort(), ['manifest.json', ...ids.map(id => `${id}.png`)].sort());
  for (const item of manifest) {
    assert.equal(item.flattened, true);
    const bytes = readFileSync(new URL(`${item.id}.png`, base));
    assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), item.width);
    assert.equal(bytes.readUInt32BE(20), item.height);
    // No embedded EXIF, comments or source document in published PNGs.
    for (let at = 8; at < bytes.length;) {
      const length = bytes.readUInt32BE(at), kind = bytes.toString('ascii', at + 4, at + 8);
      assert.ok(['IHDR','IDAT','IEND','pHYs'].includes(kind), `${item.id}: unexpected ${kind}`);
      at += length + 12;
    }
  }
  const sensitiveScreens = ['flex-signin','about-name','about-contact','licence-front','licence-back','licence-review','profile-photo','bgc-details','bgc-address','eshram-uan'];
  for (const id of sensitiveScreens) assert.ok(manifest.find(s => s.id === id).redactedRegions > 0, id);
  for (const { code } of guidanceLanguages) {
    const copy = flexScreenCopy[code];
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(flexScreenCopy.en).sort(), code);
    assert.deepEqual(Object.keys(copy.examples).sort(), ids, code);
    for (const id of ids) {
      assert.equal(copy.examples[id].length, flexScreenCopy.en.examples[id].length, `${code}.${id}`);
      assert.ok(copy.examples[id].every(text => text.trim()));
      if (code !== 'en') assert.notDeepEqual(copy.examples[id], flexScreenCopy.en.examples[id]);
    }
    assert.match(copy.examples['eshram-uan'].join(' '), /e-Shram/);
    assert.match(copy.examples['eshram-uan'].join(' '), /PF UAN/);
    assert.match(copy.examples['account-resolve'][0], /TL/);
  }
  assert.doesNotMatch(JSON.stringify(flexScreenCopy), /Amazon@123|500419|7f382313|resend\.app/);
});
