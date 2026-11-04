import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {styleReportWorkbook} from './styled-report-workbook.ts';
test('Excel keeps numeric percentages, target rules, navy headers and alert ink',async()=>{
 const w=XLSX.utils.book_new();const sheet=XLSX.utils.aoa_to_sheet([['Shipment ID','DSR%','OOR'],['001234567890',.8457,60],['222',.9457,5]]);sheet.B2.z='0.00%';sheet.B3.z='0.00%';XLSX.utils.book_append_sheet(w,sheet,'Report');
 const bytes=await styleReportWorkbook(XLSX.write(w,{type:'array'}),[[{},{bg:'#fee2e2',color:'#991b1b'},{color:'#dc2626'}],[{},{bg:'#dcfce7',color:'#166534'},{}]],[{column:1,target:94}],2);
 const zip=await JSZip.loadAsync(bytes);const xml=await zip.file('xl/worksheets/sheet1.xml').async('string');const styles=await zip.file('xl/styles.xml').async('string');
 assert.match(xml,/conditionalFormatting sqref="B2:B3"/);assert.match(xml,/<formula>0.94<\/formula>/);assert.match(xml,/<formula>0.9<\/formula>/);assert.match(xml,/<formula>0.8<\/formula>/);assert.match(styles,/<dxfs count="4">/);assert.match(styles,/FF19345B/);assert.match(styles,/FFDC2626/);
 const result=XLSX.read(bytes,{type:'array',cellStyles:true});assert.equal(result.Sheets.Report.B2.v,.8457);assert.equal(result.Sheets.Report.B2.z,'0.00%');assert.equal(result.Sheets.Report.A2.v,'001234567890');
 const fs=await import('node:fs/promises');await fs.writeFile('/tmp/rts-format-check.xlsx',bytes);
});
