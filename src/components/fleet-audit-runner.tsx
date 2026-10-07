'use client';
import { FleetAttachmentPreview } from './fleet-attachment-preview';
import { useEffect, useRef, useState } from 'react';
import { Camera, Check, ChevronRight, ClipboardCheck, Plus, Save, X } from 'lucide-react';
import type { FleetAudit, FleetChecklistItem, FleetControlData } from '@/lib/fleet-control';
import { auditApplies, auditDueDate, type AuditConfig } from '@/lib/fleet/audit-rules';

function configFor(item:FleetChecklistItem):AuditConfig {
 if(item.responseConfig) return item.responseConfig;
 const choice=['yes_no','pass_fail'].includes(item.responseType);
 return {kind:choice?'choice':['number','date'].includes(item.responseType)?item.responseType as 'number'|'date':'text',fuels:[],unit:'',documentType:'',options:choice?[{value:'pass',label:item.responseType==='yes_no'?'Yes':'Matches / satisfactory',issue:false,severity:'low',photos:item.passMinEvidence,remarks:false,followUp:'none',days:7},{value:'fail',label:item.responseType==='yes_no'?'No':'Issue found',issue:true,severity:item.failureSeverity,photos:item.failMinEvidence,remarks:item.failRemarksRequired,followUp:'none',days:7},{value:'na',label:'Not applicable',issue:false,severity:'low',photos:0,remarks:false,followUp:'none',days:7}]:[]};
}
async function smallPhoto(file:File):Promise<File> {
 if(!file.type.startsWith('image/')) return file;
 const image=new Image(); const url=URL.createObjectURL(file);
 try { await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('This image could not be opened. Choose a JPG photo.'));image.src=url;});
 const scale=Math.min(1,1600/Math.max(image.width,image.height));const canvas=document.createElement('canvas');canvas.width=image.width*scale;canvas.height=image.height*scale;canvas.getContext('2d')!.drawImage(image,0,0,canvas.width,canvas.height);
 const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Photo processing failed.')),'image/jpeg',0.82));return new File([blob],'audit-photo.jpg',{type:'image/jpeg'});
 } finally {URL.revokeObjectURL(url);}
}
export function FleetAuditRunner({audit,data,onClose,onDone}:{audit:FleetAudit;data:FleetControlData;onClose:()=>void;onDone:(confirmation:string)=>void}) {
 const vehicle=data.vehicles.find(v=>v.id===audit.vehicleId);
 const template=audit.templateId || data.auditTemplates.find(t=>t.isDefault)?.id;
 const items=data.checklistItems.filter(i=>i.templateId===template&&(i.auditMode==='both'||i.auditMode===audit.auditMode)&&auditApplies(i.responseConfig,vehicle?.fuelType||''));
 const [values,setValues]=useState<Record<string,string>>(audit.draft || {});
 const [busy,setBusy]=useState('');const [error,setError]=useState('');const [saved,setSaved]=useState('');const [dirty,setDirty]=useState(false);
 const bodyRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(error)bodyRef.current?.scrollTo({top:0,behavior:'smooth'});},[error]);
 const latest=useRef(values);latest.current=values;
 const savingDraft=useRef<Promise<unknown>|null>(null);
 useEffect(()=>{
  if(!dirty || busy) return;
  const snapshot=JSON.stringify(values);
  const timer=window.setTimeout(async()=>{
   if(savingDraft.current)return;savingDraft.current=send('audit.draft',{draft:values});
   try{await savingDraft.current;if(JSON.stringify(latest.current)===snapshot){setDirty(false);setSaved('Draft saved automatically');}}
   catch{setSaved('Not saved yet · check your connection and tap Save draft');}
   finally{savingDraft.current=null;}
  },1800);
  return()=>window.clearTimeout(timer);
 },[values,busy,dirty]);
 const changed=(key:string,value:string)=>{setValues(v=>({...v,[key]:value}));setDirty(true);setSaved('');};
 const field=(key:string)=>({value:values[key]||'',onChange:(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>changed(key,e.target.value)});
 useEffect(()=>{const prevent=(e:BeforeUnloadEvent)=>{if(dirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent);},[dirty]);
 async function send(action:string,body:Record<string,unknown>){const response=await fetch('/api/fleet-control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,auditId:audit.id,...body})});const result=await response.json();if(!response.ok) throw new Error(result.error||'Could not save. Your answers remain here.');return result;}
 async function save(close=false){setBusy('draft');setError('');try{if(savingDraft.current)await savingDraft.current.catch(()=>{});await send('audit.draft',{draft:latest.current});setDirty(false);setSaved('Draft saved · resume from any device');if(close)onClose();}catch(e){setError(e instanceof Error?e.message:'Save failed.');}finally{setBusy('');}}
 async function upload(key:string,file?:File){if(!file)return;setBusy(key);setError('');try{const photo=await smallPhoto(file);if(photo.size>3500000)throw new Error('Choose a file smaller than 3.5 MB.');const form=new FormData();form.set('auditId',audit.id);form.set('file',photo);const r=await fetch('/api/fleet/audit-evidence',{method:'POST',body:form});const result=await r.json();if(!r.ok)throw new Error(result.error||'Upload failed.');changed(key,result.url);changed(`${key}_type`,result.type);}catch(e){setError(e instanceof Error?e.message:'Upload failed.');}finally{setBusy('');}}
 const answered=items.filter(i=>values[`item_${i.id}`]).length;
 const groups=[...new Set(items.map(i=>i.category))];
 const photoInput=(key:string,index:number)=><div className="fc-photo-slot" key={key}>{values[key]?<><FleetAttachmentPreview href={values[key]}>View attachment {index+1}</FleetAttachmentPreview><button type="button" aria-label="Remove attachment" onClick={()=>changed(key,'')}><X size={16}/></button></>:<label className="fc-photo-button"><Camera size={20}/><span>{busy===key?'Uploading…':`Add photo ${index+1}`}</span><input aria-label={`Upload photo ${index+1}`} disabled={!!busy} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={e=>upload(key,e.target.files?.[0])}/></label>}</div>;
 async function complete(e:React.FormEvent){e.preventDefault();setBusy('complete');setError('');try{if(savingDraft.current)await savingDraft.current.catch(()=>{});
 const responses=items.map(i=>({itemId:i.id,value:values[`item_${i.id}`]||'',comments:values[`comment_${i.id}`]||'',days:values[`days_${i.id}`]||configFor(i).options.find(o=>o.value===values[`item_${i.id}`])?.days,action:values[`action_${i.id}`]||''}));
 const evidence=items.flatMap(i=>Array.from({length:7},(_,n)=>({itemId:i.id,url:values[`photo_${i.id}_${n}`]||'',type:values[`photo_${i.id}_${n}_type`]||'photo',caption:`${i.label} · photo ${n+1}`}))).filter(e=>e.url);
 if(values.video)evidence.push({itemId:'',url:values.video,type:'video',caption:'Complete walk-around video'});
 const result=await send('audit.complete',{responses,evidence,summary:values.summary,odometerKm:values.odometer || values[`item_${items.find(i=>i.category==='Usage'&&i.responseType==='number')?.id}`],sendEmail:values.sendEmail!=='no'&&data.settings.auditEmailEnabled,finding:values.finding,findingCategory:'Additional finding',severity:values.severity||'medium',actionRequired:values.action,expectedCompletionDate:values.due});setDirty(false);onDone(result.message || 'Audit submitted successfully. Your answers and evidence are saved.');
 }catch(e){setError(e instanceof Error?e.message:'Could not submit. Your answers remain here.');}finally{setBusy('');}}
 return <div className="fc-modal-backdrop"><section role="dialog" aria-modal="true" aria-label="Conduct vehicle audit" className="fc-modal fc-audit-runner">
 <header className="fc-runner-header"><div><small>{audit.stationCode} · {audit.auditMode==='physical'?'Physical inspection':'Virtual inspection'}</small><h2>{audit.vehicleNo}</h2><p>{vehicle?.model} · {answered}/{items.length} answered</p></div><button aria-label="Save and close audit" disabled={!!busy} onClick={()=>dirty?save(true):onClose()} type="button"><X size={22}/></button></header>
 <div className="fc-audit-progress"><span style={{width:`${items.length?answered/items.length*100:0}%`}}/></div>
 <form onSubmit={complete} onInvalidCapture={e=>{const details=(e.target as HTMLElement).closest('details');if(details)details.open=true;}}>
 <div className="fc-runner-body" ref={bodyRef}>
 {error&&<div role="alert" className="fc-flash error">{error}</div>}{saved&&<p role="status" className="fc-saved"><Check size={16}/>{saved}</p>}
 {data.findings.filter(f=>f.vehicleId===audit.vehicleId&&!['resolved','accepted'].includes(f.status)).length>0&&<details className="fc-audit-group"><summary>Outstanding findings for this vehicle</summary>{data.findings.filter(f=>f.vehicleId===audit.vehicleId&&!['resolved','accepted'].includes(f.status)).map(f=><p className="fc-open-finding" key={f.id}>{f.finding} · {f.dueDate||'No deadline'}</p>)}</details>}
 {groups.map((category,groupIndex)=><details className="fc-audit-group" key={category} open={groupIndex===0}><summary><span>{category}</span><b>{items.filter(i=>i.category===category&&values[`item_${i.id}`]).length}/{items.filter(i=>i.category===category).length}</b></summary>
 {items.filter(i=>i.category===category).map(item=>{const config=configFor(item),value=values[`item_${item.id}`]||'',option=config.options.find(o=>o.value===value);const doc=data.documents.find(d=>d.vehicleNo===audit.vehicleNo&&d.documentType===config.documentType);const photos=option?.photos||0;const days=Number(values[`days_${item.id}`]||option?.days||7);return <article key={item.id} className={`fc-practical-check ${option?.issue?'issue':''}`}>
 <label><strong>{item.label}{item.isRequired?' *':''}</strong><small>{item.guidance}</small>{config.kind==='choice'?<select required={item.isRequired} {...field(`item_${item.id}`)}><option value="">Choose result</option>{config.options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:<input required={item.isRequired} type={config.kind==='number'?'number':config.kind==='date'?'date':'text'} min={config.kind==='number'?'0':undefined} {...field(`item_${item.id}`)}/>}</label>
 {config.documentType&&<div className="fc-audit-document">{doc?<><FleetAttachmentPreview href={doc.viewUrl}>View saved document <ChevronRight size={14}/></FleetAttachmentPreview><span>{doc.expiryDate?`Valid until ${doc.expiryDate}`:'No expiry recorded'}</span></>:<span>No saved copy. Record what you could verify.</span>}</div>}
 {option?.followUp!=='none'&&option?.issue&&<div className="fc-audit-followup"><label><span>Required action *</span><input required placeholder="Replace tyre, workshop check, repair…" {...field(`action_${item.id}`)}/></label>{option.followUp==='planned'?<label><span>Complete within days *</span><input type="number" min="1" max="365" required value={values[`days_${item.id}`]??option.days} onChange={e=>changed(`days_${item.id}`,e.target.value)}/><small>Due {Number.isInteger(days)&&days>0&&days<=365?auditDueDate(data.today,days):'—'} · appears in Need Attention</small></label>:<p className="fc-urgent">Due today · inspect / rectify before the next route.</p>}</div>}
 {option?.remarks?<label><span>Observation *</span><textarea required rows={2} placeholder="Describe what you observed" {...field(`comment_${item.id}`)}/></label>:<details className="fc-optional-remark"><summary><Plus size={14}/>Add remark</summary><textarea rows={2} aria-label={`Remark for ${item.label}`} {...field(`comment_${item.id}`)}/></details>}
 {photos>0&&<div><small>{photos} photo{photos>1?'s':''} required for this answer</small><div className="fc-photo-grid">{Array.from({length:photos},(_,n)=>photoInput(`photo_${item.id}_${n}`,n))}</div></div>}
 {photos===0&&value&&<details className="fc-optional-remark"><summary><Camera size={14}/>Add photo (optional)</summary>{photoInput(`photo_${item.id}_0`,0)}</details>}
 </article>;})}</details>)}
 <section className="fc-audit-summary"><h3><ClipboardCheck size={18}/> Finish inspection</h3>{!items.some(i=>i.responseType==='number'&&i.category==='Usage')&&<label><span>Odometer (km)</span><input type="number" min="0" {...field('odometer')}/></label>}
 {audit.auditMode==='video'&&<label><span>Complete walk-around video {data.settings.auditVideoRequired?'*':'(optional)'}</span><input type="url" required={data.settings.auditVideoRequired} placeholder="Shareable video link" {...field('video')}/></label>}
 <label><span>Inspector summary</span><textarea rows={2} placeholder="Key observations for the fleet team" {...field('summary')}/></label>
 <details className="fc-optional-remark"><summary><Plus size={16}/>Additional finding</summary><label><span>Issue</span><textarea rows={2} {...field('finding')}/></label><label><span>Action</span><input {...field('action')}/></label><label><span>Due date</span><input type="date" {...field('due')}/></label><label><span>Priority</span><select {...field('severity')}><option value="medium">Medium</option><option value="low">Low</option><option value="high">High</option><option value="critical">Critical</option></select></label></details>
 {data.settings.auditEmailEnabled&&<label className="fc-toggle"><input type="checkbox" checked={values.sendEmail!=='no'} onChange={e=>changed('sendEmail',e.target.checked?'yes':'no')}/>Email audit summary</label>}
 </section></div>
 <footer className="fc-runner-footer"><button className="fc-button secondary" type="button" disabled={!!busy} onClick={()=>save()}><Save size={17}/>{busy==='draft'?'Saving…':'Save draft'}</button><button className="fc-button primary" disabled={!!busy||!items.length} type="submit">{busy==='complete'?'Submitting…':'Complete audit'}</button></footer>
 </form></section></div>;
}
