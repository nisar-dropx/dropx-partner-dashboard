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
