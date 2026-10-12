"use server";
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePagePermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { assertPickupScope, parsePickupFields } from '@/lib/ops-pulse/cod-pickup';
const path = '/master/cod-master';
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
function finish(result: { error?: string; notice?: string }): never {
  cookies().set('dropx_cod_master_flash', JSON.stringify(result), { httpOnly: true, maxAge: 20, path, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  redirect(path);
}
function failure(error: unknown): never {
  if (String((error as {digest?: string})?.digest || '').startsWith('NEXT_REDIRECT')) throw error;
  finish({error: error instanceof Error ? error.message : 'Unable to save pickup setup. Please retry.'});
}
function refreshed() { revalidatePath(path); revalidatePath('/ops-pulse/cod/status'); revalidatePath('/cod/status'); }
export async function createCodMaster(form: FormData) {
  const auth = await requirePagePermission('cod_master', 'add');
  const companyId = requireCompanyId(auth);
  try {
    if (!supabaseAdmin) throw new Error('Database unavailable.');
    const locationId = text(form, 'location_id'); assertPickupScope(auth, locationId);
    const station = await supabaseAdmin.from('stations').select('id, station_code, state').eq('company_id', companyId).eq('id', locationId).eq('is_active', true).maybeSingle();
    if (station.error || !station.data) throw new Error('Selected station is not available.');
    const existing = await supabaseAdmin.from('cod_station_settings').select('id, pickup_configured, updated_at').eq('company_id', companyId).eq('location_id', locationId).maybeSingle();
    if (existing.error) throw new Error('Could not check the existing pickup setup.');
    if (existing.data?.pickup_configured) throw new Error('This station is already configured. Edit its row instead.');
    const payload = { ...parsePickupFields(form), station_code: station.data.station_code, state: station.data.state,
      updated_by: auth.userId, updated_at: new Date().toISOString() };
    // Restoring a removed pickup never overwrites portal credentials or check settings.
    const result = existing.data
      ? await supabaseAdmin.from('cod_station_settings').update(payload).eq('company_id', companyId).eq('id', existing.data.id).eq('pickup_configured', false).eq('updated_at', existing.data.updated_at).select('id')
      : await supabaseAdmin.from('cod_station_settings').insert({...payload, company_id: companyId, location_id: locationId, created_by: auth.userId, portal_station_code: station.data.station_code}).select('id');
    if (result.error) throw new Error(result.error.code === '23505' ? 'This station was just configured. Reload to see it.' : 'Could not save the pickup setup. Please retry.');
    if (!result.data?.length) throw new Error('This setup has changed. Reload and try again.');
    refreshed(); finish({notice: 'COD pickup setup saved.'});
  } catch (error) { failure(error); }
}
export async function updateCodMaster(form: FormData) {
  const auth = await requirePagePermission('cod_master', 'edit');
  const companyId = requireCompanyId(auth);
  try {
    if (!supabaseAdmin) throw new Error('Database unavailable.');
    const id = text(form,'id');
    const existing = await supabaseAdmin.from('cod_station_settings').select('location_id, updated_at').eq('company_id', companyId).eq('id', id).eq('pickup_configured', true).maybeSingle();
    if (existing.error || !existing.data) throw new Error('Pickup setup is unavailable. Reload to see the latest register.');
    assertPickupScope(auth, existing.data.location_id);
    const result = await supabaseAdmin.from('cod_station_settings').update({...parsePickupFields(form), updated_by: auth.userId, updated_at: new Date().toISOString()})
      .eq('company_id', companyId).eq('id', id).eq('location_id', existing.data.location_id).eq('pickup_configured', true).eq('updated_at', text(form,'updated_at')).select('id');
    if (result.error) throw new Error('Unable to update pickup setup. Please retry.');
    if (!result.data?.length) throw new Error('Someone changed this setup. Reload before saving again.');
    refreshed(); finish({notice: 'COD pickup setup updated.'});
  } catch (error) { failure(error); }
}
export async function deleteCodMaster(form: FormData) {
  const auth = await requirePagePermission('cod_master', 'edit');
  const companyId = requireCompanyId(auth);
  try {
    if (!supabaseAdmin) throw new Error('Database unavailable.');
    const id = text(form,'id');
    const existing = await supabaseAdmin.from('cod_station_settings').select('location_id').eq('company_id', companyId).eq('id', id).eq('pickup_configured', true).maybeSingle();
    if (existing.error || !existing.data) throw new Error('Pickup setup is unavailable.');
    assertPickupScope(auth, existing.data.location_id);
    // Recoverable removal: keep historical references and all portal integrations.
    const result = await supabaseAdmin.from('cod_station_settings').update({pickup_configured: false, updated_by: auth.userId, updated_at: new Date().toISOString()})
      .eq('company_id', companyId).eq('id', id).eq('location_id', existing.data.location_id).eq('pickup_configured', true).eq('updated_at', text(form,'updated_at')).select('id');
    if (result.error) throw new Error('Unable to remove pickup setup.');
    if (!result.data?.length) throw new Error('Someone changed this setup. Reload before deleting.');
    refreshed(); finish({notice: 'Pickup setup deleted. You can add it again; past records and portal settings are retained.'});
  } catch (error) { failure(error); }
}
