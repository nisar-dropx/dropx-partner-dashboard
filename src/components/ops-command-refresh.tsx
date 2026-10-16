'use client';
import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
// Refresh only a visible dashboard. There are no editable forms or mutations here.
export function OpsCommandRefresh(){
  const router=useRouter();
  const [pending,startTransition]=useTransition();
  const busy=useRef(false);
  const lastRefresh=useRef(Date.now());
  useEffect(()=>{busy.current=pending;if(!pending)lastRefresh.current=Date.now();},[pending]);
  useEffect(()=>{
    const refresh=()=>{
      if(document.visibilityState!=='visible'||busy.current||Date.now()-lastRefresh.current<90000)return;
      busy.current=true;
      lastRefresh.current=Date.now();
      startTransition(()=>router.refresh());
    };
    const timer=setInterval(refresh,90000);
    document.addEventListener('visibilitychange',refresh);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[router]);
  return null;
}
