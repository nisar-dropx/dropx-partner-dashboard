'use client';
import {useEffect} from 'react';
/** Label ordinary table cells for a stacked phone layout; grouped reports keep their table. */
export function FleetResponsive(){useEffect(()=>{
 const root=document.querySelector('.fc-app');if(!root)return;
 const update=()=>{root.querySelectorAll('table').forEach(table=>{
 if(table.closest('.fc-audit-email-preview,.fc-daily-report,.fc-email-preview') || table.tHead?.rows.length!==1)return;
 const headers=Array.from(table.tHead.rows[0].cells).map(c=>c.textContent?.trim()||'');
 if(headers.length<3)return;table.classList.add('fc-mobile-cards');
 Array.from(table.tBodies).forEach(body=>Array.from(body.rows).forEach(row=>Array.from(row.cells).forEach((cell,i)=>{if(cell.colSpan===1)cell.dataset.label=headers[i]||'';})));
 });};update();const observer=new MutationObserver(update);observer.observe(root,{childList:true,subtree:true});return()=>observer.disconnect();
 },[]);return null;}
