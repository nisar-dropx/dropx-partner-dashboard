'use client';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { codStatusExportSheets, type CodExportEntry, type CodExportOptions } from '@/lib/ops-pulse/cod-status-export';
import styles from './status.module.css';
export function CodExcelDownload({entries,options}:{entries:CodExportEntry[];options:CodExportOptions}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function download(){
  setBusy(true);setError('');
  try {
   const sheets=codStatusExportSheets(entries,options);
   const XLSX=await import('xlsx'),book=XLSX.utils.book_new();
   for(const sheet of sheets){
    const ws=XLSX.utils.aoa_to_sheet(sheet.rows);
    ws['!cols']=sheet.rows[0].map((_,c)=>({wch:Math.min(48,sheet.rows.reduce((width,r)=>Math.max(width,String(r[c]??'').length),16))}));
    if(sheet.name!=='Report info'&&sheet.rows.length>1)ws['!autofilter']={ref:ws['!ref']!};
    for(const c of sheet.moneyColumns||[])for(let r=1;r<sheet.rows.length;r++){const cell=ws[XLSX.utils.encode_cell({r,c})];if(cell?.t==='n')cell.z='"₹"#,##0.00';}
    XLSX.utils.book_append_sheet(book,ws,sheet.name);
   }
   const station=entries.length===1?entries[0].location.code:'selected-stations';
   const name=`OpsPulse_COD_${station}_${options.part||'overview'}${options.agedOnly?'_aged':''}_${options.collectionDate||'all-dates'}.xlsx`.replace(/[^a-zA-Z0-9_.-]/g,'_');
   XLSX.writeFile(book,name,{compression:true});
  }catch{setError('Excel could not be downloaded. Please retry.');}finally{setBusy(false);}
 }
 return <span className={styles.exportControl}><button type="button" className={styles.exportButton} disabled={busy||!entries.length} onClick={()=>void download()}><Download size={14} aria-hidden/>{busy?'Preparing…':'Download Excel'}</button>{error?<span role="alert">{error}</span>:null}</span>;
}
