import { supabaseAdmin } from '@/lib/supabase-admin';
import { paymentVolumeToday } from '@/lib/payment-volume-data';
import { ownStationVehicle, validateFuelInput, vanFuelDetails } from '@/lib/van-fuel';
import { paymentRequestAttachments } from '@/lib/payment-request-attachments';
import { readAllRows } from '@/lib/supabase-pagination';

export async function loadOwnFuelVehicles(companyId: string, station: string) {
  if (!supabaseAdmin) throw new Error('Vehicle directory unavailable.');
  const result = await readAllRows(supabaseAdmin.from('fleet_vehicles').select('id,vehicle_no,model,ownership_type,station_code').eq('company_id', companyId).eq('station_code', station).eq('ownership_type', 'own').order('vehicle_no').order('id'));
  if (result.error) throw new Error('Unable to load station vehicles. Please retry.');
  return result.data ?? [];
}
export async function prepareVanFuel(companyId: string, code: string, station: string, form: FormData, actual: boolean, existing?: unknown, preserveVehicle = false): Promise<{ details?: Record<string, unknown> }> {
  if (code !== 'VAN_FUEL') return {};
  const amount = Number(form.get('amount'));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a fuel amount greater than zero.');
  const saved = vanFuelDetails(existing);
  const id = preserveVehicle && saved ? saved.vehicle_id : String(form.get('fuel_vehicle_id') ?? '');
  if (!id) throw new Error('Select a company-owned vehicle mapped to this station.');
  const input = validateFuelInput(preserveVehicle && saved ? saved.fuel_date : String(form.get('fuel_date') ?? ''), String(form.get('fuel_litres') ?? ''), actual, paymentVolumeToday());
  let vehicle = preserveVehicle && saved ? { id, vehicle_no: saved.vehicle_no, station_code: saved.station_code, ownership_type: 'own' } : null;
  if (!vehicle) {
    const result = await supabaseAdmin!.from('fleet_vehicles').select('id,vehicle_no,station_code,ownership_type').eq('company_id', companyId).eq('id', id).maybeSingle();
    if (result.error || !result.data || !ownStationVehicle(result.data, station)) throw new Error('This vehicle is not company-owned and mapped to the selected station. Select again.');
    vehicle = result.data;
  }
  if (actual) {
    const heads = await supabaseAdmin!.from('payment_heads').select('id,payment_head_questions(id,answer_type,question_text)').eq('company_id', companyId).eq('code', 'VAN_FUEL');
    if (heads.error) throw new Error('Unable to validate the fuel bill.');
    const billIds = (heads.data ?? []).flatMap(head => head.payment_head_questions ?? []).filter(question => question.answer_type === 'file' && /bill/i.test(question.question_text)).map(question => question.id);
    const submittedIds = form.getAll('question_ids').map(String);
    let hasBill = billIds.some(id => submittedIds.includes(id) && form.getAll(`files[${id}]`).some(file => typeof file !== 'string' && file.size > 0));
    const requestId = String(form.get('request_id') ?? '');
    if (!hasBill && requestId && existing) {
      const answers = await supabaseAdmin!.from('payment_request_answers').select('file_path,file_name,attachments').eq('company_id', companyId).eq('payment_request_id', requestId).in('question_id', billIds);
      if (answers.error) throw new Error('Unable to verify the saved fuel bill.');
      hasBill = (answers.data ?? []).some(answer => paymentRequestAttachments(answer).length > 0);
    }
    if (!hasBill) throw new Error('Attach the fuel bill before submitting actual fuel expenses.');
  }
  const previous = existing && typeof existing === 'object' ? existing as Record<string, unknown> : {};
  return { details: { ...previous, vehicle_no: vehicle.vehicle_no, van_fuel: { vehicle_id: vehicle.id, vehicle_no: vehicle.vehicle_no, station_code: station, ...input } } };
}

export async function loadSameDayFuel(companyId: string, vehicle: string, date: string) {
  if (!supabaseAdmin) throw new Error('Fuel history unavailable.');
  const [fleet, cps, latest] = await Promise.all([
    readAllRows(supabaseAdmin.from('fleet_fuel_transactions').select('provider,transaction_id,fuel_amount,fuel_quantity,transaction_at').eq('company_id', companyId).eq('vehicle_no', vehicle).eq('transaction_date', date).order('id')),
    readAllRows(supabaseAdmin.from('cps_fuel_daily').select('provider,transaction_id,amount,litres').eq('company_id', companyId).eq('vehicle_no', vehicle).eq('transaction_date', date).order('id')),
    supabaseAdmin.from('cps_fuel_daily').select('transaction_date').eq('company_id', companyId).order('transaction_date', { ascending: false }).limit(1)
  ]);
  if (fleet.error || cps.error || latest.error) throw new Error('Fuel history unavailable.');
  const found = new Map<string, { provider: string; reference: string; amount: number; litres: number }>();
  for (const row of [...(cps.data ?? []), ...(fleet.data ?? [])]) found.set(`${row.provider}:${row.transaction_id}`, { provider: row.provider, reference: row.transaction_id, amount: Number(row.fuel_amount ?? row.amount) || 0, litres: Number(row.fuel_quantity ?? row.litres) || 0 });
  return { rows: [...found.values()], latestDate: latest.data?.[0]?.transaction_date ?? null };
}
