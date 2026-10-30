import {createHash,timingSafeEqual} from 'node:crypto';
import {NextResponse} from 'next/server';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {loadSources,FINAL_PNL_COMPANY} from '@/lib/finance/final-pnl/sources';
import {monthValue} from '@/lib/finance/final-pnl/model';
export const dynamic='force-dynamic';export const maxDuration=300;
export async function GET(request:Request){
 const key=process.env.FIN_PNL_API_KEY,provided=request.headers.get('authorization');
 const digest=(s:string)=>createHash('sha256').update(s).digest();
 if(!key||!provided||!timingSafeEqual(digest(provided),digest(`Bearer ${key}`)))return NextResponse.json({error:'Unauthorized'},{status:401,headers:{'Cache-Control':'private, no-store'}});
 try{if(!supabaseAdmin)throw Error('Finance source database is unavailable.');const month=monthValue(new URL(request.url).searchParams.get('month'));
  return NextResponse.json(await loadSources(supabaseAdmin,FINAL_PNL_COMPANY,month),{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){console.error('Final P&L sources',e instanceof Error?e.message:e);return NextResponse.json({error:e instanceof Error?e.message:'Source load failed'},{status:503,headers:{'Cache-Control':'private, no-store'}});}
}
