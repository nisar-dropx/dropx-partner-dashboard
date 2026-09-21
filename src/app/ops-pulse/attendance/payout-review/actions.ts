'use server';
import {redirect} from 'next/navigation';import {revalidatePath} from 'next/cache';import {performPayoutReview} from '@/lib/payout-review-actions';
export async function reviewPayout(form:FormData){
 const q=new URLSearchParams();
 try{await performPayoutReview(form,'ops');q.set('notice','Saved. Approved corrections require payroll recalculation and republishing.');revalidatePath('/ops-pulse/attendance/payout-review');}
 catch(e){q.set('error',e instanceof Error?e.message:'Unable to save.');}
 redirect('/attendance/payout-review?'+q);
}
