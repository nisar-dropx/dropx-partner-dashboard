import type { SupabaseClient } from "@supabase/supabase-js";

type Relation<T> = T | T[] | null;
export type ClientIdWorker = {
  id: string;
  source_profile_type: string;
  source_profile_id: string | null;
  location_id: string;
  onboarding_status: string;
  lifecycle_status: string | null;
  migration_state: string | null;
  stations: Relation<{ provider_id: string | null }>;
  designations: Relation<{ provider_mapping_required: boolean | null }>;
};
export type ClientIdMapping = {
  id: string;
  workforce_id: string | null;
  field_executive_id: string | null;
  contractor_id: string | null;
  employee_id: string | null;
  provider_id: string;
  station_id: string;
  provider_member_id: string;
  effective_from: string;
  effective_to: string | null;
  status: string;
};
export type ClientIdInvitation = {
  id: string; workforce_id: string; station_id: string; status: string;
  requested_at: string; completed_at: string | null; external_reference: string | null;
  error_code: string | null; error_message: string | null;
};
const first = <T,>(value: Relation<T>) => Array.isArray(value) ? value[0] : value;
const terminalLifecycles = new Set(["offboarded", "closed", "exited", "terminated", "resigned", "settled", "inactive"]);

export function needsClientId(worker: ClientIdWorker) {
  return ["under_review", "approved", "active"].includes(worker.onboarding_status)
    && worker.migration_state !== "reclassified"
    && !terminalLifecycles.has(worker.lifecycle_status ?? "")
    && first(worker.designations)?.provider_mapping_required !== false;
}

function belongsToWorker(mapping: ClientIdMapping, worker: ClientIdWorker) {
  // A canonical link takes precedence over legacy profile links.
  if (mapping.workforce_id) return mapping.workforce_id === worker.id;
  if (!worker.source_profile_id) return false;
  if (worker.source_profile_type === "field_executive") return mapping.field_executive_id === worker.source_profile_id;
  if (worker.source_profile_type === "contractor") return mapping.contractor_id === worker.source_profile_id;
  if (worker.source_profile_type === "employee") return mapping.employee_id === worker.source_profile_id;
  return false;
}

export function providerMappingFor(worker: ClientIdWorker, mappings: ClientIdMapping[], date: string) {
  const providerId = first(worker.stations)?.provider_id;
  const known = mappings.filter((mapping) => belongsToWorker(mapping, worker)
    && mapping.provider_id === providerId
    && mapping.status !== "cancelled"
    && Boolean(mapping.provider_member_id?.trim()));
  const current = known.find((mapping) => mapping.station_id === worker.location_id
    && mapping.effective_from <= date
    && (!mapping.effective_to || mapping.effective_to >= date));
  return { current, known: current ?? known[0] };
}

export function clientIdQueues<T extends ClientIdWorker>(workers: T[], mappings: ClientIdMapping[], invitations: ClientIdInvitation[], date: string,
  partnerStates: ReadonlyMap<string, { queue: "mapping" | "progress" | "attention" }> = new Map()) {
  const latestInvitations = new Map<string, ClientIdInvitation>();
  for (const invitation of invitations) {
    const previous = latestInvitations.get(invitation.workforce_id);
    if (!previous || invitation.requested_at > previous.requested_at
      || (invitation.requested_at === previous.requested_at && invitation.id > previous.id)) {
      latestInvitations.set(invitation.workforce_id, invitation);
    }
  }
  const ready: T[] = [];
  const progress: T[] = [];
  const failed: T[] = [];
  const mappingPending: T[] = [];
  const providerMappings = new Map<string, ReturnType<typeof providerMappingFor>>();
  for (const worker of workers) {
    const mapping = providerMappingFor(worker, mappings, date);
    providerMappings.set(worker.id, mapping);
    if (!needsClientId(worker) || mapping.current) continue;
    const partner = partnerStates.get(worker.id);
    const invitation = latestInvitations.get(worker.id);
    if (mapping.known || partner?.queue === "mapping") mappingPending.push(worker);
    else if (partner?.queue === "progress") progress.push(worker);
    else if (partner?.queue === "attention") failed.push(worker);
    else if (invitation?.status === "failed") failed.push(worker);
    else if (invitation && ["queued", "processing", "sent"].includes(invitation.status)) progress.push(worker);
    else ready.push(worker);
  }
  return { ready, progress, failed, mappingPending, latestInvitations, providerMappings };
}

// Page through the source before classifying or counting; PostgREST limits and
// UI page sizes must never turn mapped rows into false pending records.
export async function allClientIdRows<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  const size = 500;
  for (let offset = 0; ; offset += size) {
    const result = await page(offset, offset + size - 1);
    if (result.error) throw new Error(`Unable to verify Client ID records: ${result.error.message}`);
    rows.push(...(result.data ?? []) as T[]);
    if ((result.data?.length ?? 0) < size) return rows;
  }
}

export async function loadClientIdMappings(db: SupabaseClient, companyId: string) {
  return allClientIdRows<ClientIdMapping>((from, to) => db.from("field_executive_provider_mappings")
    .select("id,workforce_id,field_executive_id,contractor_id,employee_id,provider_id,station_id,provider_member_id,effective_from,effective_to,status")
    .eq("company_id", companyId).neq("status", "cancelled")
    .order("effective_from", { ascending: false }).order("id").range(from, to));
}
