/** Instance-owned: discarded with the selected account. Never persisted. */
export function createRoutePreviewCache<T>() {
  const requests=new Map<string,Promise<T>>();
  return {
    get(key:string,load:()=>Promise<T>){
      const found=requests.get(key);if(found)return found;
      const request=load().catch(error=>{requests.delete(key);throw error;});
      requests.set(key,request);
      if(requests.size>64)requests.delete(requests.keys().next().value!);
      return request;
    }
  };
}
