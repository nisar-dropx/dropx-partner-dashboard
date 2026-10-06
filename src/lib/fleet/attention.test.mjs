import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fleetAttention} from './attention.ts';
const vehicle={id:'v',vehicleNo:'TEST1',stationCode:'KOZA',model:'Jeeto',status:'active',fuelType:'Diesel',ownershipType:'own',rentAmount:null,rentPeriod:null};
const data={today:'2026-10-05',vehicles:[vehicle],capabilities:{visibleSections:['vehicles','documents','service']},settings:{serviceWarningDays:14},vehicleStatuses:[],documentTypes:[],documents:[],findings:[],audits:[],payments:[],dailyKm:[]};
test('Missing rent has a specific actionable field, and saving either period clears it',()=>{
 const missing=fleetAttention(data);assert.equal(missing[0].category,'Rent setup');assert.equal(missing[0].vehicleId,'v');
 for(const period of ['monthly','daily'])for(const amount of [0,12000])assert.equal(fleetAttention({...data,vehicles:[{...vehicle,rentAmount:amount,rentPeriod:period}]}).length,0);
 assert.equal(fleetAttention({...data,vehicles:[{...vehicle,rentAmount:15000,rentPeriod:null}]}).length,1);
});
test('Terminal and unauthorized vehicles do not generate rent setup tasks',()=>{
 for(const status of ['sold','disposed','returned'])assert.equal(fleetAttention({...data,vehicles:[{...vehicle,status}]}).length,0);
 assert.equal(fleetAttention({...data,capabilities:{visibleSections:[]}}).length,0);
});
test('Document action carries the exact missing document; saved copy clears it',()=>{
 const documentTypes=[{value:'FLEET_INSURANCE',label:'Insurance',requiresExpiry:true,reminderDays:30}];
 let rows=fleetAttention({...data,documentTypes});assert.equal(rows.find(r=>r.category==='Documents').documentType,'FLEET_INSURANCE');
 rows=fleetAttention({...data,documentTypes,documents:[{vehicleNo:'TEST1',documentType:'FLEET_INSURANCE',expiryDate:'2027-01-01'}]});assert.equal(rows.filter(r=>r.category==='Documents').length,0);
});
test('Service tasks apply only to owned vans and clear after due date moves forward',()=>{
 for(const ownershipType of ['rented','odcd'])assert.equal(fleetAttention({...data,vehicles:[{...vehicle,ownershipType,nextServiceDate:'2026-10-05'}]}).filter(r=>r.category==='Service').length,0);
 assert.equal(fleetAttention({...data,vehicles:[{...vehicle,nextServiceDate:'2026-10-05'}]}).filter(r=>r.category==='Service').length,1);
 assert.equal(fleetAttention({...data,vehicles:[{...vehicle,nextServiceDate:'2026-12-05'}]}).filter(r=>r.category==='Service').length,0);
});

test('Partner audits and findings never create maintenance attention',()=>{
 const audits=[{id:'a',vehicleId:'v',status:'scheduled',scheduledFor:data.today}];
 const findings=[{id:'f',vehicleId:'v',status:'open'}];
 for(const ownershipType of ['odcd','rented',null])assert.equal(fleetAttention({...data,capabilities:{visibleSections:['audits']},vehicles:[{...vehicle,ownershipType}],audits,findings}).length,0);
 assert.equal(fleetAttention({...data,capabilities:{visibleSections:['audits']},audits,findings}).length,2);
});
