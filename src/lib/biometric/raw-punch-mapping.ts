import {
  normalizedEnrolmentId,
  RAW_PUNCH_PROFILE_TABLES,
  type RawPunchWorkerRow
} from "@/lib/biometric/raw-punch-report";
import { supabaseAdmin } from "@/lib/supabase-admin";

type EnrolmentMappingRow = {
  account_id: string | null;
  employee_id: string | null;
  enrolment_id: string;
  field_executive_id: string | null;
  profile_type: string | null;
};

export type RawPunchCurrentMapping = {
  accountId: string;
  enrolmentId: string;
  profileType: string;
};

function chunks<T>(values: T[], size = 200) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function profileType(row: EnrolmentMappingRow) {
  return row.profile_type ?? (row.employee_id ? "employee" : "field_executive");
}

function accountId(row: EnrolmentMappingRow) {
  return row.account_id ?? row.employee_id ?? row.field_executive_id;
}

export async function loadCurrentRawPunchMappingIds(
  companyId: string,
  options: { includeWorkerDetails?: boolean } = {}
) {
  if (!supabaseAdmin) throw new Error("The profile mapping service is unavailable.");
  const enrolments = await supabaseAdmin
    .from("biometric_enrolments")
    .select("enrolment_id, profile_type, account_id, employee_id, field_executive_id")
    .eq("company_id", companyId)
    .is("effective_to", null);
  if (enrolments.error) throw new Error(enrolments.error.message);

  const mappedRows = (enrolments.data ?? []) as EnrolmentMappingRow[];
  const idsByProfile = new Map<string, Set<string>>();
  mappedRows.forEach((row) => {
    const type = profileType(row);
    const id = accountId(row);
    if (!id) return;
    if (!idsByProfile.has(type)) idsByProfile.set(type, new Set());
    idsByProfile.get(type)!.add(id);
  });

  const profileQueries: Array<{
    profileType: string;
    promise: ReturnType<typeof supabaseAdmin.from> extends never ? never : PromiseLike<unknown>;
  }> = [];
  for (const [type, accountIds] of idsByProfile) {
    const config = RAW_PUNCH_PROFILE_TABLES[type];
    if (!config) continue;
    for (const table of config.tables) {
      for (const idBatch of chunks(Array.from(accountIds))) {
        const columns = options.includeWorkerDetails ? `id, full_name, ${config.code}` : "id";
        profileQueries.push({
          profileType: type,
          promise: supabaseAdmin
            .from(table)
            .select(columns)
            .eq("company_id", companyId)
            .in("id", idBatch)
        });
      }
    }
  }

  const existingByProfile = new Map<string, Set<string>>();
  const workerByKey = new Map<string, RawPunchWorkerRow>();
  for (const queryBatch of chunks(profileQueries, 8)) {
    const results = await Promise.all(queryBatch.map(async ({ profileType: type, promise }) => ({
      profileType: type,
      response: await promise as { data: Array<Record<string, string | null>> | null; error: { message: string } | null }
    })));
    results.forEach(({ profileType: type, response }) => {
      if (response.error) throw new Error(response.error.message);
      if (!existingByProfile.has(type)) existingByProfile.set(type, new Set());
      const config = RAW_PUNCH_PROFILE_TABLES[type];
      (response.data ?? []).forEach((profile) => {
        const id = String(profile.id);
        existingByProfile.get(type)!.add(id);
        if (options.includeWorkerDetails && config) {
          workerByKey.set(`${type}:${id}`, {
            id,
            full_name: profile.full_name ?? null,
            code: String(profile[config.code] ?? "") || null
          });
        }
      });
    });
  }

  const peopleIds = new Set<string>();
  const workforceIds = new Set<string>();
  const mappings: RawPunchCurrentMapping[] = [];
  mappedRows.forEach((row) => {
    const type = profileType(row);
    const id = accountId(row);
    if (!id || !existingByProfile.get(type)?.has(id)) return;
    const enrolmentId = normalizedEnrolmentId(row.enrolment_id);
    if (!enrolmentId) return;
    mappings.push({ accountId: id, enrolmentId, profileType: type });
    if (type === "employee") peopleIds.add(enrolmentId);
    else workforceIds.add(enrolmentId);
  });

  return {
    peopleIds: Array.from(peopleIds),
    workforceIds: Array.from(workforceIds),
    mappings,
    workerByKey
  };
}
