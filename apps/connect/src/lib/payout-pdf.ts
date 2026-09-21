import 'regenerator-runtime/runtime.js';
import {PDFDocument,rgb,type PDFFont} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
export async function createPayoutPdf(p:Record<string,any>){
 const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
 const script=(s:string)=>/[\u0D00-\u0D7F]/.test(s)?'NotoSansMalayalam':/[\u0900-\u097F]/.test(s)?'NotoSansDevanagari':/[\u0B80-\u0BFF]/.test(s)?'NotoSansTamil':/[\u0C00-\u0C7F]/.test(s)?'NotoSansTelugu':/[\u0C80-\u0CFF]/.test(s)?'NotoSansKannada':'NotoSans';
 const fonts=new Map<string,PDFFont>();for(const name of new Set(['NotoSans',...Array.from(JSON.stringify(p)).map(script)]))fonts.set(name,await doc.embedFont(await readFile(path.join(process.cwd(),'assets/report-fonts',name+'-Regular.ttf')),{subset:true}));
 const font=fonts.get('NotoSans')!;
 const runs=(s:string)=>{const out:{text:string;font:PDFFont}[]=[];for(const ch of s){const f=fonts.get(script(ch))!;if(!f.getCharacterSet().includes(ch.codePointAt(0)!))throw new Error('Unsupported character in payout PDF.');const prev=out.at(-1);if(prev?.font===f)prev.text+=ch;else out.push({text:ch,font:f});}return out;};
 const width=(s:string,size:number)=>runs(s).reduce((n,r)=>n+r.font.widthOfTextAtSize(r.text,size),0);
 doc.setTitle('DropX associate payout - '+p.from+' to '+p.to);doc.setAuthor('DropX Logistics');
 let page=doc.addPage([595.28,841.89]),y=785;
 const text=(value:unknown)=>String(value??'').replace(/₹/g,'INR ').replace(/[–—]/g,'-').replace(/[•·]/g,' / ').replace(/\s+/g,' ');
 const draw=(s:string,x:number,size:number)=>{for(const r of runs(s)){page.drawText(r.text,{x,y,size,font:r.font,color:rgb(.1,.15,.23)});x+=r.font.widthOfTextAtSize(r.text,size);}};
 const wrap=(s:string,max:number,size:number)=>{const out:string[]=[];let part='';for(const ch of text(s)){if(width(part+ch,size)>max){out.push(part);part='';}part+=ch;}out.push(part);return out;};
 const line=(label:string,value='',heading=false)=>{const size=heading?12:10,left=wrap(label,value?305:510,size),right=wrap(value,190,size);for(let i=0;i<Math.max(left.length,right.length);i++){if(y<65){page=doc.addPage([595.28,841.89]);y=785;}if(left[i])draw(left[i],42,size);if(right[i])draw(right[i],553-width(right[i],size),size);y-=17;}y-=7;};
 line('DROPX LOGISTICS','ASSOCIATE PAYOUT SLIP',true);line(p.from+' to '+p.to,p.status);y-=8;
 line(p.name,p.dropxId,true);line('Station',p.station||'-');line('Bank account',p.bankAccount||'Not recorded');line('IFSC',p.ifsc||'-');
 line('Provider IDs: '+(p.providerIds||[]).join(', '));line('Recorded work days',String(p.days));
 const money=(v:unknown)=>'INR '+Number(v??0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
 y-=8;line('Activity counts','',true);for(const [key,label] of [['delivery','Delivery (includes SWA)'],['cReturn','C-return'],['mfn','MFN'],['mfnReturn','MFN return']])line(label,String(p.counts[key]||0));
 y-=8;line('Earnings and deductions','',true);for(const [label,value] of [['Base and training',p.base],['Incentives',p.incentive],['Additions',p.additions],['Deductions',-p.deductions],['Net payout',p.net]])line(String(label),money(value),label==='Net payout');
 if(p.paymentReference)line('Payment reference',p.paymentReference);if(p.paymentDate)line('Payment date',p.paymentDate);
 const deductions=p.lines.filter((l:Record<string,any>)=>l.adjustment<0||l.originalAmount<0);
 if(deductions.length){y-=8;line('Deduction details','',true);for(const l of deductions){line(l.date+' / '+l.category,money(Math.max(0,-l.adjustment)));line(l.reason||'Contact Workforce for details.');}}
 y-=8;line(p.canDispute?'For review - not payment confirmation. Raise any dispute in DropX One > Payments > Payouts.':'System-generated payout slip. Bank settlement is confirmed only when payment status is Paid.');
 doc.getPages().forEach((pg,index)=>pg.drawText('DropX / '+(index+1)+' of '+doc.getPageCount(),{x:42,y:30,size:9,font,color:rgb(.4,.45,.5)}));
 return doc.save();
}
