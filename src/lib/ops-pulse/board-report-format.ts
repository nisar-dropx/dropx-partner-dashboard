import type { BoardShareTable } from './station-board-share';
export type BoardTargets = Partial<Record<'dsr'|'premium'|'standard'|'creturn',number>>;
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
