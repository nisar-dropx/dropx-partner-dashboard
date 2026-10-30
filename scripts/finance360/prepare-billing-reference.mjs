// Convert the Amazon EDSP billing template to a private D1 import.
// Usage: node scripts/finance360/prepare-billing-reference.mjs <xlsx> <YYYY-MM> <company UUID> <output.sql>
// The output contains private financial values. Keep it outside Git (for example .tmp/).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import XLSX from 'xlsx';
const [file,month,company,output]=process.argv.slice(2);
if(!file||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||!/^[a-f0-9-]{36}$/.test(company)||!output)throw Error('Provide workbook, month, company UUID and private SQL output path.');
const bytes=fs.readFileSync(file),book=XLSX.read(bytes);
const delivery=book.Sheets['Delivery Station'],swa=book.Sheets['SWA Payment'];
if(!delivery||!swa)throw Error('The Delivery Station and SWA Payment sheets are required.');
const number=(sheet,col,row)=>{const v=sheet[col+row]?.v;if(v==null||v==='')return 0;if(typeof v!=='number'||!Number.isFinite(v))throw Error(`Invalid number ${col}${row}`);return v;};
const date=(sheet,col,row)=>{const v=sheet[col+row]?.v,d=typeof v==='number'?XLSX.SSF.parse_date_code(v):null;if(!d)throw Error(`Missing operating date ${col}${row}`);return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;};
const stationRows=new Map();for(let r=2;r<=XLSX.utils.decode_range(swa['!ref']).e.r+1;r++){const s=swa['B'+r]?.v;if(s)stationRows.set(s,r);}
const stations=[];
for(let r=2;r<=XLSX.utils.decode_range(delivery['!ref']).e.r+1;r++){
 const station=delivery['B'+r]?.v;if(!station)continue;
 if(typeof station!=='string'||!/^[A-Z0-9_-]+$/.test(station))throw Error(`Invalid station at B${r}`);
 const sr=stationRows.get(station);if(!sr)throw Error(`Missing SWA reference for ${station}`);
 const d=c=>number(delivery,c,r),s=c=>number(swa,c,sr),from=date(delivery,'AB',r),to=date(delivery,'AC',r);
 if(!from.startsWith(month)||!to.startsWith(month))throw Error('Workbook dates do not match the selected month.');
 const heads={mg:d('AM'),variable:d('AN'),mfn:d('AP'),swa:s('O')+s('W'),xpt:0,fuel:d('AT'),ihs:d('AO'),smd:d('AR')+d('AS'),other:d('AQ')};
 if(Math.abs(Object.values(heads).reduce((a,b)=>a+b,0)-(d('AU')+s('O')+s('W')))>0.03)throw Error(`Components do not reconcile for ${station}`);
 stations.push({station,row:r,days:d('AD'),from,to,total:d('AU')+s('O')+s('W'),rates:{mg:d('I'),mgVolume:d('G'),fee:d('O'),variable:d('P'),mfn:d('J'),swaCod:s('E'),swaPrepaid:s('F'),swaReject:s('G')},counts:{delivered:d('R'),returns:d('S'),eligible:d('V'),mfn:d('X'),swa:s('H')+s('I')},heads});
}
if(!stations.length||new Set(stations.map(s=>s.station)).size!==stations.length)throw Error('Missing or duplicate stations.');
const reference={month,source:path.basename(file),sha256:createHash('sha256').update(bytes).digest('hex'),stations};
const quote=s=>"'"+s.replaceAll("'","''")+"'";
fs.writeFileSync(output,`INSERT INTO pnl_billing_references(company,month,source_hash,payload) VALUES(${[company,month,reference.sha256,JSON.stringify(reference)].map(quote).join(',')}) ON CONFLICT(company,month,source_hash) DO NOTHING;\n`,{mode:0o600});
console.log(JSON.stringify({stations:stations.length,month,sha256:reference.sha256,totalBeforeGst:stations.reduce((n,s)=>n+s.total,0),output}));
