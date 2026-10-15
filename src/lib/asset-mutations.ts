import 'server-only';
import { randomUUID } from 'node:crypto';
import { assetEditFields, assetVersion, rentalEditFields } from './asset-version';
import { parseAssetEdit } from './asset-form';
import type { FinanceContext } from './finance/data';

type RecordData = Record<string, any>;
const stale = 'This asset changed after you opened it. Refresh the register and reopen the asset.';
const pick = (row: RecordData, keys: readonly string[]) => Object.fromEntries(keys.map(k => [k, row[k] ?? null]));
function scoped(context: FinanceContext, location: string | null) {
  return context.authorization.hasAllLocationAccess || !!location && context.authorization.locationScopeIds.includes(location);
}
async function current(context: FinanceContext, id: unknown, version: unknown) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw Error('Choose a valid asset.');
  const result = await context.db.from('assets').select('*').eq('company_id', context.companyId).eq('id', id).maybeSingle();
  if (result.error || !result.data || !scoped(context, result.data.location_id)) throw Error('This asset is unavailable or outside your Finance scope.');
  const terms = await context.db.from('asset_rental_terms').select('*').eq('company_id', context.companyId).eq('asset_id', id).in('status', ['draft', 'active', 'notice_given']).maybeSingle();
  if (terms.error) throw Error('Unable to load the current rental terms.');
  if (assetVersion(result.data, terms.data) !== version) throw Error(stale);
  return { asset: result.data as RecordData, rental: terms.data as RecordData | null };
}
async function ensureNotIssued(context: FinanceContext, id: string) {
  const r = await context.db.from('asset_assignments').select('id').eq('company_id', context.companyId).eq('asset_id', id).is('returned_at', null).limit(1);
  if (r.error) throw Error('Unable to check current asset assignments.');
  if (r.data?.length) throw Error('This asset is issued to a person. Return it before deleting it or changing its location, ownership or record method. Other details can still be edited.');
}
async function guardedUpdate(context: FinanceContext, table: string, id: string, previous: RecordData, patch: RecordData) {
  let query = context.db.from(table).update(patch).eq('company_id', context.companyId).eq('id', id);
  for (const [key, value] of Object.entries(previous)) query = value == null ? query.is(key, null) : query.eq(key, value);
  const result = await query.select('id').maybeSingle();
  if (result.error) throw Error(`Unable to save ${table === 'assets' ? 'asset details' : 'rental terms'}. Please retry.`);
  if (!result.data) throw Error(stale);
}
/** Compensate failed supporting writes without overwriting a concurrent user's changes. */
async function persist(context: FinanceContext, asset: RecordData, patch: RecordData, rental: RecordData | null, rentalPatch: RecordData | null, eventType: string, reason: string) {
  const assetBefore = pick(asset, assetEditFields), actor = context.authorization.userId;
  const next = { ...patch, updated_by: actor }, changed = Object.keys(patch).filter(k => JSON.stringify(asset[k] ?? null) !== JSON.stringify(patch[k]));
  if (!changed.length && (!rentalPatch || rental && Object.keys(rentalPatch).every(k => String(rental[k] ?? '') === String(rentalPatch[k] ?? '')))) return false;
  let assetWritten = false, rentalWritten = false;
  const rentalId = rental?.id ?? randomUUID();
  try {
    await guardedUpdate(context, 'assets', asset.id, assetBefore, next); assetWritten = true;
    if (rentalPatch) {
      if (rental) await guardedUpdate(context, 'asset_rental_terms', rentalId, pick(rental, rentalEditFields), { ...rentalPatch, updated_by: actor });
      else {
        const inserted = await context.db.from('asset_rental_terms').insert({ id: rentalId, company_id: context.companyId, asset_id: asset.id, ...rentalPatch, created_by: actor, updated_by: actor });
        if (inserted.error) throw Error('Unable to save the rental terms.');
      }
      rentalWritten = true;
    }
    const labels = changed.map(k => k.replace(/_/g, ' '));
    if (rentalPatch) labels.push('rental terms');
    const event = await context.db.from('asset_events').insert({ company_id: context.companyId, asset_id: asset.id, event_type: eventType,
      from_condition: asset.condition, to_condition: patch.condition ?? asset.condition, to_location_id: patch.location_id === undefined ? asset.location_id : patch.location_id,
      notes: `${eventType === 'deleted' ? 'Removed from active master; history retained' : eventType === 'restored' ? 'Restored to active master' : `Updated ${labels.join(', ')}`}${reason ? `. ${reason}` : ''}`,
      metadata: { previous: assetBefore, current: { ...assetBefore, ...patch }, previous_rental: rental ? pick(rental, rentalEditFields) : null, current_rental: rentalPatch ? { ...(rental ? pick(rental, rentalEditFields) : {}), ...rentalPatch } : null },
      actor_user_id: actor, actor_name: context.authorization.fullName || context.authorization.email || 'Finance' });
    if (event.error) throw Error('Unable to record the change in asset history.');
    return true;
  } catch (error) {
    let rollbackFailed = false;
    if (rentalWritten) try {
      if (rental) await guardedUpdate(context, 'asset_rental_terms', rentalId, { ...pick(rental, rentalEditFields), ...rentalPatch }, { ...pick(rental, rentalEditFields), updated_by: rental.updated_by });
      else {
        // Only the new, uncommitted supporting row is removed; existing agreements are never deleted.
        let q = context.db.from('asset_rental_terms').delete().eq('company_id', context.companyId).eq('id', rentalId);
        for (const [k, v] of Object.entries(rentalPatch!)) q = v == null ? q.is(k, null) : q.eq(k, v);
        const r = await q.select('id').maybeSingle(); if (r.error || !r.data) throw Error('Rollback failed');
      }
    } catch { rollbackFailed = true; }
    if (assetWritten) try { await guardedUpdate(context, 'assets', asset.id, { ...assetBefore, ...patch }, { ...assetBefore, updated_by: asset.updated_by }); } catch { rollbackFailed = true; }
    if (rollbackFailed) throw Error('The save was interrupted and another change prevented a full rollback. Refresh and review this asset before retrying.');
    throw error;
  }
}
export async function editAsset(context: FinanceContext, input: RecordData, resolveType: (category: string, type: string) => Promise<{ id: string }>) {
  const { asset, rental } = await current(context, input.id, input.version);
  if (!asset.is_active) throw Error('Restore this deleted asset before editing it.');
  const parsed = parseAssetEdit(input);
  if (!scoped(context, parsed.asset.location_id) || parsed.asset.location_id && !context.locations.some(l => l.id === parsed.asset.location_id)) throw Error('Choose a location within your Finance scope.');
  if (['location_id', 'ownership_type', 'tracking_mode'].some(k => parsed.asset[k] !== asset[k])) await ensureNotIssued(context, asset.id);
  // Converting a group must not silently discard physical units.
  if (asset.tracking_mode === 'quantity' && parsed.asset.tracking_mode === 'individual' && asset.quantity_total > 1) throw Error('Reduce the group to one physical unit before converting it to an individual item.');
  const type = await resolveType(parsed.category, parsed.type);
  const rentalPatch = parsed.rental ? { ...parsed.rental, status: rental?.status ?? 'active' } : rental ? { status: 'expired' } : null;
  const changed = await persist(context, asset, { ...parsed.asset, asset_type_id: type.id }, rental, rentalPatch, 'master_updated', parsed.reason);
  return { id: asset.id, code: asset.asset_code, changed };
}
export async function changeAssetDeleted(context: FinanceContext, input: RecordData) {
  if (typeof input.deleted !== 'boolean') throw Error('Choose delete or restore.');
  const { asset, rental } = await current(context, input.id, input.version);
  if (asset.is_active === !input.deleted) return { id: asset.id, code: asset.asset_code, changed: false };
  if (input.deleted) await ensureNotIssued(context, asset.id);
  const reason = String(input.reason ?? '').trim().slice(0, 500);
  const changed = await persist(context, asset, { is_active: !input.deleted }, rental, null, input.deleted ? 'deleted' : 'restored', reason);
  return { id: asset.id, code: asset.asset_code, changed };
}
