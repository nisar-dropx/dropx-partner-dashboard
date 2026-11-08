import {daExportRows,type ScopedDA} from './da-onboarding-view';
function download(data:Blob,name:string){const url=URL.createObjectURL(data),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export async function exportDA(rows:ScopedDA[],format:'xlsx'|'pdf',scope:string){
 if(!rows.length)throw Error('No associates match the filters.');
 const records=daExportRows(rows),stamp=new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}),file=`DropX-workforce-${new Date().toISOString().slice(0,10)}`;
 if(format==='xlsx'){
  const x=await import('xlsx'),book=x.utils.book_new(),sheet=x.utils.json_to_sheet(records);
  sheet['!cols']=Object.keys(records[0]).map(k=>({wch:k.includes('profile ID')?52:k==='Name'||k==='Email'?32:24}));
  sheet['!autofilter']={ref:sheet['!ref']!};x.utils.book_append_sheet(book,sheet,'Associates');
  x.utils.book_append_sheet(book,x.utils.aoa_to_sheet([['Exported at (IST)',stamp],['Scope',scope],['Matching records',rows.length],['Note','Saved source status; blank fields were not supplied.']]),'Export scope');
  // json_to_sheet keeps identifiers/phones and formula-like source strings as text.
  download(new Blob([x.write(book,{bookType:'xlsx',type:'array'})]),`${file}.xlsx`);return;
 }
 const {PDFDocument}=await import('pdf-lib'),pdf=await PDFDocument.create();pdf.setTitle('DropX workforce');pdf.setAuthor('DropX OpsPulse');
 // Use browser fonts so names in Indian scripts are retained rather than stripped.
 const canvas=document.createElement('canvas');canvas.width=1190;canvas.height=1684;const c=canvas.getContext('2d');if(!c)throw Error('PDF drawing is unavailable.');
 let y=0,page=0;const wrap=(text:string,width:number)=>{const lines:string[]=[];let line='';for(const ch of text){if(c.measureText(line+ch).width>width&&line){lines.push(line);line='';}line+=ch;}lines.push(line);return lines;};
 function start(){page++;c!.fillStyle='#fff';c!.fillRect(0,0,1190,1684);c!.fillStyle='#17243b';c!.font='bold 30px Arial';c!.fillText('DropX workforce',44,60);c!.font='18px Arial';c!.fillStyle='#64748b';c!.fillText(`${rows.length} matching records · ${stamp} IST · Page ${page}`,44,91);const scopeLines=wrap(scope,1100);scopeLines.forEach((l,i)=>c!.fillText(l,44,117+i*22));y=145+scopeLines.length*22;}
 async function finish(){const png=await pdf.embedPng(canvas.toDataURL('image/png'));const p=pdf.addPage([595,842]);p.drawImage(png,{x:0,y:0,width:595,height:842});}
 start();
 for(const record of records){c.font='17px Arial';const entries=Object.entries(record).map(([k,v])=>[k,v===null||v===undefined||v===''?'—':String(v)] as const);for(let i=0;i<entries.length;i+=2){const pair=entries.slice(i,i+2),lines=pair.map(([k,v])=>wrap(`${k}: ${v}`,510)),length=Math.max(...lines.map(l=>l.length));let offset=0;while(offset<length){if(y+35>1620){await finish();start();}const take=Math.min(length-offset,Math.max(1,Math.floor((1620-y-12)/23))),height=take*23+12;if(i===0){c.fillStyle='#eef2f7';c.fillRect(35,y-20,1120,height);}c.font='17px Arial';c.fillStyle='#25324a';lines.forEach((ls,j)=>ls.slice(offset,offset+take).forEach((l,n)=>c.fillText(l,48+j*555,y+n*23)));y+=height;offset+=take;}}y+=22;c.strokeStyle='#dde4ed';c.beginPath();c.moveTo(44,y-12);c.lineTo(1146,y-12);c.stroke();}
 await finish();download(new Blob([await pdf.save() as BlobPart],{type:'application/pdf'}),`${file}.pdf`);
}
