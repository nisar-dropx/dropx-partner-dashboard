import test from 'node:test';import assert from 'node:assert/strict';
import {paymentMappingForDay as mapping} from './workforce-payment-mapping.ts';
const row={work_date:'2026-09-07',provider_employee_id:'ID1',station_code:'STN',client:'Amazon'};
const m={provider_member_id:'ID1',effective_from:'2026-09-07',effective_to:'2026-09-15',payment_values:{DELIVERY:17},providers:{name:'Amazon',code:'AMZ'},stations:{station_code:'STN'}};
test('effective date includes both endpoints and excludes previous and reused-ID days',()=>{assert.equal(mapping([m],row),m);assert.equal(mapping([m],{...row,work_date:'2026-09-06'}),null);assert.equal(mapping([m],{...row,work_date:'2026-09-15'}),m);assert.equal(mapping([m],{...row,work_date:'2026-09-16'}),null);});
test('same provider ID at another station or provider never matches',()=>{assert.equal(mapping([m],{...row,station_code:'OTHER'}),null);assert.equal(mapping([m],{...row,client:'Flipkart'}),null);assert.equal(mapping([m],{...row,provider_employee_id:'OTHER'}),null);});
test('historical rate versions use the matching day, not latest current rate',()=>{const old={...m,effective_from:'2026-09-01',effective_to:'2026-09-06',payment_values:{DELIVERY:12}};assert.equal(mapping([m,old],{...row,work_date:'2026-09-02'}),old);});
