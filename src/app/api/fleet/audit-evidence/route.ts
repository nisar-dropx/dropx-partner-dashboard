import { withFleetSystemLog } from "@/lib/fleet/system-log";
import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { auditAccess } from '@/lib/fleet/audit-access';
import { supabaseAdmin } from '@/lib/supabase-admin';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function handlePOST(request: Request) {
 try {
  const form=await request.formData();
  const auditId=String(form.get('auditId')||'');
  const {companyId}=await auditAccess(auditId,true);
  const file=form.get('file');
  if(!(file instanceof File) || !file.size || file.size>3500000) return NextResponse.json({error:'Choose a photo or PDF under 3.5 MB.'},{status:400});
  const type=file.type;
  if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(type)) throw new Error('Choose a JPG, PNG, WebP or PDF.');
  let buffer: Buffer=Buffer.from(await file.arrayBuffer());
  const photo=type.startsWith('image/');
  if(photo) buffer=await sharp(buffer,{limitInputPixels:50000000}).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).jpeg({quality:82}).toBuffer();
  else if(buffer.subarray(0,5).toString()!=='%PDF-') throw new Error('Invalid PDF file.');
  const path=`${companyId}/audits/${auditId}/${randomUUID()}.${photo?'jpg':'pdf'}`;
  const uploaded=await supabaseAdmin!.storage.from('fleet-documents').upload(path,buffer,{contentType:photo?'image/jpeg':'application/pdf',upsert:false});
  if(uploaded.error) throw new Error(uploaded.error.message);
  return NextResponse.json({url:`/api/fleet/audit-evidence?path=${encodeURIComponent(path)}`,type:photo?'photo':'document'});
 } catch(e) { return NextResponse.json({error:e instanceof Error?e.message:'Upload failed. Try again.'},{status:400}); }
}
export async function GET(request:Request) {
 try {
  const path=new URL(request.url).searchParams.get('path')||'';
  const parts=path.split('/');
  if(parts.length!==4 || parts[1]!=='audits' || path.includes('..')) throw new Error('Invalid evidence path.');
  const {companyId}=await auditAccess(parts[2]);
  if(companyId!==parts[0]) throw new Error('Evidence access denied.');
  const result=await supabaseAdmin!.storage.from('fleet-documents').createSignedUrl(path,60);
  if(result.error) throw new Error(result.error.message);
  return NextResponse.redirect(result.data.signedUrl,{headers:{'Cache-Control':'private, no-store'}});
 } catch { return NextResponse.json({error:'Sign in with access to this vehicle to view its evidence.'},{status:403}); }
}

export const POST = withFleetSystemLog(handlePOST);
