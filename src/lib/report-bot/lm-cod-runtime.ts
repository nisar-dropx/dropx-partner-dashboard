/** One budget shared by all COD jobs in a dispatcher invocation. */
export class CodRuntime {
  private active=0;
  private waiting:Array<()=>void>=[];
  private calls=0;
  private values=new Map<string,Promise<unknown>>();
  readonly deadline:number;readonly maxCalls:number;readonly concurrency:number;
  constructor(deadline:number,maxCalls=32,concurrency=2){this.deadline=deadline;this.maxCalls=maxCalls;this.concurrency=concurrency;}
  memo<T>(key:string,task:()=>Promise<T>):Promise<T>{
    const existing=this.values.get(key);if(existing)return existing as Promise<T>;
    const result=task();this.values.set(key,result);return result;
  }
  async external<T>(task:()=>Promise<T>):Promise<T>{
    if(this.calls>=this.maxCalls||Date.now()>this.deadline-10000)throw new Error('COD enrichment deferred: run budget reached');
    this.calls++;
    if(this.active>=this.concurrency)await new Promise<void>(resolve=>this.waiting.push(resolve));
    else this.active++;
    try{if(Date.now()>this.deadline-10000)throw new Error('COD enrichment deferred: run deadline');return await task();}
    finally{const next=this.waiting.shift();if(next)next();else this.active--;}
  }
}
