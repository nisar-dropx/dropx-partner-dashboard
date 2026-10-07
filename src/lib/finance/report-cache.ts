/** Small process-local report cache. Authorization must run before every lookup. */
export function createReportCache<T>({freshMs=10_000, retainMs=300_000, maxEntries=6, now=Date.now}={}) {
  type Result = {value:T; refreshedAt:number; refreshDelayed:boolean};
  const saved = new Map<string, {value:T; refreshedAt:number}>();
  const running = new Map<string, Promise<Result>>();
  return async function read(key:string, load:()=>Promise<T>):Promise<Result> {
    const time=now();
    for(const [id,item] of saved) if(time-item.refreshedAt>retainMs) saved.delete(id);
    const previous=saved.get(key);
    if(previous && time-previous.refreshedAt<freshMs) return {...previous,refreshDelayed:false};
    const pending=running.get(key);
    if(pending) return pending;
    const work=(async()=>{
      try {
        const value=await Promise.resolve().then(load), item={value,refreshedAt:now()};
        saved.delete(key);saved.set(key,item);
        while(saved.size>maxEntries) saved.delete(saved.keys().next().value!);
        return {...item,refreshDelayed:false};
      } catch(error) {
        // Never cache failures, substitute zeroes, or extend the age of old data.
        if(previous && now()-previous.refreshedAt<=retainMs)
          return {...previous,refreshDelayed:true};
        throw error;
      } finally { running.delete(key); }
    })();
    running.set(key,work);
    return work;
  };
}
