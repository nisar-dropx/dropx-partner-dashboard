import {
  normalizedEnrolmentId,
  RAW_PUNCH_PROFILE_TABLES
} from "@/lib/biometric/raw-punch-report";
import { supabaseAdmin } from "@/lib/supabase-admin";

type EnrolmentMappingRow = {
  account_id: string | null;
  employee_id: string | null;
  enrolment_id: string;
  field_executive_id: string | null;
  profile_type: string | null;
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

export async function loadCurrentRawPunchMappingIds(companyId: string) {
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

  const existingByProfile = new Map<string, Set<string>>();
  for (const [type, accountIds] of idsByProfile) {
    const config = RAW_PUNCH_PROFILE_TABLES[type];
    if (!config) continue;
    const existingIds = new Set<string>();
    for (const table of config.tables) {
      for (const idBatch of chunks(Array.from(accountIds))) {
        const profiles = await supabaseAdmin
          .from(table)
          .select("id")
          .eq("company_id", companyId)
          .in("id", idBatch);
        if (profiles.error) throw new Error(profiles.error.message);
        (profiles.data ?? []).forEach((profile) => existingIds.add(String(profile.id)));
      }
    }
    existingByProfile.set(type, existingIds);
  }

  const peopleIds = new Set<string>();
  const workforceIds = new Set<string>();
  mappedRows.forEach((row) => {
    const type = profileType(row);
    const id = accountId(row);
    if (!id || !existingByProfile.get(type)?.has(id)) return;
    const enrolmentId = normalizedEnrolmentId(row.enrolment_id);
    if (!enrolmentId) return;
    if (type === "employee") peopleIds.add(enrolmentId);
    else workforceIds.add(enrolmentId);
  });

  return {
    peopleIds: Array.from(peopleIds),
    workforceIds: Array.from(workforceIds)
  };
}
