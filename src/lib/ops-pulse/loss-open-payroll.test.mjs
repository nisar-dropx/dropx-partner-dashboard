import test from 'node:test';
import assert from 'node:assert/strict';
import {availablePayrollMonths,commonOpenPayrollMonths,peopleRecoveryPayableForWindow,recoveryDirectoryWithPayroll} from './loss-open-payroll.ts';
const rows=[{employee_ref:'employee:left',salary_month:'2026-09',payroll_open:true,payable:2000,paid:1000,processing:false},{employee_ref:'employee:closed',salary_month:'2026-08',payroll_open:false,payable:10000,paid:0,processing:false}];
test('departed people need an open unpaid payroll; active staff remain available',()=>{const people=[{ref:'employee:left',is_active:false},{ref:'employee:closed',is_active:false},{ref:'employee:active',is_active:true}];assert.deepEqual(recoveryDirectoryWithPayroll(people,rows).map(p=>p.ref),['employee:left','employee:active']);assert.deepEqual(availablePayrollMonths(rows,'employee:left'),['2026-09']);});
test('mixed allocations cannot silently combine different months',()=>{assert.deepEqual(commonOpenPayrollMonths([{ref:'a',open_payroll_months:['2026-09']},{ref:'b',open_payroll_months:['2026-10']}],['a','b']),[]);assert.deepEqual(commonOpenPayrollMonths([{ref:'a',open_payroll_months:['2026-09','2026-08']},{ref:'b',open_payroll_months:['2026-09']}],['a','b']),['2026-09']);});
test('an open People payroll balance remains recoverable while calculation is in review',()=>{
  const open={employee_ref:'contractor:1',salary_month:'2026-10',payroll_open:true,payable:'17532.57',paid:'0',processing:false};
  assert.equal(peopleRecoveryPayableForWindow(null,open),17532.57);
  assert.equal(peopleRecoveryPayableForWindow(18000,open),17532.57);
});
test('closed or processing payroll windows never expose recovery capacity',()=>{
  const row={employee_ref:'contractor:1',salary_month:'2026-10',payroll_open:true,payable:17532.57,paid:0,processing:false};
  assert.equal(peopleRecoveryPayableForWindow(18000,{...row,payroll_open:false}),0);
  assert.equal(peopleRecoveryPayableForWindow(18000,{...row,processing:true}),0);
});
test('missing window balances retain only a finite verified calculation',()=>{
  const row={employee_ref:'contractor:1',salary_month:'2026-10',payroll_open:true,payable:null,paid:0,processing:false};
  assert.equal(peopleRecoveryPayableForWindow(12000,row),12000);
  assert.equal(peopleRecoveryPayableForWindow(null,row),null);
});
