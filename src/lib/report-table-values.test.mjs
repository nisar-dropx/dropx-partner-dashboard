import test from 'node:test';
import assert from 'node:assert/strict';
import { compareReportValues, excelReportValue } from './report-table-values.ts';

test('rupees, Indian grouping, decimals, negative deductions and percentages sort numerically',()=>{
 const values=['₹1,00,000.25','₹99.50','₹1,200.00','- Rs 250','−₹1,000'];
 assert.deepEqual(values.sort(compareReportValues),['−₹1,000','- Rs 250','₹99.50','₹1,200.00','₹1,00,000.25']);
 assert.ok(compareReportValues('9%','80%')<0);
});
test('dates, India day/month dates and clock times sort chronologically',()=>{
 assert.ok(compareReportValues('31/10/2026','01/11/2026')<0);
 assert.ok(compareReportValues('2026-09-30','2026-10-01')<0);
 assert.ok(compareReportValues('30 Sep 2026','02 Nov 2026')<0);
 assert.ok(compareReportValues('11:30 am','1:00 pm')<0);
});
test('blank values stay last, descending reverses populated values, natural names sort sensibly',()=>{
 assert.ok(compareReportValues('—','0','desc')>0);
 assert.ok(compareReportValues('5','10','desc')>0);
 assert.ok(compareReportValues('Station 2','Station 10')<0);
});
test('Excel preserves IDs, leading zeros and formula-looking text while amounts are numeric',()=>{
 assert.equal(excelReportValue('515174733475','Shipment ID'),'515174733475');
 assert.equal(excelReportValue('00123','Reference'),'00123');
 assert.equal(excelReportValue('=HYPERLINK("evil")','Description'),'=HYPERLINK("evil")');
 assert.equal(excelReportValue('₹30,495.50','Value'),30495.5);
 assert.equal(excelReportValue('987654321012345678','Provider ID'),'987654321012345678');
});
