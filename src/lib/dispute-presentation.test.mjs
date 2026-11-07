import test from 'node:test';
import assert from 'node:assert/strict';
import {attendanceLabel,attendanceDateChoices} from './dispute-presentation.ts';
const days=[{date:'1',attendanceKnown:true,units:1},{date:'2',attendanceKnown:true,units:0},{date:'3',attendanceKnown:true,units:0.5},{date:'4',attendanceKnown:false,units:0},{date:'5',attendanceKnown:true,units:null},{date:'6',attendanceKnown:true,units:10}];
test('missing-day picker only shows known uncounted days, never present, half or unavailable days',()=>assert.deepEqual(attendanceDateChoices(days,'attendance','I worked but the day is missing').map(d=>d.date),['2']));
test('half-day picker and broad correction use the appropriate days',()=>{assert.deepEqual(attendanceDateChoices(days,'attendance','Full day shown as half day').map(d=>d.date),['3']);assert.equal(attendanceDateChoices(days,'attendance','Wrong attendance').length,6);assert.equal(attendanceDateChoices(days,'attendance','').length,0);assert.equal(attendanceDateChoices(days,'fuel','Wrong kilometres').length,6);});
test('plain labels do not turn unknown or aggregate attendance into absence or a single present day',()=>{assert.deepEqual(days.map(attendanceLabel),['Present','Not counted','Half day','Not available','Not available','10 recorded days · check source']);assert.equal(attendanceLabel(undefined),'Not available');});
