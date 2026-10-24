type ReadError = {message?: string; code?: string};

export function transientSourceError(error: ReadError, status?: number): boolean {
 return [502,503,504,520,521,522,523,524].includes(status ?? 0) || /abort|timeout|fetch failed|\b(?:50[234]|52[0-4])\b|ECONN/i.test(error.message ?? '');
}

export function sourceReadError(label: string, error: ReadError, status?: number): Error {
 const message = error.message ?? '';
 // Provider HTML can contain infrastructure details and should never become report content.
 const detail = transientSourceError(error,status)
  ? 'The source database is temporarily unavailable. The last saved report has been kept; retry the refresh later.'
  : /<\/?(?:html|head|body|!doctype)\b/i.test(message)
   ? 'The source database returned an invalid response. The last saved report has been kept.'
   : message.slice(0,300) || 'The source database returned no error details.';
 return Error(`${label} could not be read: ${detail}`);
}

export async function boundedReads<const T extends readonly (()=>PromiseLike<unknown>)[]>(queries: T): Promise<{[K in keyof T]: Awaited<ReturnType<T[K]>>}> {
 const values: unknown[] = [];
 for(let i=0;i<queries.length;i+=3) values.push(...await Promise.all(queries.slice(i,i+3).map(query=>query())));
 return values as {[K in keyof T]: Awaited<ReturnType<T[K]>>};
}

type PayrollRow = Record<string, any>;
/** Review publications are estimates; approved runs own the current payroll item. */
export function reconcileWorkforcePayroll(publications: PayrollRow[], runs: PayrollRow[], items: PayrollRow[]) {
 const runById=new Map(runs.map(run=>[run.id,run])), issues:string[]=[], output:PayrollRow[]=[], usedItems=new Set<string>();
 let reviewCount=0;
 for(const publication of publications){
  const run=runById.get(publication.payroll_run_id);
  if(!run){issues.push('Some legacy workforce publications have no readable payroll run. Their published amounts remain disclosed accruals; they cannot confirm final payroll or recovery deductions.');output.push({...publication,payrollFinal:false,payrollUnverified:true,deductions:[]});continue;}
  if(run.status==='cancelled')continue;
  if(['approved','paid'].includes(run.status)){
   const personItems=items.filter(item=>item.payroll_run_id===run.id&&item.workforce_id===publication.workforce_id);
   const matches=personItems.length>1?personItems.filter(item=>item.station_id===publication.station_id):personItems;
   if(matches.length!==1)throw Error('Approved workforce payroll does not have exactly one current item per associate. Resolve payroll ownership before refreshing.');
   const item=matches[0];if(usedItems.has(item.id))continue;usedItems.add(item.id);
   output.push({...publication,item,station_id:item.station_id||publication.station_id,period_start:run.period_start,period_end:run.period_end,payrollFinal:true,
    deductions:publication.source_calculated_at&&publication.source_calculated_at===run.calculated_at?publication.deductions:[]});
  }else{
   reviewCount++;output.push({...publication,payrollFinal:false});
  }
 }
 for(const item of items){
  if(usedItems.has(item.id))continue;
  const run=runById.get(item.payroll_run_id);if(!run||!['approved','paid'].includes(run.status))continue;
  output.push({id:`final:${item.id}`,workforce_id:item.workforce_id,station_id:item.station_id,payroll_run_id:run.id,
   period_start:run.period_start,period_end:run.period_end,item,deductions:[],payrollFinal:true});
 }
 const identity=(row:PayrollRow)=>[row.workforce_id,row.station_id||row.item?.station_code,row.period_start,row.period_end].join(':');
 const finalKeys=new Set<string>();for(const row of output.filter(row=>row.payrollFinal)){
  const key=identity(row);if(finalKeys.has(key))throw Error('Multiple approved workforce payroll runs cover the same associate, station and period. Resolve duplicate payroll before refreshing.');finalKeys.add(key);
 }
 const selected=output.filter(row=>row.payrollFinal||!finalKeys.has(identity(row)));
 reviewCount=selected.filter(row=>!row.payrollFinal).length;
 if(reviewCount)issues.push(`${reviewCount} workforce publications remain under payroll review. They are disclosed payroll accruals; approved or paid payroll replaces their review amounts.`);
 return {publications:selected,issues:[...new Set(issues)],reviewCount};
}
