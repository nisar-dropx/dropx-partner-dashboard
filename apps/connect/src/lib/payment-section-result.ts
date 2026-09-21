/** Independent read sections: one failed estimate must not hide confirmed statements. */
export async function paymentSectionResult<T>(load: () => Promise<T>, fallback: string): Promise<{data:T|null;error:string}> {
  try { return {data:await load(),error:''}; }
  catch(reason) { return {data:null,error:reason instanceof Error ? reason.message : fallback}; }
}
