type Field={name:string;value:string;required:boolean;disabled:boolean;readOnly:boolean};
/** Preserve the full source payload; only focus the correction controls when the request is explicit. */
export function idfyRequestedFields<T extends Field>(fields:T[],requirements:string){
 const wanted=new Set<string>();
 if(/address/i.test(requirements))wanted.add('block[a_add]');
 if(/landmark|nearest.*(?:location|house)/i.test(requirements))wanted.add('block[a_lan]');
 if(/(?:alternate|alternative|contact|phone).*(?:number)|number.*contact/i.test(requirements))wanted.add('block[a_lno]');
 const editable=fields.filter(f=>!f.disabled&&!f.readOnly);
 const matched=editable.some(f=>wanted.has(f.name));
 return {primary:editable.filter(f=>!matched||wanted.has(f.name)||(f.required&&!f.value.trim())),other:editable.filter(f=>matched&&!wanted.has(f.name)&&!(f.required&&!f.value.trim()))};
}
