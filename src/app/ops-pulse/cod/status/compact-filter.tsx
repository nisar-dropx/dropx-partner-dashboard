'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ListFilter, Check } from 'lucide-react';
import { toggleCodSelection } from '@/lib/ops-pulse/cod-status';
import styles from './status.module.css';
export type FilterOption={value:string;label:string};
export function CompactFilter({label,values,options,onChange}:{label:string;values:string[];options:FilterOption[];onChange:(values:string[])=>void}) {
  const [open,setOpen]=useState(false),[query,setQuery]=useState('');
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),id=useId();
  useEffect(()=>{
    if(!open) return;
    const close=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener('pointerdown',close);
    return ()=>document.removeEventListener('pointerdown',close);
  },[open]);
  const visible=options.filter(option=>option.label.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className={styles.compactFilter} ref={root} onKeyDown={event=>{if(event.key==='Escape'){setOpen(false);trigger.current?.focus();}}}>
    <button ref={trigger} type="button" className={styles.filterTrigger} aria-label={`${label} filter${values.length?`, ${values.length} selected`:''}`} aria-expanded={open} aria-controls={id} data-selected={values.length>0} onClick={()=>{setOpen(!open);setQuery('');}}><ListFilter size={13} aria-hidden/><span>{values.length===1?options.find(o=>o.value===values[0])?.label || label:label}</span>{values.length>0 && <b>{values.length}</b>}<ChevronDown size={12} aria-hidden/></button>
    {open && <div id={id} className={styles.filterMenu} role="group" aria-label={`${label} options`}>
      <div className={styles.filterMenuHead}><strong>{label}</strong><button type="button" onClick={()=>onChange([])}>Clear</button></div>
      {options.length>6 && <input autoFocus aria-label={`Search ${label}`} placeholder="Search options…" value={query} onChange={e=>setQuery(e.target.value)}/>}
      <div className={styles.filterOptions}>{visible.map(option=><label key={option.value}><input type="checkbox" checked={values.includes(option.value)} onChange={()=>onChange(toggleCodSelection(values,option.value))}/><span>{option.label}</span></label>)}{!visible.length && <small>No matching options</small>}</div>
      <button type="button" className={styles.filterDone} onClick={()=>{setOpen(false);trigger.current?.focus();}}><Check size={13} aria-hidden/>Done{values.length?` · ${values.length} selected`:' · All'}</button>
    </div>}
  </div>;
}
