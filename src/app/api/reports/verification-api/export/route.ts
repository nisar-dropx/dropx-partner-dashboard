import * as XLSX from "xlsx";
import { type NextRequest } from "next/server";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { supabaseAdmin } from "@/lib/supabase-admin";

type AuditRow = {
  account_id: string | null;
  actor_label: string | null;
  actor_user_id: string | null;
  account_code: string | null;
  created_at: string;
  duration_ms: number | null;
  endpoint: string;
  http_status: number | null;
  is_success: boolean;
  profile_name: string | null;
  profile_type: string | null;
  provider_code: string;
  request_data: unknown;
  response_data: unknown;
  result_code: string | null;
  result_message: string | null;
  source: string;
  verification_kind: string;
};

const kindLabels: Record<string, string> = {
  bank: "Bank account",
  dl: "Driving licence",
  pan: "PAN",
  pan_aadhaar: "PAN Aadhaar link",
  pf_uan: "PF UAN",
  upi: "UPI ID",
  vehicle: "Vehicle RC"
};

const sourceLabels: Record<string, string> = {
  dashboard: "Dashboard",
  dropx_one_android: "DropX One Android",
  dropx_one_web: "DropX One Web"
};

const profileLabels: Record<string, string> = {
  contractor: "Independent contractor",
  employee: "Employee",
  field_executive: "Field executive",
  vendor: "Vendor",
  worker: "Worker"
};

function clean(value: string | null) {
  return String(value ?? "").trim();
}

function safeDate(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function selectedValues(value: string | null, allowed: string[]) {
  return Array.from(new Set(
    clean(value)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => allowed.includes(item))
  ));
}

function performerLabel(value: string | null, source: string) {
  const label = clean(value);
  if (!source.startsWith("dropx_one") || !/^\d+$/.test(label)) return label || "-";
  let digits = label;
  if (digits.startsWith("9191") && digits.length === 14) digits = digits.slice(2);
  if (digits.startsWith("91") && digits.length === 12) return `+91 ${digits.slice(2)}`;
  if (digits.length === 10) return `+91 ${digits}`;
  return label || "-";
}

function mobileLabel(countryCode: unknown, mobile: unknown) {
  const code = String(countryCode ?? "").replace(/\D/g, "") || "91";
  let number = String(mobile ?? "").replace(/\D/g, "");
  if (!number) return "";
  if (number.startsWith(code) && number.length > 10) number = number.slice(code.length);
  return `+${code} ${number}`;
}

function jsonValue(value: unknown) {
  if (value == null) return "";
  return JSON.stringify(value);
}

function displayDate(value: string) {
  return formatDashboardDateTime(value);
}

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const authorization = await requirePagePermission("verification_api_reports", "access");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) {
      return Response.json({ error: "Supabase service role key is not configured." }, { status: 500 });
    }

    const params = request.nextUrl.searchParams;
    const from = safeDate(params.get("from"));
    const to = safeDate(params.get("to"));
    const kinds = selectedValues(params.get("kind"), Object.keys(kindLabels));
    const sources = selectedValues(params.get("source"), Object.keys(sourceLabels));
    const profileTypes = selectedValues(params.get("profile_type"), Object.keys(profileLabels));
    const results = selectedValues(params.get("result"), ["success", "failed"]);
    const search = clean(params.get("search")).replace(/[,%()]/g, " ");
    const rows: AuditRow[] = [];
    const batchSize = 1000;

    for (let offset = 0; ; offset += batchSize) {
      let query = supabaseAdmin
        .from("verification_api_audit_logs")
        .select(
          "account_id, provider_code, verification_kind, endpoint, source, profile_type, account_code, profile_name, actor_user_id, actor_label, request_data, response_data, http_status, is_success, result_code, result_message, duration_ms, created_at"
        )
        .eq("company_id", companyId)
        .order("created_at", { ascending: false });

      if (from) query = query.gte("created_at", `${from}T00:00:00+05:30`);
      if (to) query = query.lte("created_at", `${to}T23:59:59.999+05:30`);
      if (kinds.length) query = query.in("verification_kind", kinds);
      if (sources.length) query = query.in("source", sources);
      if (profileTypes.length) query = query.in("profile_type", profileTypes);
      if (results.length === 1) query = query.eq("is_success", results[0] === "success");
      if (search) {
        query = query.or(
          `account_code.ilike.%${search}%,profile_name.ilike.%${search}%,actor_label.ilike.%${search}%,result_message.ilike.%${search}%`
        );
      }

      const response = await query.range(offset, offset + batchSize - 1);
      if (response.error) throw new Error(response.error.message);
      const batch = (response.data ?? []) as AuditRow[];
      rows.push(...batch);
      if (batch.length < batchSize) break;
    }

    const actorUserIds = Array.from(new Set(rows.map((row) => row.actor_user_id).filter(Boolean))) as string[];
    const actorEmails = new Map<string, string>();
    if (actorUserIds.length) {
      const actors = await supabaseAdmin
        .from("profiles")
        .select("id, email")
        .eq("company_id", companyId)
        .in("id", actorUserIds);
      if (actors.error) throw new Error(actors.error.message);
      (actors.data ?? []).forEach((actor) => {
        if (actor.email) actorEmails.set(actor.id as string, actor.email as string);
      });
    }

    const appActorMobiles = new Map<string, string>();
    const appProfileTables = [
      ["employee", "employees"],
      ["field_executive", "field_executives"],
      ["contractor", "contractors"],
      ["vendor", "vendors"],
      ["worker", "workers"]
    ] as const;
    const appActorResults = await Promise.all(appProfileTables.map(async ([profileType, table]) => {
      const ids = Array.from(new Set(
        rows
          .filter((row) => row.source.startsWith("dropx_one") && row.profile_type === profileType)
          .map((row) => row.account_id)
          .filter(Boolean)
      )) as string[];
      if (!ids.length) return [] as Array<[string, string]>;
      const profiles = await supabaseAdmin!
        .from(table)
        .select("id, mobile, mobile_country_code")
        .eq("company_id", companyId)
        .in("id", ids);
      if (profiles.error) throw new Error(profiles.error.message);
      return (profiles.data ?? []).map((profile) => [
        `${profileType}:${profile.id}`,
        mobileLabel(profile.mobile_country_code, profile.mobile)
      ] as [string, string]);
    }));
    appActorResults.flat().forEach(([key, value]) => appActorMobiles.set(key, value));

    const sheetRows = rows.map((row) => ({
      "Date and time": displayDate(row.created_at),
      "API": kindLabels[row.verification_kind] ?? row.verification_kind,
      "Provider": row.provider_code.toUpperCase(),
      "Verification subject": row.profile_name ?? "",
      "DropX ID": row.account_code ?? "",
      "Category": row.profile_type ? profileLabels[row.profile_type] ?? row.profile_type : "",
      "Performed by": performerLabel(row.actor_label, row.source),
      "Performer mobile": row.source.startsWith("dropx_one") && row.account_id && row.profile_type
        ? appActorMobiles.get(`${row.profile_type}:${row.account_id}`) ?? ""
        : "",
      "Performer email": row.source === "dashboard" && row.actor_user_id
        ? actorEmails.get(row.actor_user_id) ?? ""
        : "",
      "Platform": sourceLabels[row.source] ?? row.source,
      "Result": row.is_success ? "Success" : "Failed",
      "HTTP status": row.http_status ?? "",
      "Response": row.result_message ?? "",
      "Result code": row.result_code ?? "",
      "Response time (ms)": row.duration_ms ?? "",
      "Endpoint": row.endpoint,
      "Request data": jsonValue(row.request_data),
      "Response data": jsonValue(row.response_data)
    }));

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(sheetRows);
    sheet["!cols"] = [
      { wch: 22 }, { wch: 20 }, { wch: 12 }, { wch: 28 }, { wch: 16 },
      { wch: 24 }, { wch: 24 }, { wch: 20 }, { wch: 30 }, { wch: 22 }, { wch: 12 },
      { wch: 12 }, { wch: 42 }, { wch: 16 }, { wch: 20 }, { wch: 28 },
      { wch: 55 }, { wch: 70 }
    ];
    XLSX.utils.book_append_sheet(workbook, sheet, "Verification API");
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
    const date = new Date().toISOString().slice(0, 10);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Disposition": `attachment; filename="verification-api-report-${date}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Cache-Control": "private, max-age=0, no-store"
      }
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to export verification API report." },
      { status: 500 }
    );
  }
}
