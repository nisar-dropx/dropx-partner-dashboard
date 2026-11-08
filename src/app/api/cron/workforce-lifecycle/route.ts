import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
export const dynamic='force-dynamic';
export const maxDuration=300;
export async function GET(request:Request) {
 const secret=process.env.CRON_SECRET?.trim();
 if(!secret || request.headers.get('authorization')!==`Bearer ${secret}`) return NextResponse.json({error:'Unauthorized'},{status:401});
 if(!supabaseAdmin) return NextResponse.json({error:'Database unavailable'},{status:503});
 const result=await supabaseAdmin.rpc('workforce_lifecycle_sweep');
 if(result.error) return NextResponse.json({error:result.error.message},{status:503});
 return NextResponse.json({results:result.data});
}
