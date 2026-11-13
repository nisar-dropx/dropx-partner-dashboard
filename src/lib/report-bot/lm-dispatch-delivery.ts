/** Deliver healthy stations but keep partial-source failures retryable.
 * The sender persists each output receipt, so retries never resend acknowledged outputs.
 */
export async function deliverDispatchOutputs<T>(outputs:T[],sourceFailures:string[],send:(output:T)=>Promise<void>){
 for(const output of outputs)await send(output);
 if(sourceFailures.length)throw new Error(sourceFailures.join('; '));
 return outputs.length>0;
}
