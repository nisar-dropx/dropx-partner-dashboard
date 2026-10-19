"use client";

import { useId, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ChevronDown, ChevronUp } from 'lucide-react';

export function OpsWorkspaceShortcuts({items}:{items:{label:string;href:string}[]}) {
  const [expanded,setExpanded]=useState(false);
  const id=useId();
  const more=items.length>3;
  const link=(item:{label:string;href:string})=><Link prefetch={false} key={item.href} href={item.href}><span>{item.label}</span><ArrowUpRight size={13} aria-hidden="true"/></Link>;
  if(!items.length)return null;
  return <nav className="ops-workspace-shortcuts" aria-label="Frequent workspaces" data-expanded={expanded}>
    {items.slice(0,3).map(link)}
    {more&&<><div className="ops-workspace-shortcuts-extra" id={id}>{items.slice(3).map(link)}</div><button type="button" aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(value=>!value)}>{expanded?'Less':'More'}<span className="sr-only"> shortcuts</span>{expanded?<ChevronUp size={14} aria-hidden="true"/>:<ChevronDown size={14} aria-hidden="true"/>}</button></>}
  </nav>;
}
