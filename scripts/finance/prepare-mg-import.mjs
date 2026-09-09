// Generates an atomic SQL import from a user-provided CSV. Does not connect to a database.
// Usage: node scripts/finance/prepare-mg-import.mjs <csv> <YYYY-MM> <company UUID> <output.sql>
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const [csvPath,month,companyId,output]=process.argv.slice(2);
if(!csvPath||!month||!/^[a-f0-9-]{36}$/.test(companyId||'')||!output)throw new Error('Provide CSV, month, company UUID and output SQL path.');
const code=ts.transpileModule(readFileSync(new URL('../../src/lib/finance/pricing.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const module={exports:{}};new Function('exports','module',code)(module.exports,module);
const {amazonCsv,decimal,amount}=module.exports;
const bytes=readFileSync(csvPath),hash=createHash('sha256').update(bytes).digest('hex');
const records=amazonCsv(bytes.toString('utf8'),month,basename(csvPath),hash);
const literal=JSON.stringify(records).replace(/'/g,"''");
writeFileSync(output,`select public.finance_save_pricing('${companyId}'::uuid,null,'${literal}'::jsonb) as imported_station_cards;\n`);
console.log(JSON.stringify({records:records.length,month,source_sha256:hash,mg_total:amount(records.reduce((sum,r)=>sum+decimal(r.rates.mg_amount_including_mhe),BigInt(0))),output},null,2));
