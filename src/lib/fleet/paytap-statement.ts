import {createHash} from 'node:crypto';
import * as XLSX from 'xlsx';
import {parsePaytap,statementRowToPaytapBody,type PaytapMapping} from '@/lib/fleet/paytap';

export type StatementImportRowResult = {
 row:number;
 state:string;
 reason:string;
 transaction_id?:string;
 event_id?:string;
};

function sheetRows(buffer:Buffer):Record<string,unknown>[]{
 const book=XLSX.read(buffer,{type:'buffer',cellDates:true});
 const sheet=book.Sheets[book.SheetNames[0]];
 if(!sheet)return [];
 return XLSX.utils.sheet_to_json<Record<string,unknown>>(sheet,{defval:'',raw:false});
}

export function parsePaytapStatementFile(buffer:Buffer):{bodies:Record<string,unknown>[];skipped:number}{
 const rows=sheetRows(buffer);
 const bodies:Record<string,unknown>[]=[];
 let skipped=0;
 for(const row of rows){
  const body=statementRowToPaytapBody(row);
  if(!body){skipped+=1;continue;}
  bodies.push(body);
 }
 return {bodies,skipped};
}

export function statementEventId(body:Record<string,unknown>):string{
 const id=String(body.ext_txn_id||'').trim();
 return `import:${id}`.slice(0,200);
}

export function statementBodyHash(body:Record<string,unknown>):string{
 return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export function previewStatementImport(buffer:Buffer,mapping:PaytapMapping):StatementImportRowResult[]{
 const {bodies}=parsePaytapStatementFile(buffer);
 return bodies.map((body,index)=>{
  const parsed=parsePaytap(body,mapping);
  return {
   row:index+1,
   state:parsed.state,
   reason:parsed.reason,
   transaction_id:parsed.fuel?.transaction_id||String(body.ext_txn_id||''),
   event_id:statementEventId(body)
  };
 });
}
