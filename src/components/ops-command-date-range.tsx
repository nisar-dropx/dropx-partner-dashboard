'use client';

import { useId, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import styles from '@/app/ops-pulse/command-center.module.css';

export function OpsCommandDateRange({from,to,today}:{from:string;to:string;today:string}) {
  const [open,setOpen]=useState(false);
  const id=useId();
  const date=(value:string)=>new Date(value+'T12:00:00+05:30').toLocaleDateString('en-IN',{day:'numeric',month:'short',timeZone:'Asia/Kolkata'});
  return <div className={styles.dateOptions} data-open={open}>
    <button type="button" className={styles.dateToggle} aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}><CalendarDays size={16}/><span>{date(from)}–{date(to)}</span><ChevronDown size={14}/></button>
    <form action="/ops-pulse" className={styles.dateForm} id={id}>
      <label>From<input type="date" name="from" defaultValue={from} max={today} required/></label>
      <label>Through<input type="date" name="to" defaultValue={to} max={today} required/></label>
      <button>Refresh</button>
    </form>
  </div>;
}
