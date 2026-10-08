import * as XLSX from "xlsx";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  loadRecoveryView,
  nlStationScope,
  ALL_PERIODS,
  type RecoveryKind,
} from "@/lib/ops-pulse/nl-loss";
import { loadRecoveryPayables } from "@/lib/ops-pulse/nl-recovery-payables";
import {
  isRecoverable,
  type LossSettings,
  type Recovery,
  type RecoveryOutcome,
  type RecoveryPerson,
} from "@/lib/ops-pulse/nl-loss-policy";
import {
  WORKBOOK_COLUMNS,
  WORKBOOK_MAX_ROWS,
  WORKBOOK_SHEET,
  caseRef,
  matchOutcome,
  parseAllocationCell,
  parseCaseRef,
  yes,
  type WorkbookColumn,
} from "@/lib/ops-pulse/loss-workbook-policy";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const KINDS: RecoveryKind[] = ["nl", "slp_initial", "slp_final"];
const UPLOAD_MAX_FILLED = 500;
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
const chunks = <T,>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, i * size + size),
  );
const allocationText = (r: Recovery | null) =>
  !r?.allocations.length
    ? ""
    : r.split_mode === "custom"
      ? r.allocations.map((p) => `${p.employee_code}=${p.amount}`).join(", ")
      : r.allocations.map((p) => p.employee_code).join(", ");

/** The user's recovery worklist as a workbook: cases to fill, plus the choices they may use. */
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "ops_losses", "access"))
    return reply({ error: "Access denied." }, 403);
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") as RecoveryKind;
  if (!KINDS.includes(kind)) return reply({ error: "Unknown loss report." }, 400);
  try {
    const param = (name: string) => url.searchParams.get(name) || undefined;
    const view = await loadRecoveryView(
      auth,
      kind,
      {
        month: param("month"),
        period: param("period"),
        cluster: param("cluster"),
        station: param("station"),
        reason: param("reason"),
      },
      { allStations: true },
    );
    if (view.cases.length > WORKBOOK_MAX_ROWS)
      return reply(
        {
          error: `This selection has ${view.cases.length.toLocaleString("en-IN")} cases. Filter by cluster or station to download up to ${WORKBOOK_MAX_ROWS.toLocaleString("en-IN")} at a time.`,
        },
        413,
      );
    const stationOf = new Map(view.totals.map((s) => [s.source_code, s]));
    const policy = view.settings?.recovery_policy;
    // Same directory the recovery form uses; salary limits are verified when the file is uploaded.
    const directories = await Promise.all(
      view.totals.map(async (s) => {
        const people = await supabaseAdmin!.rpc("station_audit_employee_directory", {
          p_company: requireCompanyId(auth),
          p_station: s.id,
        });
        if (people.error) throw Error("Station employees could not be loaded.");
        return ((people.data ?? []) as RecoveryPerson[])
          .filter(
            (p) =>
              p.employee_code?.trim() &&
              (!policy?.active_only || p.is_active) &&
              (!policy?.eligible_designations.length ||
                policy.eligible_designations.some(
                  (d) => d.toLowerCase() === String(p.designation).toLowerCase(),
                )),
          )
          .map((p) => [s.station_code, p.employee_code, p.full_name, p.designation, p.is_active ? "Active" : "Inactive / left"]);
      }),
    );
    const outcomes = view.outcomes.filter(
      (o) => o.is_active && (!o.restricted || view.canRecovered),
    );
    const caseRows = view.cases.map((c) => {
      const r = c.recovery && !c.recovery.is_deleted ? c.recovery : null;
      const row: Record<WorkbookColumn, string | number> = {
        "Case ref": caseRef(c.month, c.case_key),
        Version: c.recovery?.version ?? 0,
        Month: c.month,
        Period: c.details.period && kind !== "nl" ? c.details.period : "",
        Station: stationOf.get(c.station_code)?.station_code ?? c.station_code,
        TID: `${c.details.tid_approximate ? "≈ " : ""}${c.details.tid || ""}`,
        "Loss reason": c.details.category || "",
        "Sub reason": c.details.sub_category || "",
        "Amazon decision": c.source_status || "",
        "Loss amount": Number(c.amount),
        "Current action": r?.outcome_label || "Pending",
        "Recovery action": r?.outcome_label || "",
        "Employee IDs": allocationText(r),
        Remarks: r?.remarks || "",
        "Re-dispute reason": r?.recovery_details?.reason || "",
        Detailing: r?.recovery_details?.details || "",
        "CCTV link": r?.recovery_details?.cctv_url || "",
        "CCTV link is public (Yes/No)": r?.recovery_details?.cctv_public_confirmed ? "Yes" : "",
      };
      return WORKBOOK_COLUMNS.map((column) => row[column]);
    });
    const book = XLSX.utils.book_new();
    const sheet = (name: string, rows: unknown[][], widths: number[]) => {
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = widths.map((wch) => ({ wch }));
      if (rows.length > 1 && rows[0]?.length)
        ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) };
      XLSX.utils.book_append_sheet(book, ws, name);
    };
    sheet(WORKBOOK_SHEET, [[...WORKBOOK_COLUMNS], ...caseRows], [34, 8, 9, 11, 9, 16, 26, 26, 24, 12, 22, 24, 30, 36, 28, 36, 30, 16]);
    sheet(
      "Recovery actions",
      [
        ["Recovery action", "Needs employee IDs", "Deducted in", "Remarks", "Re-dispute details"],
        ...outcomes.map((o) => [
          o.label,
          o.allocation_required ? "Yes — full amount" : "No — leave blank",
          o.deduction_timing === "current_month" ? "This month's payroll" : o.deduction_timing === "next_month" ? "Next month's payroll" : "No deduction",
          o.remarks_required ? "Required" : "Optional",
          o.dispute_fields_enabled ? `Reason ${o.reason_required ? "required" : "optional"}, detailing ${o.details_required ? "required" : "optional"}` : "Not used",
        ]),
      ],
      [28, 22, 22, 12, 44],
    );
    sheet(
      "Employees",
      [["Station", "Employee ID", "Name", "Designation", "Status"], ...directories.flat()],
      [10, 14, 32, 30, 16],
    );
    sheet(
      "How to fill",
      [
        ["Loss recovery workbook"],
        [`Downloaded ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST by ${auth.fullName || auth.email || "OpsPulse user"}. Only cases from your stations are included.`],
        [],
        ["1", "Fill only the columns from “Recovery action” onwards on the Cases sheet. Do not edit, sort away or delete “Case ref” and “Version” — they identify the case."],
        ["2", "Recovery action: copy an action exactly as written on the “Recovery actions” sheet. Leave it blank to skip a case."],
        ["3", "Employee IDs: use IDs from the “Employees” sheet for that case’s station. “D0123, D0456” splits the loss equally. “D0123=500, D0456=449” sets each amount; amounts must add up to the full loss."],
        ["4", "Re-dispute actions need the reason and detailing. If you add a CCTV link, set its sharing to “Anyone with the link can view” and enter Yes in the last column."],
        ["5", "Upload the file on the same Losses tab. Every row is checked with the same rules as the on-screen form (employee eligibility, salary limits, full-amount allocation)."],
        ["6", "If someone else updated a case after you downloaded, that row is rejected — download a fresh file for those cases. Rows that match the saved plan are left untouched."],
        ["7", "Evidence files cannot travel in Excel. Attach them on screen after uploading."],
      ],
      [4, 140],
    );
    const label = view.month && view.month !== ALL_PERIODS ? view.month : "all";
    const scope = view.station || (view.cluster ? "cluster" : "my-stations");
    return new Response(XLSX.write(book, { type: "buffer", bookType: "xlsx" }), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="loss-recovery-${kind.replace("_", "-")}-${label}-${scope}.xlsx"`.replace(/[^\x20-\x7e]/g, "_"),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return reply(
      { error: e instanceof Error ? e.message : "Workbook could not be prepared." },
      500,
    );
  }
}

type Result = {
  row: number;
  station: string;
  tid: string;
  status: "saved" | "unchanged" | "error";
  message: string;
};

/** Applies a filled workbook. Each row goes through the same save_nl_recovery rules as the form. */
export async function POST(request: Request) {
  const auth = await getAuthorization();
  if (!auth || auth.readOnly || !hasPermission(auth, "ops_losses", "edit") || !supabaseAdmin)
    return reply({ error: "Losses edit access is required to upload recovery plans." }, 403);
  if (
    request.headers.get("origin") &&
    request.headers.get("origin") !== new URL(request.url).origin
  )
    return reply({ error: "Invalid request origin." }, 403);
  try {
    const form = await request.formData();
    const kind = String(form.get("kind") || "") as RecoveryKind;
    const file = form.get("file");
    if (!KINDS.includes(kind)) return reply({ error: "Unknown loss report." }, 400);
    if (!(file instanceof File) || !file.size)
      return reply({ error: "Choose the filled workbook to upload." }, 400);
    if (file.size > UPLOAD_MAX_BYTES || !/\.xlsx$/i.test(file.name))
      return reply({ error: "Upload the .xlsx workbook downloaded from this page (up to 5 MB)." }, 400);
    let grid: unknown[][];
    try {
      const book = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
      const ws = book.Sheets[WORKBOOK_SHEET];
      if (!ws) throw Error();
      grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", blankrows: false });
    } catch {
      return reply({ error: `This file has no “${WORKBOOK_SHEET}” sheet. Upload the workbook downloaded from this page.` }, 400);
    }
    const header = (grid[0] ?? []).map((h) => String(h).trim().toLowerCase());
    const at = Object.fromEntries(
      WORKBOOK_COLUMNS.map((c) => [c, header.indexOf(c.toLowerCase())]),
    ) as Record<WorkbookColumn, number>;
    const missing = (["Case ref", "Version", "Recovery action", "Employee IDs", "Remarks"] as const).filter((c) => at[c] < 0);
    if (missing.length)
      return reply({ error: `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Download a fresh workbook.` }, 400);
    const cell = (row: unknown[], column: WorkbookColumn) =>
      at[column] < 0 ? "" : String(row[at[column]] ?? "").trim();
    const filled = grid
      .slice(1)
      .map((row, i) => ({ row, line: i + 2 }))
      .filter(({ row }) => cell(row, "Recovery action"));
    if (!filled.length)
      return reply({ error: "No row has a Recovery action filled in. Nothing was changed." }, 400);
    if (filled.length > UPLOAD_MAX_FILLED)
      return reply({ error: `Upload up to ${UPLOAD_MAX_FILLED} filled rows at a time (this file has ${filled.length}).` }, 413);

    const scope = await nlStationScope(auth);
    const company = scope.company;
    const db = supabaseAdmin;
    const [settingsResult, outcomesResult] = await Promise.all([
      db.from("nl_loss_sources").select("recoverable_statuses,recovery_policy,updated_at,allow_equal_split,allow_custom_split").eq("company_id", company).maybeSingle(),
      db.from("nl_recovery_outcomes").select("*").eq("company_id", company),
    ]);
    if (settingsResult.error || !settingsResult.data || outcomesResult.error)
      return reply({ error: "Loss Recovery Master could not be loaded. Please retry." }, 500);
    const settings = settingsResult.data as LossSettings;
    const outcomes = (outcomesResult.data ?? []) as RecoveryOutcome[];
    const canRecovered = hasPermission(auth, "ops_loss_recovered", "edit");
    const wantSlp = kind !== "nl";

    const refs = filled.map(({ row }) => parseCaseRef(cell(row, "Case ref")));
    const byMonth = new Map<string, string[]>();
    for (const ref of refs)
      if (ref) byMonth.set(ref.month, [...(byMonth.get(ref.month) ?? []), ref.case_key]);
    const cases = new Map<string, { station_code: string; amount: number; source_status: string | null; source_present: boolean; report: string; details: { tid?: string } }>();
    const plans = new Map<string, Recovery>();
    for (const [month, keys] of byMonth)
      for (const part of chunks([...new Set(keys)], 150)) {
        const [rows, saved] = await Promise.all([
          readAllRows(db.from("nl_loss_month_cases").select("case_key,station_code,amount,source_status,source_present,report,details").eq("company_id", company).eq("month", month).in("case_key", part).order("case_key")),
          readAllRows(db.from("nl_loss_recoveries").select("*").eq("company_id", company).eq("month", month).in("case_key", part).order("case_key")),
        ]);
        if (rows.error || saved.error) return reply({ error: "Cases could not be verified. Nothing was changed; please retry." }, 500);
        for (const r of rows.data ?? []) cases.set(caseRef(month, r.case_key), r);
        for (const r of saved.data ?? []) plans.set(caseRef(month, r.case_key), r as Recovery);
      }

    // Eligibility and salary limits are refreshed once per station, right before its rows are saved.
    // The save rejects a salary check older than five minutes, so a long upload re-checks in time.
    const people = new Map<string, { at: number; list: Promise<RecoveryPerson[]> }>();
    const stationPeople = (stationId: string, month: string, caseKey: string) => {
      const cached = people.get(stationId);
      if (cached && Date.now() - cached.at < 180_000) return cached.list;
      const list = loadRecoveryPayables(auth, company, stationId, month, caseKey, settings.recovery_policy, settings.updated_at);
      people.set(stationId, { at: Date.now(), list });
      return list;
    };
    const results: Result[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < filled.length; i++) {
      const { row, line } = filled[i]!;
      const ref = refs[i];
      const id = ref ? caseRef(ref.month, ref.case_key) : "";
      const source = cases.get(id);
      const done = (status: Result["status"], message: string) =>
        results.push({ row: line, station: cell(row, "Station"), tid: source?.details?.tid || cell(row, "TID"), status, message });
      try {
        if (!ref) throw Error("Case ref is missing or was edited. Download a fresh workbook.");
        if (seen.has(id)) throw Error("This case appears more than once in the file. Keep one row per case.");
        seen.add(id);
        const station = scope.stations.find((s) => s.source_code === source?.station_code);
        if (!source || !station) throw Error("Case is unavailable or outside your station access.");
        if ((source.report === "slp") !== wantSlp)
          throw Error(`This case belongs to the ${source.report === "slp" ? "SLP" : "NL"} tab. Upload it there.`);
        if (!source.source_present || (source.report !== "slp" && !isRecoverable(source.source_status, settings.recoverable_statuses)))
          throw Error("This case is no longer recoverable at source.");
        const outcome = matchOutcome(cell(row, "Recovery action"), outcomes);
        if (!outcome) throw Error(`“${cell(row, "Recovery action")}” is not an active recovery action. Copy one from the Recovery actions sheet.`);
        if (outcome.restricted && !canRecovered) throw Error(`You do not have access to mark a case as “${outcome.label}”.`);
        const plan = plans.get(id) ?? null;
        const version = Number(cell(row, "Version") || 0);
        if (!Number.isInteger(version) || version !== (plan?.version ?? 0))
          throw Error("This case was updated after the file was downloaded. Download a fresh workbook for it.");
        const allocation = parseAllocationCell(cell(row, "Employee IDs"));
        if (allocation.mode === "error") throw Error(allocation.error);
        let allocations: { employee_ref: string; amount?: number }[] = [];
        if (outcome.allocation_required) {
          if (allocation.mode === "none") throw Error(`“${outcome.label}” needs the responsible employee IDs.`);
          const directory = await stationPeople(station.id, ref.month, ref.case_key);
          allocations = allocation.people.map((p) => {
            const matches = directory.filter((d) => d.employee_code.trim().toUpperCase() === p.code);
            if (!matches.length) throw Error(`Employee ${p.code} is not an eligible employee of ${station.station_code}. Check the Employees sheet.`);
            if (matches.length > 1) throw Error(`Employee ID ${p.code} matches more than one person at ${station.station_code}. Save this case on screen.`);
            return { employee_ref: matches[0]!.ref, ...("amount" in p ? { amount: p.amount } : {}) };
          });
        } else if (allocation.mode !== "none")
          throw Error(`“${outcome.label}” does not deduct from employees. Clear the Employee IDs cell.`);
        const mode = outcome.allocation_required ? allocation.mode : "none";
        const remarks = cell(row, "Remarks");
        const current = plan && !plan.is_deleted ? plan : null;
        const lockedBy = current && !canRecovered ? outcomes.find((o) => o.code === current.outcome_code && o.restricted) : null;
        if (lockedBy) throw Error(`This case is marked “${lockedBy.label}”. Only people with that access can change it.`);
        const details = outcome.dispute_fields_enabled
          ? {
              reason: cell(row, "Re-dispute reason"),
              details: cell(row, "Detailing"),
              ...(cell(row, "CCTV link")
                ? { cctv_url: cell(row, "CCTV link"), cctv_public_confirmed: yes(cell(row, "CCTV link is public (Yes/No)")) }
                : {}),
              // Evidence uploaded on screen stays attached to the plan.
              ...(current?.recovery_details?.attachments?.length ? { attachments: current.recovery_details.attachments } : {}),
            }
          : {};
        const sameDetails = (["reason", "details", "cctv_url"] as const).every(
          (k) => String(current?.recovery_details?.[k] ?? "") === String((details as Record<string, unknown>)[k] ?? ""),
        );
        const sameAllocations =
          current?.allocations.length === allocations.length &&
          allocations.every((a, n) => current.allocations[n]?.ref === a.employee_ref && (a.amount == null || Number(current.allocations[n]?.amount) === a.amount));
        if (current && current.outcome_code === outcome.code && current.split_mode === mode && current.remarks === remarks && sameDetails && sameAllocations && Number(current.source_amount) === Number(source.amount)) {
          done("unchanged", "Already saved with these details.");
          continue;
        }
        const saved = await db.rpc("save_nl_recovery", {
          p_company: company,
          p_month: ref.month,
          p_case: ref.case_key,
          p_version: version,
          p_outcome: outcome.code,
          p_mode: mode,
          p_allocations: allocations.map((a) => ({ ...a, amount: a.amount == null ? undefined : String(a.amount) })),
          p_remarks: remarks,
          p_actor: auth.userId,
          p_name: auth.fullName || auth.email || "OpsPulse user",
          p_details: details,
        });
        if (saved.error)
          throw Error(saved.error.code === "P0001" ? saved.error.message : "Could not be saved. Retry this row.");
        done("saved", outcome.label);
      } catch (e) {
        done("error", e instanceof Error ? e.message : "Could not be saved.");
      }
    }
    const count = (status: Result["status"]) => results.filter((r) => r.status === status).length;
    return reply({
      summary: { saved: count("saved"), unchanged: count("unchanged"), failed: count("error"), skipped: grid.length - 1 - filled.length },
      results,
    });
  } catch (e) {
    return reply(
      { error: e instanceof Error ? e.message : "The workbook could not be processed." },
      500,
    );
  }
}
