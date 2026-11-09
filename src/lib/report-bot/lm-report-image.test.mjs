import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { summaryReportSvg, tableReportSvg, reportPngBase64 } from './lm-report-image.ts';

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
  assert.equal(meta.width, 900);
  assert.equal(meta.height, 118);
});

test('table keeps every station, actual total and metric colours', async () => {
  let styled = 0;
  const rows = Array.from({length: 60}, (_, i) => [`ST${i}`, 100, '84.57%']);
  rows.push(['Grand Total', 6000, '84.57%']);
  const svg = await tableReportSvg('DSR Report', ['Station', 'Total', 'DSR%'], rows, 'DSR%', () => {
    styled++;
    return {background: '#fff3c4', color: '#9b3b00'};
  });
  assert.equal(styled, 60);
  assert.equal((svg.match(/fill="#fff3c4"/g) || []).length, 60);
  assert.equal((svg.match(/fill="#e8eef6"/g) || []).length, 3);
  assert.ok(svg.includes('height="1843"'));
  assert.ok(!svg.includes('<text'));
});

test('unsupported characters fail instead of sending an unreadable image', async () => {
  await assert.rejects(summaryReportSvg('Report', [['\u{10ffff}', 1]]), /font does not support/);
});
