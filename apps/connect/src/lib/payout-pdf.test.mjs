import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {PDFDocument} from 'pdf-lib';
import {createPayoutPdf} from './payout-pdf.ts';
test('payout PDF includes a period summary, multilingual identity and multi-page deduction detail',async()=>{
 const sample={from:'2026-09-01',to:'2026-09-15',status:'For your review',name:'Synthetic Associate / ഹരി / राहुल',dropxId:'QA-ONLY',station:'TEST',bankAccount:'000001234567',ifsc:'TEST0000001',providerIds:['QA-PROVIDER'],days:12,counts:{delivery:480,cReturn:10,mfn:6,mfnReturn:2},base:8000,incentive:500,additions:100,deductions:200,gross:8600,net:8400,canDispute:true,lines:Array.from({length:14},(_,i)=>({date:'2026-09-12',category:'Loss recovery',adjustment:-10,originalAmount:-20,reason:'Synthetic evidence reference '+i+' - reviewed reduction, with a retained history and explanation.'}))};
 const bytes=await createPayoutPdf(sample),pdf=await PDFDocument.load(bytes);assert.ok(pdf.getPageCount()>=2);assert.match(pdf.getTitle(),/2026-09-01 to 2026-09-15/);assert.ok(bytes.length>10000);
 if(process.env.PAYOUT_PDF_QA_PATH)await writeFile(process.env.PAYOUT_PDF_QA_PATH,bytes);
});
