import 'server-only';
import sharp from 'sharp';
import {supabaseAdmin} from '@/lib/supabase-admin';
import type {AuditReport} from './audit-health';
/** Download only this audit's storage objects. Never fetch arbitrary evidence URLs on the server. */
export async function loadAuditAttachment(companyId:string,auditId:string,e:AuditReport['evidence'][number]) {
 if(!e.url.startsWith('/api/fleet/audit-evidence?')) return null;
 const path=new URL(e.url,'https://fleet.dropxlogistics.com').searchParams.get('path')||'';
 if(!path.startsWith(`${companyId}/audits/${auditId}/`)||path.includes('..')||path.split('/').length!==4) return null;
 const result=await supabaseAdmin!.storage.from('fleet-documents').download(path);
 if(result.error) throw new Error('An uploaded attachment could not be downloaded.');
 const bytes=Buffer.from(await result.data.arrayBuffer());
 if(e.type==='photo') return {kind:'image' as const,bytes:await sharp(bytes,{limitInputPixels:50000000}).rotate().resize({width:1400,height:1400,fit:'inside',withoutEnlargement:true}).jpeg({quality:78}).toBuffer()};
 if(e.type==='document'&&bytes.subarray(0,5).toString()==='%PDF-') return {kind:'pdf' as const,bytes};
 return null;
}
