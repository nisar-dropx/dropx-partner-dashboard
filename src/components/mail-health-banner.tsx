'use client';
import { useEffect,useState } from 'react';
export function MailHealthBanner(){
 const [notice,setNotice]=useState('');
 useEffect(()=>{let active=true;async function check(){try{const r=await fetch('/api/mail-health?mode=heartbeat',{cache:'no-store'});if(!r.ok)throw new Error();const data=await r.json();if(active)setNotice(!data?.checkedAt||Date.now()-new Date(data.checkedAt).getTime()>1800000?'Mail watchdog has not reported recently.':data.issues||data.setup||data.warnings?.length?`Mail Health: ${data.issues} streams need attention; ${data.setup??0} need setup.`:'');}catch{if(active)setNotice('Mail Health could not be verified.');}}void check();const timer=setInterval(check,300000);return()=>{active=false;clearInterval(timer);};},[]);
 return notice?<a href="/notifications/mail-health" style={{display:'block',background:'#fff1df',color:'#814315',padding:'10px 16px',fontSize:13,borderRadius:8,margin:'8px 16px'}}>{notice} View Mail Health →</a>:null;
}
