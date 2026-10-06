import { PDFDocument, StandardFonts, rgb, PDFString, type PDFPage } from 'pdf-lib';
import {findingUrgency} from './audit-health';
import type { AuditReport } from './audit-health';
type Attachment={kind:'image'|'pdf';bytes:Uint8Array}|null;
const navy=rgb(.075,.17,.22),teal=rgb(.02,.48,.45),pink=rgb(.85,.14,.36),muted=rgb(.39,.45,.5),pale=rgb(.94,.97,.97),white=rgb(1,1,1);
const clean=(s:unknown)=>String(s??'').replace(/[–—]/g,'-').replace(/→/g,'>').replace(/₹/g,'Rs ').replace(/…/g,'...').replace(/[^\x20-\x7e\xa0-\xff\n]/g,'');
export async function renderAuditPdf(report:AuditReport,load:(e:AuditReport['evidence'][number])=>Promise<Attachment>) {
 const doc=await PDFDocument.create();const regular=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
 doc.setTitle(`${report.vehicleNo} - Vehicle health report`);doc.setAuthor('DropX Fleet');
 let page!:PDFPage,y=0;const W=595.28,H=841.89,M=36,width=W-M*2;
 const wrap=(value:unknown,size=10,w=width,font=regular)=>{const lines:string[]=[];for(const paragraph of clean(value).split('\n')){let line='';for(const word of paragraph.split(/\s+/)){if(font.widthOfTextAtSize((line?line+' ':'')+word,size)>w&&line){lines.push(line);line='';}if(font.widthOfTextAtSize(word,size)>w){for(const c of word){if(font.widthOfTextAtSize(line+c,size)>w){lines.push(line);line='';}line+=c;}}else line+=(line?' ':'')+word;}lines.push(line);}return lines;};
 function newPage(title:string){page=doc.addPage([W,H]);page.drawRectangle({x:0,y:H-84,width:W,height:84,color:navy});page.drawText('DROPX / FLEET ASSURANCE',{x:M,y:H-29,font:bold,size:9,color:rgb(.42,.86,.79)});page.drawText(clean(title),{x:M,y:H-58,font:bold,size:20,color:white});y=H-108;}
 function ensure(h:number){if(y-h<54)newPage('Audit report / continued');}
 function text(value:unknown,size=10,color=navy,isBold=false,w=width,x=M){const lines=wrap(value,size,w,isBold?bold:regular);for(const line of lines){ensure(size+5);page.drawText(line,{x,y:y-size,font:isBold?bold:regular,size,color});y-=size+5;}return lines.length;}
 function title(value:string){ensure(40);y-=12;text(value,14,teal,true);y-=4;}
 function link(label:string,url:string,x=M,w=width){if(!/^https:\/\//i.test(url))return;ensure(18);const top=y;page.drawText(clean(label),{x,y:y-10,font:bold,size:9,color:teal});page.node.addAnnot(doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[x,top-15,x+w,top],Border:[0,0,0],A:{Type:'Action',S:'URI',URI:PDFString.of(url)}})));y-=19;}
 const online=`https://fleet.dropxlogistics.com/fleet-control?section=audits&auditId=${report.id}`;
 newPage('Vehicle health report');
 text(report.vehicleNo,27,navy,true);text(`${report.model}  |  ${report.station}`,11,muted);text(`${report.mode}  /  ${report.date}  /  ${report.inspector}`,10,muted);y-=14;
 const cardY=y-100;page.drawRectangle({x:M,y:cardY,width,height:100,color:pale});
 page.drawText(report.score===null?'N/A':`${report.score}%`,{x:M+18,y:cardY+42,font:bold,size:34,color:report.health.critical?pink:teal});page.drawText(report.scoreBasis,{x:M+18,y:cardY+19,font:regular,size:9,color:muted});
 const outcome=report.completedAt?(report.status==='failed'?'Completed / Needs attention':'Completed / Passed'):'Audit in progress';
 page.drawText(outcome,{x:M+180,y:cardY+70,font:bold,size:13,color:report.status==='failed'?pink:teal});
 page.drawText(`${report.responses.length} checks  |  ${report.evidence.length} attachments`,{x:M+180,y:cardY+46,font:regular,size:11,color:navy});
 page.drawText(`${report.findings.length} findings  |  ${report.continuity.filter(c=>['Repeated','Recurred'].includes(c.comparison)).length} repeat areas`,{x:M+180,y:cardY+24,font:regular,size:11,color:navy});y=cardY-14;
 if(report.health.critical)text('CRITICAL FINDING - Immediate action required regardless of the overall score.',10,pink,true);
 if(report.summary){title('Inspector summary');text(report.summary);}
 title('Health by area');
 for(const a of report.health.areas){ensure(35);page.drawText(clean(a.category),{x:M,y:y-10,font:bold,size:10,color:navy});page.drawText(`${a.score===null?'Not assessed':a.score+'%'}  /  ${a.share}% weight`,{x:W-M-153,y:y-10,font:regular,size:9,color:muted});y-=20;page.drawRectangle({x:M,y:y-5,width,height:5,color:pale});if(a.score!==null)page.drawRectangle({x:M,y:y-5,width:width*a.score/100,height:5,color:a.score<50?pink:teal});y-=15;}
 text(`${report.health.assessed}/${report.health.total} checks scored. Unassessed checks and zero-weight items are excluded.`,9,muted);
 text(report.scoreBasis==='Weighted health'?'Health = sum(answer points x item weight) / assessed weight. Weights and points are saved at submission.':'Historical score preserved. Area breakdown uses the original pass/fail responses with equal weight.',9,muted);
 if(report.previous.length){title('Previous inspections');for(const p of report.previous.slice(0,4))text(`${p.date}   /   ${p.score??'N/A'}${p.score===null?'':'%'}   /   ${p.status==='failed'?'Needs attention':'Passed'}`,10);}
 link('Open interactive report and vehicle history',online);
 newPage('Action plan / closure tracker');
 const today=new Date(report.generatedAt).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
 const actions=[...(report.actions||[])].sort((a,b)=>Number(['resolved','accepted'].includes(a.status))-Number(['resolved','accepted'].includes(b.status))||(['critical','high','medium','low'].indexOf(a.severity)-['critical','high','medium','low'].indexOf(b.severity))||(a.due||'9999').localeCompare(b.due||'9999'));
 const pending=actions.filter(f=>!['resolved','accepted'].includes(f.status));
 text(`${pending.length} open actions  |  ${actions.length-pending.length} closed`,14,teal,true);
 text(`Action status at export: ${new Date(report.generatedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST`,9,muted);
 if(!actions.length)text('No action points recorded.',11,teal);
 for(const f of actions){ensure(115);title(`${findingUrgency(f,today)} / ${f.category}`);text(f.action||f.finding,12,navy,true);text(`Priority: ${f.severity.toUpperCase()}  |  Status: ${f.status.replace('_',' ')}  |  Due: ${f.due||'Not set'}`,10,muted);text(`Responsible: ${f.owner||'Not assigned'}  |  Raised: ${f.date}`,10,muted);if(f.resolution)text(`Latest remark: ${f.resolution}`,10);if(f.resolvedAt)text(`Closed: ${new Date(f.resolvedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST`,9,teal);text(`${f.updates.reduce((n,u)=>n+u.proofs.length,0)} supporting files / ${f.updates.length} follow-up updates`,9,muted);}
 text('Open the report to update remarks, assign responsibility, revise a deadline or upload closure proof. A passing inspection does not close an earlier action.',9,muted);
 link('Open action tracker and upload proof',online);
 newPage('Findings & follow-up');
 if(!report.findings.length)text('No findings recorded in this inspection.',12,teal,true);
 for(const f of report.findings){title(`${f.category} / ${f.severity.toUpperCase()}`);text(f.finding,11,navy,true);text(`Action: ${f.action||'Review and rectify'}`);text(`Due: ${f.due||'Not set'}  |  Current status: ${f.status}`,9,muted);if(f.resolution)text(`Resolution: ${f.resolution}`,9,muted);}
 title('Earlier gaps / reassessment');
 if(!report.continuity.length)text('No earlier recorded findings for this vehicle.',10,muted);
 for(const f of report.continuity){ensure(65);text(`${f.comparison}  /  ${f.category}`,11,['Repeated','Recurred'].includes(f.comparison)?pink:teal,true);text(f.finding,10);text(`First shown here: ${f.date}  |  Prior occurrences: ${f.previousCount}  |  Due: ${f.due||'Not set'}`,9,muted);if(f.action)text(f.action,9);y-=8;}
 text('Comparison uses findings recorded before this inspection. A passing answer does not automatically close an earlier action. Current action statuses are shown at export time.',9,muted);
 if(actions.some(f=>f.updates.length)){
 newPage('Action history / closure evidence');
 for(const f of actions){if(!f.updates.length)continue;title(f.action||f.finding);for(const u of f.updates){ensure(100);text(`${u.status.replace('_',' ').toUpperCase()} / ${new Date(u.at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST`,10,teal,true);text(`${u.actor} | Responsible: ${u.owner} | Due: ${u.due} | ${u.severity}`,9,muted);text(u.note,10);if(u.before.due!==u.due)text(`Due changed: ${u.before.due||'Not set'} > ${u.due}`,9,muted);if(u.before.action!==u.action)text(`Action changed: ${u.before.action||'Not set'} > ${u.action}`,9,muted);if(u.before.severity!==u.severity)text(`Priority changed: ${u.before.severity} > ${u.severity}`,9,muted);if(u.before.owner!==u.owner)text(`Responsible changed: ${u.before.owner||'Not assigned'} > ${u.owner}`,9,muted);text(`${u.proofs.length} proof files - see evidence gallery`,9,muted);y-=8;}}
 }
 newPage('Checklist / recorded answers');
 for(const r of report.responses){ensure(75);text(`${r.category} / ${r.label}`,11,navy,true);text(`${r.answer||'Not answered'}  |  ${r.score===null?'Not scored':r.score+'/100 points'}  |  Weight ${r.weight}`,10,r.passed===false?pink:teal,true);if(r.comments)text(r.comments,10);if(r.action)text(`Follow-up: ${r.action}${r.days?' / within '+r.days+' days':''}`,9,muted);y-=10;}
 const allEvidence=[...report.evidence,...actions.flatMap(f=>f.updates.flatMap(u=>u.proofs.map(p=>({...p,itemId:f.itemId,caption:`Follow-up / ${f.category} / ${u.at.slice(0,10)} / ${p.caption}`}))))];
 // Bounded loading avoids an unbounded set of storage downloads. Every attachment gets a place in the report.
 const media:Array<{attachment:Attachment;error:boolean}>=[];
 for(let i=0;i<allEvidence.length;i+=3){const batch=await Promise.all(allEvidence.slice(i,i+3).map(async e=>{try{return {attachment:await load(e),error:false};}catch{return {attachment:null,error:true};}}));media.push(...batch);}
 const missing=media.filter((m,i)=>allEvidence[i].type==='photo'&&!m.attachment).length;
 for(let i=0;i<allEvidence.length;i++){
  const e=allEvidence[i],m=media[i];if(i%4===0)newPage(`Evidence gallery / ${Math.floor(i/4)+1}`);
  const col=i%2,row=Math.floor((i%4)/2),cw=(width-16)/2,cx=M+col*(cw+16),top=H-110-row*340;
  page.drawRectangle({x:cx,y:top-245,width:cw,height:245,color:pale});
  if(m.attachment?.kind==='image'){
   try{const img=await doc.embedJpg(m.attachment.bytes);const size=img.scaleToFit(cw-12,233);page.drawImage(img,{x:cx+(cw-size.width)/2,y:top-245+(245-size.height)/2,width:size.width,height:size.height});}
   catch{page.drawText('Image could not be embedded',{x:cx+12,y:top-122,font:regular,size:10,color:pink});}
  } else page.drawText(e.type==='photo'?'Photo unavailable - open source':e.type==='video'?'Video / open source link':'Document / see attachment',{x:cx+10,y:top-122,font:regular,size:9,color:muted});
  y=top-256;const label=e.caption?.slice(0,160)||report.responses.find(r=>r.itemId===e.itemId)?.label||`${e.type} evidence`;text(`${i+1}. ${label}`,9,navy,true,cw,cx);
  const url=e.url.startsWith('/api/fleet/audit-evidence?')?`https://fleet.dropxlogistics.com${e.url}`:e.url;
  link('Open original evidence',url,cx,cw);
 }
 // Uploaded PDF documents follow the photo gallery. Their original pages are preserved.
 for(let i=0;i<media.length;i++){const m=media[i].attachment;if(m?.kind==='pdf'){try{const attachment=await PDFDocument.load(m.bytes);const pages=await doc.copyPages(attachment,attachment.getPageIndices());for(const p of pages)doc.addPage(p);}catch{newPage('Document attachment');text('This PDF could not be appended. Use the original evidence link.',11,pink);link('Open original document',`https://fleet.dropxlogistics.com${allEvidence[i].url}`);}}}
 if(missing){newPage('Evidence availability');text(`${missing} photo(s) could not be embedded in this export. The gallery retains their original links. Retry the export when the files are available.`,12,pink,true);}
 const pages=doc.getPages();for(let i=0;i<pages.length;i++){const p=pages[i];if(p.getWidth()!==W||p.getHeight()!==H)continue;p.drawText(clean(`${report.vehicleNo} / ${report.date} / DropX Fleet`),{x:M,y:24,font:regular,size:8,color:muted});p.drawText(`${i+1} / ${pages.length}`,{x:W-M-36,y:24,font:bold,size:8,color:teal});}
 return doc.save();
}
