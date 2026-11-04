'use server';
import { requirePagePermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
export async function saveDriverReason(form: FormData) {
  const auth = await requirePagePermission('master_payment_heads', 'edit');
  const key = String(form.get('reason_key') ?? ''), label = String(form.get('label') ?? '').trim(), order = Number(form.get('sort_order'));
  if (!['dcd_leave', 'driver_leave', 'vehicle_service'].includes(key) || !label || label.length > 80 || !Number.isInteger(order) || order < 0 || order > 100) throw new Error('Enter a valid reason and order.');
  const result = await supabaseAdmin!.from('payment_adhoc_driver_rules').update({ label, sort_order: order, is_active: form.get('is_active') === 'on', updated_by: auth.userId, updated_at: new Date().toISOString() }).eq('company_id', requireCompanyId(auth)).eq('reason_key', key).select('reason_key').single();
  if (result.error) throw new Error('Unable to save reason.');
  revalidatePath('/master/payment-heads/adhoc-driver');
  redirect('/master/payment-heads/adhoc-driver?saved=1');
}
