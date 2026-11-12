import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { summaryReportSvg, tableReportSvg, reportPngBase64, codSectionsPng, reportPalette } from './lm-report-image.ts';

test('report text uses bundled glyph paths and rasterizes without SVG text fonts', async () => {
  const svg = await summaryReportSvg('DSR Report · 10 Nov 2026 · 11:00 am', [
    ['GDRD · ₹12,345.67 · 84.57%', 125],
    ['മലയാളം తెలుగు हिन्दी தமிழ் ಕನ್ನಡ', 42],
  ]);
  assert.ok(svg.includes('<path '));
  assert.ok(!svg.includes('<text'));
  const png = Buffer.from(await reportPngBase64(svg), 'base64');
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 620);
  assert.equal(meta.height, 92);
});

test('table keeps every station, actual total and metric colours', async () => {
  let styled = 0;
  const rows = Array.from({length: 60}, (_, i) => [`ST${i}`, 100, '84.57%']);
  rows.push(['Grand Total', 6000, '84.57%']);
  const svg = await tableReportSvg('DSR Report', ['Station', 'Total', 'DSR%'], rows, 'DSR%', () => {
    styled++;
    return {background: '#fff3c4', color: '#9b3b00'};
  });
  assert.equal(styled, 61);
  assert.equal((svg.match(/fill="#fff3c4"/g) || []).length, 61);
  assert.equal((svg.match(/fill="#dce8f6"/g) || []).length, 5);
  assert.ok(svg.includes('height="1656"'));
  assert.ok(!svg.includes('<text'));
});

test('summary report colours its value cells without losing compact zebra rows', async () => {
  const svg = await summaryReportSvg('Pending report', [['Pending', 8], ['Clear', 0]], (_label, value) =>
    Number(value) > 0 ? {background: '#fee2e2', color: '#991b1b'} : {background: '#dcfce7', color: '#166534'});
  assert.equal((svg.match(/fill="#fee2e2"/g) || []).length, 1);
  assert.equal((svg.match(/fill="#dcfce7"/g) || []).length, 1);
  assert.ok(svg.includes('<rect x="410"'));
});

test('table can colour standard, premium and overall percentage columns together', async () => {
  let styled = 0;
  const svg = await tableReportSvg('DOT', ['Station', 'Std DOT %', 'Prem DOT %', 'All DOT %'], [['A', '80%', '90%', '85%']], ['Std DOT %', 'Prem DOT %', 'All DOT %'], () => {
    styled++;
    return {background: '#fff3c4', color: '#9b3b00'};
  });
  assert.equal(styled, 3);
  assert.equal((svg.match(/fill="#fff3c4"/g) || []).length, 3);
});

test('unsupported characters fail instead of sending an unreadable image', async () => {
  await assert.rejects(summaryReportSvg('Report', [['\u{10ffff}', 1]]), /font does not support/);
});

test('compact reports keep legible numeric columns, grid and multiple status colours', async () => {
  const columns=['Station','Scheduled','At station','Assigned','On road','Picked up','Pickup failed','Cancelled','Delayed','Unpickupable','Pickup %'];
  const svg=await tableReportSvg('C-return · 12 Nov',columns,[['QLDA',100,10,85,10,70,5,2,1,2,'70.0%']], 'Pickup %',()=>({background:'#e7f3ec',color:'#14532d'}),0,true);
  const meta=await sharp(Buffer.from(await reportPngBase64(svg),'base64')).metadata();
  assert.ok(meta.width<850);assert.equal(meta.height,96);
  for(const colour of ['#d7e0ec','#eff6ff','#ede9fe','#fef3c7','#ffedd5','#ecfdf5'])assert.ok(svg.includes(colour),colour);
});


test('COD image uses natural table size instead of stretching a three-column row to 1100px',async()=>{
 const image=Buffer.from(await codSectionsPng('KTUO · COD · 12 Nov',[{title:'Prepare Deposit pending',columns:['Reconciled cash','Out on road','Pickup cycle'],rows:[['₹8,523.42',5,'Next Day']]}]),'base64');
 const size=await sharp(image).metadata();
 assert.ok(size.width<=620);assert.ok(size.height<160);
});
test('report types have distinct identities while warning colours remain semantic',()=>{
 const palettes=['DSR','C-return','Ageing','Scrub','COD','DOT'].map(title=>reportPalette(title).header);
 assert.equal(new Set(palettes).size,6);
});
