import type { BoardShareTable } from './station-board-share';
export type BoardTargets = Partial<Record<'dsr'|'premium'|'standard'|'creturn',number>>;
/** SWA and zero-delivery reports are DSR slices and inherit the DSR master. */
export function boardPerformanceTarget(view:string, targets:BoardTargets, mix?:{premium:number;standard:number}) {
  if(view === 'premium' || view === 'standard' || view === 'creturn') return targets[view];
  if(view === 'dot') {
    if(targets.premium == null || targets.standard == null || !mix || ! (mix.premium + mix.standard)) return undefined;
    return (mix.premium * targets.premium + mix.standard * targets.standard) / (mix.premium + mix.standard);
  }
  return targets.dsr;
}
export function performanceColour(value:number,target?:number) {
  if(target == null || !Number.isFinite(target)) return {bg:'#f1f5f9',color:'#334155'};
  if(value >= target) return {bg:'#166534',color:'#ffffff'};
  if(value >= Math.max(0,target - 4)) return {bg:'#dcfce7',color:'#166534'};
  if(value >= Math.max(0,target - 14)) return {bg:'#fef3c7',color:'#92400e'};
  return {bg:'#fee2e2',color:'#991b1b'};
}
/** All outputs consume these exact cells. Missing targets never imply success. */
export function formatBoardPerformance(table:BoardShareTable,target?:number, rowTarget?:(row:typeof table.rows[number])=>number|undefined):BoardShareTable {
  return {...table,rows:table.rows.map(row=>row.map((cell,i)=>{
    if(!/^(DSR\s*%|DOT\s*%|Pickup\s*%)$/i.test(table.headers[i])) return cell;
    const value=Number(cell.text.replace('%',''));
    return !cell.text.includes('%') || !Number.isFinite(value) ? cell : {...cell,text:`${value.toFixed(2)}%`,...performanceColour(value,rowTarget ? rowTarget(row) : target)};
  }))};
}

/** Ageing is a burden: compare like-for-like columns within the filtered report.
 * Totals are not peers; an equal positive backlog is never labelled healthy. */
export function ageingColour(value:number,min:number,max:number) {
  if(value <= 0) return {bg:'#dcfce7',color:'#166534'};
  const ratio=max > min ? (value-min)/(max-min) : 1;
  if(ratio <= 1/3) return {bg:'#dcfce7',color:'#166534'};
  if(ratio <= 2/3) return {bg:'#fef3c7',color:'#92400e'};
  return {bg:'#fee2e2',color:'#991b1b'};
}
export function formatAgeingPerformance(table:BoardShareTable):BoardShareTable {
  const isTotal=(row:typeof table.rows[number])=>row[0]?.text === 'Grand Total';
  const number=(text:string)=>Number(text.replace(/[₹,\s]/g,''));
  const ranges=table.headers.map((header,column)=>{
    if(!/[#₹]$/.test(header)) return null;
    const values=table.rows.filter(row=>!isTotal(row)).map(row=>number(row[column].text)).filter(Number.isFinite);
    return values.length ? {min:Math.min(...values),max:Math.max(...values)} : null;
  });
  return {...table,rows:table.rows.map(row=>isTotal(row)?row:row.map((cell,column)=>{
    const range=ranges[column],value=number(cell.text);
    return range && Number.isFinite(value) ? {...cell,...ageingColour(value,range.min,range.max)} : cell;
  }))};
}
