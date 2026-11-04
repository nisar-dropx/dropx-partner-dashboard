'use client';
import {useEffect,useState} from 'react';
import type {StationBoardStation} from '@/lib/ops-pulse/station-board';
import {rtsTable,rtsTotals,rtsMoney,type RtsRow,type RtsLevel} from '@/lib/ops-pulse/rts-report';
import {prepareBoardReport,type BoardReportSort} from '@/lib/ops-pulse/compact-board-report';
import {downloadReportExcel,type ExcelReport} from '@/lib/download-report-excel';
import {downloadBoardShare,renderBoardShareImages,shareBoardImages} from '@/lib/ops-pulse/station-board-share';
import {CopyReportImage} from '@/components/copy-report-image';
import {TrackingDetailModal} from '@/components/tracking-detail-modal';
import {ReportTable} from '@/components/report-table';
import s from './board.module.css';
export function RtsReport({stations,date}:{stations:StationBoardStation[];date:string}){
 const key=JSON.stringify([date,stations.map(r=>[r.stationCode,r.fetchedAt,r.board.rtsVersion])]);
 const [data,setData]=useState<{key:string;rows:RtsRow[];error?:string}|null>(null);
 const [level,setLevel]=useState<RtsLevel>('station');
 const [sort,setSort]=useState<BoardReportSort>({header:'Total value ₹',direction:'desc'});
 const [query,setQuery]=useState('');const [retry,setRetry]=useState(0);
 const [detail,setDetail]=useState<RtsRow[]|null>(null);const [tracking,setTracking]=useState<string|null>(null);
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 useEffect(()=>{
  const controller=new AbortController();const [day,snapshots]=JSON.parse(key) as [string,[string,string,number][]];
  const codes=snapshots.filter(([, ,version])=>version===1).map(([code])=>code);
  if(!codes.length){setData({key,rows:[]});return;}
  void fetch(`/api/ops-pulse/edd/board/tids?${new URLSearchParams({date:day,kind:'rts',stations:codes.join(',')})}`,{cache:'no-store',signal:controller.signal}).then(async response=>{
   const body=await response.json();if(!response.ok||!Array.isArray(body.rows))throw Error(body.error||'Unable to load RTS');
   if(!controller.signal.aborted)setData({key,rows:body.rows});
  }).catch(e=>{if(!controller.signal.aborted)setData({key,rows:[],error:e.message});});
  return ()=>controller.abort();
 },[key,retry]);
 useEffect(()=>{setDetail(null);},[key]);
 const pending=data?.key!==key;const missing=stations.filter(r=>r.board.rtsVersion!==1);
 const rows=pending?[]:(data?.rows||[]).filter(r=>[r.stationCode,r.driverId,r.driverName,r.trackingId,r.status].join(' ').toLowerCase().includes(query.toLowerCase()));
 const totals=rtsTotals(rows);const ready=!pending&&!data?.error&&!missing.length;
 const updated=stations.map(s=>s.fetchedAt||'').sort().at(-1)||'';
 const subtitle=`${date} · Updated ${updated?new Date(updated).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}):'—'} IST`;
 const report=prepareBoardReport({...rtsTable(rows,level),subtitle},sort,{dsr:false,singleStation:false,groupByStation:false});
 const shipment=rtsTable(rows,'shipment');
 const excel=(table=report):ExcelReport=>({title:table.title,scope:subtitle,headers:table.headers,rows:table.rows.map(r=>r.map(c=>c.text)),cellStyles:table.rows,extraSheets:level==='shipment'?[]:[{name:'Shipment details',headers:shipment.headers,rows:shipment.rows.map(r=>r.map(c=>c.text))}]});
 async function output(action:()=>Promise<unknown>){setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:'Export failed');}finally{setBusy(false);}}
 function drill(index:number){
  if(level==='shipment'){setTracking(report.rows[index][2].text);return;}
  const row=report.rows[index];const code=row[0].text;const id=level==='associate'?row[2].text:'';
  setDetail(rows.filter(r=>r.stationCode===code && (!id || (id==='—' ? !r.driverId : r.driverId===id))));
 }
 const detailTable=detail?rtsTable(detail,'shipment'):null;
 return <section className={s.panel}>
  <div className={s.toolbar} style={{padding:10}}>
   <div className={s.segment} aria-label="RTS view">{(['station','associate','shipment'] as const).map(v=><button type="button" key={v} aria-pressed={level===v} onClick={()=>{setLevel(v);setSort({header:v==='shipment'?'Value ₹':'Total value ₹',direction:'desc'});}}>{v==='station'?'Station view':v==='associate'?'Associate detail':'Shipment IDs'}</button>)}</div>
   <input aria-label="Search RTS" placeholder="Station, associate or Shipment ID" value={query} onChange={e=>setQuery(e.target.value)} />
   <div className={s.actions}><button disabled={!ready||busy} onClick={()=>void output(()=>downloadReportExcel(excel()))}>Excel</button><button disabled={!ready||busy} onClick={()=>void output(()=>downloadBoardShare(report,`RTS-${date}`))}>Image</button><CopyReportImage resetKey={key+level+query+JSON.stringify(sort)} disabled={!ready||busy} getImages={()=>renderBoardShareImages(report,true)}/><button disabled={!ready||busy} onClick={()=>void output(async()=>{const files=await renderBoardShareImages(report,true);if(await shareBoardImages(files,report.title,subtitle)==='downloaded'){await downloadBoardShare(report,`RTS-${date}`);setError('Image downloaded. Attach it in your WhatsApp group.');}})}>WhatsApp</button></div>
  </div>
  <div className={s.kpis}><article className={s.kpi}><span>RTS pending{missing.length ? " · partial" : ""}</span><strong>{pending?'—':totals.count}</strong></article><article className={s.kpi}><span>Total known value{missing.length ? " · partial" : ""}</span><strong>{pending?'—':`₹${rtsMoney(totals.value)}`}</strong></article><article className={s.kpi}><span>Value missing</span><strong>{pending?'—':totals.missing}</strong></article><article className={s.kpi}><span>Cash / closure pending</span><strong>{pending?'—':totals.cash}</strong></article></div>
  <div className={s.panelHead}><h3>{report.title}</h3><span>{subtitle}</span></div>
  <small className={s.reportMeta}>Prior-day shipments still with associates. Cash / closure is separate from today's delivery performance. Values are shipment values; missing values are excluded from ₹ totals.</small>
  {missing.length>0&&<p role="status" className={s.note}>RTS snapshot unavailable for {missing.map(r=>r.stationCode).join(', ')}. Refresh today to capture. Historical snapshots are not reconstructed from today's stock.</p>}
  {(pending||data?.error||error)&&<p role={data?.error||error?'alert':'status'} className={s.note}>{data?.error||error||'Loading RTS…'}{data?.error&&<button onClick={()=>{setData(null);setRetry(r=>r+1);}}>Retry</button>}</p>}
  <div className={s.scroll}><ReportTable className={`${s.table} ${s.compactTable}`} reportTitle={report.title} reportCanExport={ready} reportExport={ready?()=>excel():undefined}>
   <thead><tr>{report.headers.map(h=><th key={h} aria-sort={sort.header===h?sort.direction==='asc'?'ascending':'descending':'none'}><button className={s.sortButton} onClick={()=>setSort({header:h,direction:sort.header===h&&sort.direction==='desc'?'asc':'desc'})}>{h} {sort.header===h?(sort.direction==='asc'?'↑':'↓'):'↕'}</button></th>)}</tr></thead>
   <tbody>{report.rows.map((row,i)=><tr key={i}>{row.map((c,j)=><td key={j} style={{textAlign:c.align,fontWeight:c.bold?650:undefined}}>{i<report.rows.length-report.totalRows && (j===0||/Pending|Total value|Value ₹|Shipment ID/.test(report.headers[j]))?<button className={s.metricBtn} onClick={()=>drill(i)}>{c.text}</button>:c.text}</td>)}</tr>)}</tbody>
  </ReportTable></div>
  {ready&&!rows.length&&<p className={s.empty}>No matching RTS pendency.</p>}
  {detailTable&&<div className={s.drawerScrim} onClick={()=>setDetail(null)}><aside className={s.drawer} role="dialog" aria-label="RTS shipment details" onClick={e=>e.stopPropagation()}><div className={s.drawerHead}><h3>RTS · {detail?.length} shipments · ₹{rtsMoney(rtsTotals(detail||[]).value)}</h3><button onClick={()=>setDetail(null)}>Close</button></div><button onClick={()=>void output(()=>downloadReportExcel({title:'RTS shipment details',scope:subtitle,headers:detailTable.headers,rows:detailTable.rows.map(r=>r.map(c=>c.text))}))}>Excel</button><div className={s.scroll}><table className={`${s.table} ${s.compactTable}`}><thead><tr>{detailTable.headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{detailTable.rows.map((row,i)=><tr key={i}>{row.map((c,j)=><td key={j}>{j===2?<button className={s.metricBtn} onClick={()=>setTracking(c.text)}>{c.text} ↗</button>:c.text}</td>)}</tr>)}</tbody></table></div></aside></div>}
  {tracking&&<TrackingDetailModal trackingId={tracking} onClose={()=>setTracking(null)}/>}
 </section>;
}
