"use server";
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {requirePagePermission} from '@/lib/authorization';
import {manageWorkforceHold} from '@/lib/workforce-hold-actions';
export async function manageHold(form:FormData){
  const auth=await requirePagePermission('ops_salary_hold','edit');
  const query=new URLSearchParams();
  try { query.set('notice',await manageWorkforceHold(auth,form,false));revalidatePath('/ops-pulse/attendance/workforce-holds'); }
  catch(error){query.set('error',error instanceof Error?error.message:'Unable to update hold.');}
  redirect(`/attendance/workforce-holds?${query}`);
}
