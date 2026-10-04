import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pilotStatus,withLiveAmazonEvidence} from './amazon-pilot.ts';
const now=Date.parse('2026-10-02T12:00:00Z');
const status=(evidence={},extra={})=>pilotStatus({evidence,trial_completed_at:null,closed_at:null,...extra},now);
test('invitation does not imply registration or BGC completion',()=>{
 assert.equal(status({invitationStatus:'queued'}).stage,'invitation_pending');
 const p=status({invitationStatus:'sent',providerId:'provider'});assert.equal(p.stage,'registration_pending');
});
test('registration has no internal training or readiness gate',()=>{const p=status({providerId:'p'});assert.equal(p.stage,'registration_pending');assert.doesNotMatch(p.instruction,/trial|ready|training/i);assert.deepEqual(p,status({providerId:'p'},{trial_completed_at:'2026-10-02T10:00:00Z'}));});
test('actual DA registration pendency comes from report; vendor waits are distinct',()=>{
 assert.equal(status({providerId:'p',report:{categories:'9 - DA Pending Filling BGC details',action_item:'DA needs to complete filling BGC details'}}).stage,'registration_pending');
 assert.equal(status({providerId:'p',report:{categories:'10-DA Pending BGC clearance by BGC Vendor'}}).stage,'verification_pending');
 assert.equal(status({providerId:'p',report:{categories:'13-DA Pending Account Provisioning completion from Amazon'}}).stage,'verification_pending');
});
test('inactive and absent report never imply activation',()=>{assert.equal(status({providerId:'p',lscStatus:'INACTIVE'}).stage,'registration_pending');assert.equal(status({providerId:'p'}).stage,'registration_pending');});
test('a stale SCC record is not current package eligibility',()=>{assert.equal(status({providerId:'p',employeeId:'2001',sccAt:'2026-09-20T12:00:00Z'}).stage,'registration_pending');assert.equal(status({providerId:'p',employeeId:'2001',sccAt:'2026-10-02T10:00:00Z'}).stage,'scc_available');});
test('identity conflicts override apparent delivery activity',()=>assert.equal(status({conflict:true,employeeId:'2001',firstDelivery:'2026-10-02'}).stage,'exception'));
test('BGC failure remains actionable even if an old SCC match exists',()=>assert.equal(status({providerId:'p',employeeId:'2001',sccAt:'2026-10-02T10:00:00Z',report:{categories:'12-DA BGC Failed by BGC Vendor'}}).stage,'exception'));
test('report freshness is exposed to the associate',()=>assert.equal(status({reportDate:'2026-09-29'}).stale,true));
test('live invitation evidence replaces a stale queued snapshot immediately',()=>{
 const evidence=withLiveAmazonEvidence({invitationStatus:'queued',providerId:null},{status:'sent',external_reference:'amzn1.flex.provider.live',completed_at:'2026-10-04T11:46:18Z'},null);
 assert.equal(evidence.invitationStatus,'sent');
 assert.equal(evidence.providerId,'amzn1.flex.provider.live');
 assert.equal(status(evidence).stage,'registration_pending');
});
test('activation-only registration is reachable and submits to beta draft storage',()=>{
 const flow=readFileSync(new URL('../components/connect-login-flow.tsx',import.meta.url),'utf8');
 const profile=readFileSync(new URL('../components/connect-profile-app.tsx',import.meta.url),'utf8');
 assert.match(flow,/account\.activationOnly && next !== "activation" && next !== "profile"/);
 assert.match(flow,/!\(account\.activationOnly && next === "activation"\)/);
 assert.match(flow,/>Registration<\/button>/);
 assert.match(profile,/if \(account\.activationOnly\)[\s\S]*?_beta_status = "submitted"[\s\S]*?fetch\("\/api\/connect\/profile-draft"/);
 const betaBranch=profile.slice(profile.indexOf('if (account.activationOnly)'),profile.indexOf('const data = new FormData(formRef.current)',profile.indexOf('if (account.activationOnly)')));
 assert.doesNotMatch(betaBranch,/fetch\(endpoint/);
 assert.match(profile,/!account\.activationOnly \|\| !\["reference", "employeeId", "dropxId"\]\.includes\(label\)/);
 assert.match(profile,/Biometric ID · attendance only/);
});
test('joining API uses only the later LSC Driver ID as operational identity',()=>{
 const route=readFileSync(new URL('../../app/api/connect/workforce-joining/route.ts',import.meta.url),'utf8');
 assert.match(route,/driverId:p\.evidence\.employeeId/);
 assert.match(route,/workforce_amazon_pilot_sources/);
 assert.match(route,/workforce_idfy_observations/);
 assert.match(route,/attendance_daily/);
 assert.match(route,/bgcChecks/);
 assert.doesNotMatch(route,/driverId:account\.reference/);
 assert.doesNotMatch(route,/dropxId:account\.reference/);
});
test('guided beta is limited to an explicitly enrolled pilot account',()=>{
 const auth=readFileSync(new URL('./connect-auth.ts',import.meta.url),'utf8');
 const activation=readFileSync(new URL('../components/connect-activation-status.tsx',import.meta.url),'utf8');
 assert.match(auth,/let onboardingBeta = false/);
 assert.match(auth,/if\(pilot\.data\)\{activationOnly=true;onboardingBeta=true;/);
  assert.match(activation,/if \(account\.onboardingBeta\) return <ConnectBetaOnboarding/);
});
test('isolated email pilot is visible without converting an active Workforce account',()=>{
 const auth=readFileSync(new URL('./connect-auth.ts',import.meta.url),'utf8');
 const flow=readFileSync(new URL('../components/connect-login-flow.tsx',import.meta.url),'utf8');
 const route=readFileSync(new URL('../../app/api/connect/workforce-joining/route.ts',import.meta.url),'utf8');
 const beta=readFileSync(new URL('../components/connect-beta-onboarding.tsx',import.meta.url),'utf8');
 assert.match(auth,/workforce_amazon_email_pilot_candidates/);
 assert.match(auth,/mobile: profile\.mobile \?\? null/);
 assert.match(auth,/onboardingBeta = true/);
 assert.doesNotMatch(auth,/emailPilot\.data\)\{activationOnly=true/);
 assert.match(flow,/account\.activationOnly \|\| account\.onboardingBeta/);
 assert.match(flow,/Amazon setup/);
 assert.match(route,/workforce_amazon_email_pilot_messages/);
 assert.match(route,/invitationUrl/);
 assert.match(route,/isolatedBeta:true/);
 assert.match(beta,/Open invitation/);
 assert.match(beta,/Copy link/);
 assert.match(beta,/private\/incognito window/);
 assert.match(beta,/com\.amazon\.flex\.rabbit/);
});
