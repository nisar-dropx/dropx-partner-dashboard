import {redirect} from 'next/navigation';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}){
 const params=await searchParams;const query=new URLSearchParams({tab:'amazon'});
 for(const key of ['station','stations','view','notice','error'])if(params[key])query.set(key,params[key]!);
 redirect(`/workforce/onboarding${query.size?'?'+query:''}`);
}
