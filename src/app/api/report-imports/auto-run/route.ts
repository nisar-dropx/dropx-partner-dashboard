export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { getAuthorization, hasPermission } from "@/lib/authorization";
import {
  isReportAutoSource,
  isReportAutoWorkerConfigured,
  isWorkforceAutoSource,
  isoWeekFromYmd,
  reportAutoFetchFile,
  reportAutoGet,
  reportAutoPost,
  type AutoRunResult,
  type WorkforceReadyResponse
} from "@/lib/report-auto-worker";

function todayIst(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function yesterdayIst(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(Date.now() - 24 * 60 * 60 * 1000)
  );
}

function ymdOrNull(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

type ImportOutcome = {
  imported?: number;
  skipped?: number;
  totalRows?: number;
  message: string;
};

/**
 * The worker only stages portal files in Supabase Storage; Import Master needs a
 * multipart POST from a logged-in session. Forward the caller's cookies so the
 * batch lands in the Upload log instead of waiting for a worker-side cookie.
 */
async function importWorkerArtifact(
  request: Request,
  args: { downloadPath?: string; sourceType: string; reportDate: string; stationCode?: string }
): Promise<ImportOutcome> {
  if (!args.downloadPath) {
    return { message: "Worker finished but returned no file to import. Use Manual upload." };
  }
  const file = await reportAutoFetchFile(args.downloadPath);
  const form = new FormData();
  form.set("source_type", args.sourceType);
  form.set("report_date", args.reportDate);
  if (args.stationCode) form.set("station_code", args.stationCode);
  form.set("file", new File([file.bytes], file.fileName, { type: file.mime }));

  const cookie = request.headers.get("cookie");
  const response = await fetch(new URL("/api/report-imports", request.url), {
    method: "POST",
    headers: cookie ? { cookie } : undefined,
    body: form,
    cache: "no-store"
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    imported?: number;
    skipped?: number;
    totalRows?: number;
  };
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || `Import Master returned ${response.status}`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
  return {
    imported: payload.imported,
    skipped: payload.skipped,
    totalRows: payload.totalRows,
    message: payload.message || "Imported into Import Master."
  };
}

export async function POST(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization) return Response.json({ error: "Login required." }, { status: 401 });
  if (!hasPermission(authorization, "imports", "add") && !hasPermission(authorization, "imports", "edit")) {
    return Response.json({ error: "Report import permission denied." }, { status: 403 });
  }
  if (!isReportAutoWorkerConfigured()) {
    return Response.json(
      { error: "Auto upload is not configured. Set REPORT_AUTO_WORKER_URL and REPORT_AUTO_ADMIN_KEY, or use Manual upload." },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    source_type?: string;
    report_date?: string;
    station_code?: string;
  };
  const sourceType = String(body.source_type || "").trim();
  if (!isReportAutoSource(sourceType)) {
    return Response.json(
      { error: "Auto upload is not available for this report. Use Manual upload." },
      { status: 400 }
    );
  }

  const reportDate = ymdOrNull(body.report_date) || yesterdayIst();

  try {
    if (isWorkforceAutoSource(sourceType)) {
      const isoWeek = isoWeekFromYmd(ymdOrNull(body.report_date) || todayIst());
      const ready = await reportAutoGet<WorkforceReadyResponse>(
        "/api/admin/reports/workforce-supp/ready",
        { isoWeek, reportId: sourceType }
      );
      if (!ready.ready && !ready.alreadyUploaded) {
        return Response.json(
          {
            ok: false,
            sourceType,
            ready: false,
            isoWeek: isoWeek || ready.isoWeek,
            error:
              ready.reason
              || "Amazon has not published today’s weekly-supp files yet (formattedCreationDate). Use Manual upload or retry after 8am–3pm."
          },
          { status: 409 }
        );
      }
      const run = await reportAutoPost<{ ok: boolean; run?: { id?: string }; isoWeek?: string }>(
        "/api/admin/reports/workforce-supp/run",
        { isoWeek, reportId: sourceType, forceNew: true }
      );
      const week = run.isoWeek || ready.isoWeek || isoWeek;
      const result: AutoRunResult = {
        ok: true,
        sourceType,
        runId: run.run?.id,
        isoWeek: week,
        ready: true,
        message: `${sourceType} auto run started for ${week}. Check Upload log for the Import Master batch.`
      };
      return Response.json(result);
    }

    if (sourceType === "delivered_shipment_detail") {
      const run = await reportAutoPost<{
        ok: boolean;
        done?: boolean;
        reportDate?: string;
        run?: { id?: string };
        lastStationCode?: string;
      }>("/api/admin/reports/delivered-shipment/refresh", {
        reportDate,
        forceNew: true,
        processTicks: 1
      });
      const runId = run.run?.id;
      const result: AutoRunResult = {
        ok: true,
        sourceType,
        runId,
        reportDate: run.reportDate || reportDate,
        done: Boolean(run.done),
        statusUrl: runId
          ? `/api/admin/reports/delivered-shipment/status?reportDate=${encodeURIComponent(run.reportDate || reportDate)}&runId=${encodeURIComponent(runId)}`
          : undefined,
        message: run.done
          ? `Delivered data finished for ${run.reportDate || reportDate}.`
          : `Delivered data started (${run.lastStationCode || "first station"}). Remaining stations continue on the worker ticker — check Upload log shortly.`
      };
      return Response.json(result);
    }

    const path =
      sourceType === "iocl_fuel"
        ? "/api/admin/reports/iocl-fuel/run"
        : sourceType === "bpcl_fuel"
          ? "/api/admin/reports/bpcl-fuel/run"
          : "/api/admin/reports/cashbook/run";
    const run = await reportAutoPost<{
      ok?: boolean;
      error?: string;
      reportDate?: string;
      downloadPath?: string;
      clientPortal?: boolean;
      run?: { id?: string; error?: string | null };
    }>(path, { reportDate, forceNew: true });
    if (run.error || run.run?.error) {
      if (run.clientPortal && (sourceType === "iocl_fuel" || sourceType === "bpcl_fuel")) {
        return Response.json({
          ok: false,
          sourceType,
          reportDate,
          clientPortal: true,
          error: run.error || run.run?.error || "Worker portal browser blocked."
        }, { status: 409 });
      }
      return Response.json(
        { ok: false, sourceType, reportDate, error: run.error || run.run?.error },
        { status: 502 }
      );
    }
    const effectiveDate = run.reportDate || reportDate;
    const imported = await importWorkerArtifact(request, {
      downloadPath: run.downloadPath,
      sourceType,
      reportDate: effectiveDate
    });
    const result: AutoRunResult = {
      ok: true,
      sourceType,
      runId: run.run?.id,
      reportDate: effectiveDate,
      imported: imported.imported,
      skipped: imported.skipped,
      totalRows: imported.totalRows,
      message: `${sourceType} auto run completed for ${effectiveDate}. ${imported.message}`
    };
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status === 409 ? 409 : 502;
    return Response.json({ ok: false, sourceType, error: message }, { status });
  }
}
