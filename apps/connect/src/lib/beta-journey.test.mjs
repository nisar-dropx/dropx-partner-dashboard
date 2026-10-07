import test from 'node:test';
import assert from 'node:assert/strict';
import { betaJourney } from './beta-journey.ts';
import { betaGuidance, betaJourneyCopy, guidanceLanguages, stationGuidanceLanguage } from './beta-guidance.ts';

test('an early Amazon email does not skip buddy training or DropX registration',()=>{
  let state=betaJourney({invitationAvailable:true});
  assert.equal(state.stage,'buddy_training');
  assert.equal(state.ready,false);assert.equal(state.invitationUnlocked,false);
  state=betaJourney({continuationStatus:'continuing',invitationAvailable:true});
  assert.equal(state.stage,'dropx_registration_pending');
  assert.equal(state.ready,true);assert.equal(state.invitationUnlocked,false);
  state=betaJourney({continuationStatus:'continuing',registrationStatus:'submitted',invitationAvailable:true});
  assert.equal(state.stage,'registration_pending');assert.equal(state.invitationUnlocked,true);
});
test('existing submitted beta registration is preserved; returned and stopped cases do not unlock Amazon',()=>{
  assert.equal(betaJourney({registrationStatus:'submitted'}).invitationUnlocked,true);
  assert.equal(betaJourney({registrationStatus:'returned',continuationStatus:'continuing'}).invitationUnlocked,false);
  const stopped=betaJourney({registrationStatus:'confirmed',continuationStatus:'not_continuing',invitationAvailable:true});
  assert.equal(stopped.ready,false);assert.equal(stopped.invitationUnlocked,false);assert.equal(stopped.stage,'not_continuing');
});
test('a BGC email cannot push a new candidate past the first steps',()=>{
  assert.equal(betaJourney({bgcAction:true}).stage,'buddy_training');
  assert.equal(betaJourney({bgcAction:true,continuationStatus:'continuing'}).stage,'dropx_registration_pending');
  assert.equal(betaJourney({bgcAction:true,registrationStatus:'confirmed'}).stage,'bgc_action');
});
test('station state names and codes suggest guidance with a safe English fallback',()=>{
  for(const [state,code] of [['Kerala','ml'],[' KL ','ml'],['TN','ta'],['Tamil Nadu','ta'],['AP','te'],['TS','te'],['Andhra Pradesh','te'],['OD','or'],['Odisha','or'],['CG','hi'],['UP','hi'],['Karnataka','kn'],['unknown','en'],[null,'en']]) assert.equal(stationGuidanceLanguage(state),code);
  for(const lang of guidanceLanguages) for(const text of Object.values(betaJourneyCopy[lang.code])) assert.ok(text.trim());
  for(const lang of guidanceLanguages) for(const stage of ['attendance','registration','amazon']) assert.ok(betaGuidance[lang.code][stage].length>=2);
});
