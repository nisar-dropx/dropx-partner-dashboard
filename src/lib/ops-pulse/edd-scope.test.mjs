import test from 'node:test';
import assert from 'node:assert/strict';
import { changeEddScope, eddScopeOptions, emptyEddScope, scopedStationCodes } from './edd-scope.ts';

const codes = ['QLDA','KLZA','TIRC','SPBE'];
const clusters = [{value:'kl1',label:'KL manager',stations:['QLDA','KLZA','UNAUTHORISED']},
 {value:'ap1',label:'AP manager',stations:['TIRC']}, {value:'od1',label:'OD manager',stations:['SPBE']},
 {value:'mixed',label:'Regional manager',stations:['KLZA','TIRC']}];

test('KL narrows stations and manager choices, including a manager spanning regions', () => {
 const scope = {...emptyEddScope(), regions:['KL']};
 assert.deepEqual(scopedStationCodes(codes,clusters,scope),['QLDA','KLZA']);
 const options = eddScopeOptions(codes,clusters,scope);
 assert.deepEqual(options.stations,['KLZA','QLDA']);
 assert.deepEqual(options.clusters.map(c=>c.value),['kl1','mixed']);
 assert(!options.stations.includes('UNAUTHORISED'));
});

test('region changes clear incompatible child selections, including multi-select', () => {
 const prior={regions:['AP'],clusters:['ap1','mixed'],stations:['TIRC']};
 const next=changeEddScope(codes,clusters,prior,'regions',['KL']);
 assert.deepEqual(next,{regions:['KL'],clusters:['mixed'],stations:[]});
 assert.deepEqual(scopedStationCodes(codes,clusters,next),['KLZA']);
 const reset=changeEddScope(codes,clusters,next,'clusters',[]);
 assert.deepEqual(scopedStationCodes(codes,clusters,reset),['QLDA','KLZA']);
});

test('station and cluster choices remain expandable and filter each other', () => {
 const scope={regions:['KL'],clusters:[],stations:['QLDA']};
 const options=eddScopeOptions(codes,clusters,scope);
 assert.deepEqual(options.stations,['KLZA','QLDA']);
 assert.deepEqual(options.clusters.map(c=>c.value),['kl1']);
 const next=changeEddScope(codes,clusters,scope,'stations',['QLDA','KLZA']);
 assert.deepEqual(scopedStationCodes(codes,clusters,next),['QLDA','KLZA']);
});

test('refresh targets are exactly the filtered intersection; empty is never all', () => {
 assert.deepEqual(scopedStationCodes(codes,clusters,{regions:['KL','AP'],clusters:['mixed'],stations:[]}),['KLZA','TIRC']);
 assert.deepEqual(scopedStationCodes(codes,clusters,{regions:['KL'],clusters:['od1'],stations:[]}),[]);
 assert.deepEqual(scopedStationCodes([],clusters,emptyEddScope()),[]);
 assert.deepEqual(scopedStationCodes(codes,clusters,{regions:[],clusters:[],stations:['UNAUTHORISED']}),[]);
});
