import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { resolveStepApprover, type ApprovalStepRow } from '@/lib/payment-approval-steps';
import { dateKey } from '@/lib/payment-volume';
import {
  adhocOutOnRoadEvidenceLabel,
  eligibleAdhocVehicles,
  evaluateAdhocOutOnRoad,
  isBreakdownVehicleReason,
  normalizeAdhocVehicleNo,
  requiredAdhocStatuses,
  type AdhocContext,
  type AdhocOutOnRoadEvidence,
  type AdhocRule,
  type AdhocVehicle,
} from '@/lib/adhoc-vehicle-policy';

function sourceCodeMap(
  sources: Array<{ id: string; designation_id: string | null }>,
  designations: Array<{ id: string; code: string }>
) {
  return new Map(
    sources.map((s) => [s.id, s.designation_id ? designations.find((d) => d.id === s.designation_id)?.code : 'OWN'])
  );
}

function mapVehicle(
  v: {
    id: string;
    vehicle_no: string;
    model: string;
    da_name: string | null;
    vendor_name: string | null;
    source_id: string;
    status: string;
    deployment_date: string;
    current_location_type?: string | null;
  },
  sourceCodes: Map<string, string | undefined>,
  unavailable: boolean,
  gpsKm: number | null
): AdhocVehicle {
  const source = sourceCodes.get(v.source_id) || '';
  return {
    id: v.id,
    number: v.vehicle_no,
    model: v.model,
    partner: source === 'OWN' ? '' : v.da_name || v.vendor_name || '',
    source,
    status: v.status,
    deploymentDate: v.deployment_date,
    unavailable,
    locationType: v.current_location_type ?? null,
    gpsKm,
  };
}

export async function loadAdhocContext(company: string, station: string, date: string): Promise<AdhocContext> {
  const db = supabaseAdmin!;
  const [rules, vehicles, sources, designations, states, days, km] = await Promise.all([
    db.from('fleet_adhoc_reason_rules').select('*').eq('company_id', company).eq('is_active', true).order('sort_order'),
    db
      .from('fleet_vehicles')
      .select('id,vehicle_no,model,da_name,vendor_name,source_id,status,deployment_date,current_location_type')
      .eq('company_id', company)
      .eq('station_code', station)
      .eq('deployment_status', 'deployed'),
    db.from('fleet_vehicle_sources').select('id,designation_id').eq('company_id', company).eq('is_active', true),
    db.from('designations').select('id,code').eq('company_id', company),
    db.from('fleet_vehicle_status_master').select('status_key').eq('company_id', company).eq('is_terminal', true),
    db
      .from('fleet_vehicle_day_availability')
      .select('vehicle_id')
      .eq('company_id', company)
      .eq('work_date', date)
      .is('revoked_at', null),
    db
      .from('fleet_daily_km')
      .select('vehicle_no,km')
      .eq('company_id', company)
      .eq('movement_date', date)
      .eq('source', 'wheelseye'),
  ]);
  let vehicleRows = vehicles.data ?? [];
  let vehiclesError = vehicles.error;
  if (vehiclesError && /current_location_type/i.test(vehiclesError.message || '')) {
    const fallback = await db
      .from('fleet_vehicles')
      .select('id,vehicle_no,model,da_name,vendor_name,source_id,status,deployment_date')
      .eq('company_id', company)
      .eq('station_code', station)
      .eq('deployment_status', 'deployed');
    vehiclesError = fallback.error;
    vehicleRows = (fallback.data ?? []).map((row) => ({ ...row, current_location_type: null as string | null }));
  }
  if (vehiclesError || [rules, sources, designations, states, days, km].some((r) => r.error)) {
    throw new Error('Vehicle checks unavailable. Please retry.');
  }
  const sourceCodes = sourceCodeMap(sources.data ?? [], designations.data ?? []);
  const terminal = new Set(states.data?.map((s) => s.status_key));
  const unavailableIds = new Set((days.data ?? []).map((d) => d.vehicle_id));
  const kmByNo = new Map(
    (km.data ?? []).map((row) => [normalizeAdhocVehicleNo(row.vehicle_no), Number(row.km) || 0])
  );
  const active = vehicleRows
    .filter((v) => !terminal.has(v.status) && v.deployment_date <= date)
    .map((v) =>
      mapVehicle(v, sourceCodes, unavailableIds.has(v.id), kmByNo.get(normalizeAdhocVehicleNo(v.vehicle_no)) ?? null)
    );
  const availableRules = (rules.data as AdhocRule[]).filter(
    (r) => !r.source_code || active.some((v) => v.source === r.source_code)
  );
  const contactRule = (rules.data as AdhocRule[]).find((r) => r.contact_role_code);
  let contact: string | null = null;
  if (contactRule?.contact_role_code) {
    const role = await db
      .from('user_roles')
      .select('id')
      .eq('company_id', company)
      .eq('code', contactRule.contact_role_code)
      .maybeSingle();
    if (role.data) {
      const approver = await resolveStepApprover(
        company,
        { id: 'contact', step_order: 1, is_required: true, candidates: [{ role_id: role.data.id, scope: 'company' }] },
        null
      );
      if (approver) {
        const p = await db
          .from('profiles')
          .select('full_name,mobile,phone')
          .eq('company_id', company)
          .eq('id', approver.userId)
          .maybeSingle();
        if (p.data) contact = [p.data.full_name, p.data.mobile || p.data.phone].filter(Boolean).join(' · ');
      }
    }
  }
  return { rules: availableRules, vehicles: active, contact };
}

export type AdhocVehicleLookupResult =
  | {
      ok: true;
      vehicle: AdhocVehicle;
      evidence: AdhocOutOnRoadEvidence;
      evidenceLabel: string;
    }
  | { ok: false; error: string };

export async function lookupBreakdownVehicle(
  company: string,
  station: string,
  date: string,
  vehicleNo: string
): Promise<AdhocVehicleLookupResult> {
  const plate = normalizeAdhocVehicleNo(vehicleNo);
  if (!plate || plate.length < 4) return { ok: false, error: 'Enter a valid company vehicle number.' };
  if (!dateKey(date)) return { ok: false, error: 'Select the deployment date.' };

  const context = await loadAdhocContext(company, station, date);
  const match = context.vehicles.find((v) => normalizeAdhocVehicleNo(v.number) === plate);
  if (!match) {
    const db = supabaseAdmin!;
    const elsewhere = await db
      .from('fleet_vehicles')
      .select('vehicle_no,station_code,source_id')
      .eq('company_id', company)
      .eq('deployment_status', 'deployed');
    if (elsewhere.error) return { ok: false, error: 'Vehicle checks unavailable. Please retry.' };
    const hit = (elsewhere.data ?? []).find((v) => normalizeAdhocVehicleNo(v.vehicle_no) === plate);
    if (!hit) return { ok: false, error: 'No company vehicle found with that registration.' };
    if (hit.station_code !== station) {
      return { ok: false, error: 'This vehicle is not assigned to the selected station.' };
    }
    const sources = await db.from('fleet_vehicle_sources').select('id,designation_id').eq('company_id', company).eq('is_active', true);
    const designations = await db.from('designations').select('id,code').eq('company_id', company);
    if (sources.error || designations.error) return { ok: false, error: 'Vehicle checks unavailable. Please retry.' };
    const sourceCodes = sourceCodeMap(sources.data ?? [], designations.data ?? []);
    if (sourceCodes.get(hit.source_id) !== 'OWN') {
      return { ok: false, error: 'Breakdown Vehicle applies only to company (OWN) vehicles.' };
    }
    return { ok: false, error: 'This vehicle is not available for the selected deployment date.' };
  }
  if (match.source !== 'OWN') {
    return { ok: false, error: 'Breakdown Vehicle applies only to company (OWN) vehicles.' };
  }
  const check = evaluateAdhocOutOnRoad(match);
  if (!check.ok || !check.evidence) return { ok: false, error: check.error || 'Vehicle is not out on road.' };
  return {
    ok: true,
    vehicle: match,
    evidence: check.evidence,
    evidenceLabel: adhocOutOnRoadEvidenceLabel(check.evidence),
  };
}

export async function prepareAdhocRequest(
  company: string,
  head: string,
  station: string,
  form: FormData,
  questions: Array<{ id: string; question_text: string }>
): Promise<{ fields: Record<string, unknown>; steps: ApprovalStepRow[] | null }> {
  if (head !== 'VAN_ADHOC') return { fields: {}, steps: null };
  const reasonQuestion = questions.find((q) => /reason.*(?:adhoc|ad hoc).*deployment/i.test(q.question_text));
  const dateQuestion = questions.find((q) => /^deployment date$/i.test(q.question_text.trim()));
  const label = String(form.get(`answers[${reasonQuestion?.id}]`) || '');
  const date = String(form.get(`answers[${dateQuestion?.id}]`) || '');
  if (!dateKey(date)) throw new Error('Select the deployment date.');
  const context = await loadAdhocContext(company, station, date);
  const rule = context.rules.find((r) => r.label === label);
  if (!rule) throw new Error('Select an available deployment reason. Refresh the form if needed.');

  let vehicleId: string | null = null;
  if (isBreakdownVehicleReason(rule)) {
    const plate = String(form.get('adhoc_vehicle_no') || '').trim();
    const postedId = String(form.get('adhoc_vehicle_id') || '').trim();
    const lookupPlate =
      plate || context.vehicles.find((v) => v.id === postedId)?.number || '';
    const lookup = await lookupBreakdownVehicle(company, station, date, lookupPlate);
    if (!lookup.ok) throw new Error(lookup.error);
    if (postedId && postedId !== lookup.vehicle.id) {
      throw new Error('Verify the company vehicle number again before submitting.');
    }
    vehicleId = lookup.vehicle.id;
  } else if (rule.source_code) {
    const vehicle = String(form.get('adhoc_vehicle_id') || '');
    if (!eligibleAdhocVehicles(rule, context.vehicles, date).some((v) => v.id === vehicle)) {
      throw new Error(
        requiredAdhocStatuses(rule).length
          ? `No eligible vehicle in the configured statuses. Contact Fleet Manager${context.contact ? ' · ' + context.contact : ''}.`
          : 'Select an eligible vehicle at this station.'
      );
    }
    vehicleId = vehicle;
  }

  if ((rule.reason_key === 'company_breakdown' || isBreakdownVehicleReason(rule)) && !rule.approval_steps) {
    throw new Error('Fleet approval routing is not configured. Contact the administrator.');
  }

  return {
    fields: {
      adhoc_reason_key: rule.reason_key,
      adhoc_vehicle_id: vehicleId,
      adhoc_deployment_date: date,
      adhoc_approval_steps: rule.approval_steps,
    },
    steps: rule.approval_steps as ApprovalStepRow[] | null,
  };
}

export async function validateAdhocResubmission(company: string, requestId: string, form: FormData) {
  const db = supabaseAdmin!;
  const request = await db
    .from('payment_requests')
    .select('adhoc_reason_key,adhoc_deployment_date')
    .eq('company_id', company)
    .eq('id', requestId)
    .single();
  if (request.error) throw new Error('Unable to verify replacement details.');
  if (!request.data.adhoc_reason_key) return;
  const answers = await db
    .from('payment_request_answers')
    .select('question_id,answer_value,payment_head_questions(question_text)')
    .eq('company_id', company)
    .eq('payment_request_id', requestId);
  if (answers.error) throw new Error('Unable to verify replacement details.');
  for (const answer of answers.data ?? []) {
    const q = Array.isArray(answer.payment_head_questions)
      ? answer.payment_head_questions[0]
      : answer.payment_head_questions;
    if (
      /reason.*(?:adhoc|ad hoc).*deployment|^deployment date$/i.test(q?.question_text ?? '') &&
      form.has(`answers[${answer.question_id}]`) &&
      String(form.get(`answers[${answer.question_id}]`)) !== answer.answer_value
    ) {
      throw new Error(
        'The vehicle replacement reason and date are fixed. Cancel and raise a corrected request to change them.'
      );
    }
  }
}
