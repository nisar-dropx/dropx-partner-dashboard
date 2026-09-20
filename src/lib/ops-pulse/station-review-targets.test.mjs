import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStationReviewTargets,clearanceVariance} from './station-review-targets.ts';
import {hawkeyeMetricDefinitions,hawkeyeTargetKey,hawkeyeValueForTarget} from './hawkeye.ts';
test('station-specific targets allow blank, preserve zero, reject invalid values',()=>{
  assert.deepEqual(parseStationReviewTargets('07:30','95.5'),{clearanceCutoff:'07:30',emdNoonTarget:95.5});
  assert.deepEqual(parseStationReviewTargets('',''),{clearanceCutoff:null,emdNoonTarget:null});
  assert.equal(parseStationReviewTargets('00:00','0').emdNoonTarget,0);
  for(const [time,pct] of [['25:00','90'],['9:00','90'],['07:00','101'],['07:00','-1'],['','NaN']])assert.throws(()=>parseStationReviewTargets(time,pct));
});
test('clearance alert uses service-day station cutoff, including overnight',()=>{
  assert.equal(clearanceVariance('2026-09-03T07:30:00+05:30','2026-09-03','07:30'),0);
  assert.equal(clearanceVariance('2026-09-03T07:45:00+05:30','2026-09-03','07:30'),15);
  assert.equal(clearanceVariance('2026-09-04T00:10:00+05:30','2026-09-03','23:30'),40);
  assert.equal(clearanceVariance(null,'2026-09-03','07:30'),null);
  assert.equal(clearanceVariance('2026-09-03T07:45:00+05:30','2026-09-03',null),null);
});
test('every Hawkeye metric has an editable stable key and still reads original source field',()=>{
  assert.equal(new Set(hawkeyeMetricDefinitions.map(hawkeyeTargetKey)).size,32);
  for(const definition of hawkeyeMetricDefinitions){
    assert.equal(hawkeyeValueForTarget({metrics:{[definition.label]:0.91}},hawkeyeTargetKey(definition)),0.91);
    if(definition.targetKey)assert.equal(hawkeyeTargetKey(definition),definition.targetKey);
  }
});
