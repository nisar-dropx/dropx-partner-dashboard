import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  normalizeWorkforceAdvanceId,
  parseWorkforceAdvanceWorkbook,
  workforceAdvanceImportBusinessKey,
  workforceAdvanceLegacyImportBusinessKey,
  type WorkforceAdvanceImportIssue,
  type WorkforceAdvanceImportRow
} from "@/lib/workforce-advance-import";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_PATTERN = /\.(xlsx|xls|csv)$/i;
const NO_LOCATION = "00000000-0000-0000-0000-000000000000";
const noStore = { "Cache-Control": "private, no-store" };

type PreparedAdvanceRow = WorkforceAdvanceImportRow & {
  workforceId: string | null;
  fullName: string;
  stationId: string | null;
  location: string;
  linkStatus: "pending" | "linked";
  businessKey: string;
  legacyBusinessKey: string | null;
};

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

async function readAllRows(query: any) {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const result = await query.range(from, from + 999);
    if (result.error) throw new Error(result.error.message);
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to upload Workforce advances.", 401);
    const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_advances" : "workforce_advances";
    if (!hasPermission(authorization, pageCode, "add")) {
      return errorResponse("Add access to Workforce Advance Register is required.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);
    const companyId = requireCompanyId(authorization);
    const allLocations = authorization.hasAllLocationAccess || isCompanyOwner(authorization);
    const allowedLocations = new Set(authorization.locationScopeIds);
    const form = await request.formData();
    const mode = String(form.get("mode") ?? "preview");
    const file = form.get("file");
    if (mode !== "preview" && mode !== "commit") return errorResponse("Select preview or commit mode.", 400);
    if (!(file instanceof File) || !file.name || !file.size) return errorResponse("Choose a Workforce advance workbook.", 400);
    if (!FILE_PATTERN.test(file.name)) return errorResponse("Upload an Excel or CSV workbook.", 400);
    if (file.size > MAX_FILE_BYTES) return errorResponse("The workbook must be 5 MB or smaller.", 413);

    let parsed;
    try {
      parsed = parseWorkforceAdvanceWorkbook(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "The workbook could not be read.", 400);
    }
    let workersQuery = supabaseAdmin.from("workforce")
      .select("id,dropx_id,full_name,location_id,deleted_at")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .or("migration_state.is.null,migration_state.neq.reclassified")
      .order("id");
    if (!allLocations) {
      workersQuery = workersQuery.in("location_id", allowedLocations.size ? [...allowedLocations] : [NO_LOCATION]);
    }
    const [workers, stations, previousBatch] = await Promise.all([
      readAllRows(workersQuery),
      readAllRows(supabaseAdmin.from("stations")
        .select("id,station_code,station_name")
        .eq("company_id", companyId)
        .order("station_code")),
      supabaseAdmin.from("workforce_advance_import_batches")
        .select("id,created_at")
        .eq("company_id", companyId)
        .eq("file_sha256", parsed.fileSha256)
        .maybeSingle()
    ]);
    if (previousBatch.error) return errorResponse(previousBatch.error.message, 400);
    const stationById = new Map(stations.map((station) => [String(station.id), station]));
    const workersByDropxId = new Map<string, any[]>();
    for (const worker of workers) {
      const key = normalizeWorkforceAdvanceId(worker.dropx_id);
      if (!key) continue;
      workersByDropxId.set(key, [...(workersByDropxId.get(key) ?? []), worker]);
    }
    const issues: WorkforceAdvanceImportIssue[] = [...parsed.issues];
    const prepared = parsed.rows.flatMap<PreparedAdvanceRow>((row) => {
      const matches = workersByDropxId.get(row.normalizedDropxId) ?? [];
      if (!matches.length) {
        if (!allLocations) {
          issues.push({
            rowNumber: row.rowNumber,
            dropxId: row.dropxId,
            message: "This DropX ID is not available in your assigned locations. Company-wide location access is required to import advances that await Workforce registration."
          });
          return [];
        }
        return [{
          ...row,
          workforceId: null,
          fullName: "Awaiting Workforce registration",
          stationId: null,
          location: "—",
          linkStatus: "pending" as const,
          businessKey: workforceAdvanceImportBusinessKey({
            dropxId: row.dropxId,
            advanceDate: row.advanceDate,
            amount: Number(row.amount),
            reference: row.reference,
            paymentMode: row.paymentMode
          }),
          legacyBusinessKey: null
        }];
      }
      if (matches.length > 1) {
        issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "More than one Workforce profile matches this DropX ID." });
        return [];
      }
      const worker = matches[0];
      const stationId = String(worker.location_id ?? "");
      const station = stationById.get(stationId);
      if (!station) {
        issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "The Workforce profile does not have a valid company location." });
        return [];
      }
      if (!allLocations && !allowedLocations.has(stationId)) {
        issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "This Workforce profile is outside your assigned locations." });
        return [];
      }
      return [{
        ...row,
        workforceId: String(worker.id),
        fullName: String(worker.full_name ?? "Workforce"),
        stationId,
        location: String(station.station_code ?? station.station_name ?? "—"),
        linkStatus: "linked" as const,
        businessKey: workforceAdvanceImportBusinessKey({
          dropxId: row.dropxId,
          advanceDate: row.advanceDate,
          amount: Number(row.amount),
          reference: row.reference,
          paymentMode: row.paymentMode
        }),
        legacyBusinessKey: workforceAdvanceLegacyImportBusinessKey({
          workforceId: String(worker.id),
          advanceDate: row.advanceDate,
          amount: Number(row.amount),
          reference: row.reference,
          paymentMode: row.paymentMode
        })
      }];
    });
    const firstRowByBusinessKey = new Map<string, number>();
    for (const row of prepared) {
      const firstRow = firstRowByBusinessKey.get(row.businessKey);
      if (firstRow) {
        issues.push({
          rowNumber: row.rowNumber,
          dropxId: row.dropxId,
          message: `This advance has the same reference or business details as row ${firstRow}. Keep only one copy.`
        });
      } else {
        firstRowByBusinessKey.set(row.businessKey, row.rowNumber);
      }
    }
    const existingByBusinessKey = new Map<string, { advance_number: string }>();
    const businessKeys = [...new Set(prepared.flatMap((row) => [row.businessKey, row.legacyBusinessKey].filter((key): key is string => Boolean(key))))];
    for (let index = 0; index < businessKeys.length; index += 100) {
      const existing = await readAllRows(supabaseAdmin.from("workforce_advances")
        .select("advance_number,external_reference")
        .eq("company_id", companyId)
        .in("external_reference", businessKeys.slice(index, index + 100)));
      for (const advance of existing) {
        existingByBusinessKey.set(String(advance.external_reference), advance);
      }
    }
    for (const row of prepared) {
      const existing = existingByBusinessKey.get(row.businessKey)
        ?? (row.legacyBusinessKey ? existingByBusinessKey.get(row.legacyBusinessKey) : undefined);
      if (existing) {
        issues.push({
          rowNumber: row.rowNumber,
          dropxId: row.dropxId,
          message: `This advance is already in the register as ${String(existing.advance_number)}.`
        });
      }
    }
    if (previousBatch.data) {
      issues.push({ rowNumber: null, dropxId: null, message: "This exact workbook was already imported. No duplicate advances will be created." });
    }
    const preview = {
      fileName: file.name,
      fileSha256: parsed.fileSha256,
      totalRows: parsed.rows.length,
      matchedRows: prepared.filter((row) => row.linkStatus === "linked").length,
      pendingRows: prepared.filter((row) => row.linkStatus === "pending").length,
      canCommit: issues.length === 0,
      issues,
      rows: prepared.slice(0, 50).map((row) => ({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        fullName: row.fullName,
        location: row.location,
        linkStatus: row.linkStatus,
        advanceDate: row.advanceDate,
        amount: row.amount,
        deductedAmount: row.deductedAmount,
        pendingAmount: Math.max(0, Number(row.amount) - row.deductedAmount),
        reference: row.reference,
        paymentMode: row.paymentMode,
        remark: row.remark
      }))
    };
    if (mode === "preview") return Response.json(preview, { headers: noStore });
    if (issues.length) return Response.json({ ...preview, error: "Correct every issue and preview the workbook again before importing." }, { status: 400, headers: noStore });

    const applied = await supabaseAdmin.rpc("workforce_apply_advance_import", {
      p_company_id: companyId,
      p_file_name: file.name.slice(0, 240),
      p_file_sha256: parsed.fileSha256,
      p_rows: prepared.map((row) => ({
        row_number: row.rowNumber,
        dropx_id: row.dropxId,
        advance_date: row.advanceDate,
        amount: row.amount,
        deducted_amount: row.deductedAmount,
        payment_mode: row.paymentMode,
        payment_reference: row.reference || null,
        remark: row.remark || null
      })),
      p_actor_user_id: authorization.userId,
      p_allowed_location_ids: allLocations ? null : [...allowedLocations]
    });
    if (applied.error) {
      const conflict = /already|duplicate|unique/i.test(applied.error.message);
      return errorResponse(
        conflict ? "One or more advances are already in the register. Preview the current workbook and remove the duplicate rows." : applied.error.message,
        conflict ? 409 : 400
      );
    }
    return Response.json({
      ...preview,
      canCommit: false,
      importId: applied.data,
      message: `${prepared.length} Workforce advance${prepared.length === 1 ? " was" : "s were"} imported.${preview.pendingRows ? ` ${preview.pendingRows} ${preview.pendingRows === 1 ? "is" : "are"} awaiting Workforce registration.` : ""}`
    }, { headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to process the Workforce advance workbook.", 500);
  }
}
