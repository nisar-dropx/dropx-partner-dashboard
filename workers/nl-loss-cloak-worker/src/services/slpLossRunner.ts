import XlsxPopulate from 'xlsx-populate';
import type { Env, ParsedLossTable, WorkforceAuthContext } from '../types';
import {
  SLP_FILE_MATCHERS,
  slpCatalogStations,
  slpLookbackWeeks,
  workforceBaseUrl,
  workforceCompanyId,
  type SlpKind,
} from '../config';
import { WorkforceProvider, type WorkforceSuppCatalogRow } from '../providers/WorkforceProvider';
import { ensureValidWorkforceSession } from '../session/ensureWorkforceSession';
import { createDashboardSupabase } from '../store/factory';
import { LossReportStore, type LossReportKind } from '../store/LossReportStore';
import { defaultSuppIsoWeek, shiftIsoWeek } from '../utils/isoWeek';
import { extractPasswordProtectedExcelFromZip } from './extractProtectedExcel';
import { buildLossTable, gridToRecords, parseCsv } from './lossTable';

interface FoundFile {
  station: string;
  isoWeek: string;
  row: WorkforceSuppCatalogRow;
}

export interface SlpKindResult {
  kind: SlpKind;
  status: 'ingested' | 'unchanged' | 'not_found' | 'error';
  fileName?: string;
  isoWeek?: string;
  rows?: number;
  stations?: number;
  error?: string;
}

/**
 * Latest "EDSP SLP Initial Recovery File-…" and "EDSP SLP Final Recovery File-…"
 * from the Performance supp-reports catalog, using the SHARED workforce
 * session (same workforce_sessions row as Report-auto-worker / cash-recon).
 *
 * Amazon publishes each file in whichever week it was generated (Initial
 * Aug-Sep → W40, Final June-July → W32), so we walk back week by week until
 * both are found or the lookback window ends.
 */
export async function runSlpLoss(env: Env, triggeredBy: string): Promise<{ ok: boolean; results: SlpKindResult[]; error?: string }> {
  const ensured = await ensureValidWorkforceSession(env, { triggeredBy: `slp-loss:${triggeredBy}` });
  if (!ensured.ok) return { ok: false, results: [], error: `${ensured.code}: ${ensured.error}` };

  const provider = new WorkforceProvider(workforceBaseUrl(env), workforceCompanyId(env));
  const store = new LossReportStore(createDashboardSupabase(env));
  const found = await findLatestFiles(env, provider, ensured.auth);

  const results: SlpKindResult[] = [];
  for (const kind of ['initial', 'final'] as const) {
    const files = found[kind];
    const report: LossReportKind = kind === 'initial' ? 'slp_initial' : 'slp_final';
    if (!files.length) {
      results.push({ kind, status: 'not_found' });
      continue;
    }
    const first = files[0]!;
    const createdAt = files.map((f) => f.row.formattedCreationDate ?? '').sort().pop() || null;
    try {
      if (await store.hasCompletedSource(report, first.row.name, createdAt)) {
        results.push({ kind, status: 'unchanged', fileName: first.row.name, isoWeek: first.isoWeek });
        continue;
      }
      const table = await downloadAndMerge(env, provider, files);
      const saved = await store.saveRun(
        report,
        {
          fileName: first.row.name,
          sourceWeek: first.isoWeek,
          sourceCreatedAt: createdAt,
          periodLabel: periodLabel(first.row.name),
          triggeredBy,
        },
        table,
      );
      results.push({ kind, status: 'ingested', fileName: first.row.name, isoWeek: first.isoWeek, rows: saved.rows, stations: saved.stations });
    } catch (err) {
      const message = (err as Error).message;
      await store.recordFailure(report, triggeredBy, message).catch(() => undefined);
      results.push({ kind, status: 'error', fileName: first.row.name, isoWeek: first.isoWeek, error: message });
    }
  }
  return { ok: results.every((r) => r.status !== 'error'), results };
}

async function findLatestFiles(
  env: Env,
  provider: WorkforceProvider,
  auth: WorkforceAuthContext,
): Promise<Record<SlpKind, FoundFile[]>> {
  const out: Record<SlpKind, FoundFile[]> = { initial: [], final: [] };
  const stations = slpCatalogStations(env);
  const current = defaultSuppIsoWeek();

  for (let back = 0; back < slpLookbackWeeks(env); back++) {
    if (out.initial.length && out.final.length) break;
    const isoWeek = shiftIsoWeek(current, -back);
    const weekHits: Record<SlpKind, FoundFile[]> = { initial: [], final: [] };
    for (const station of stations) {
      let catalog: WorkforceSuppCatalogRow[];
      try {
        catalog = await provider.getStationWeeklySuppReports(auth, { station, isoWeek, dsp: env.WORKFORCE_DSP });
      } catch (err) {
        console.warn(`slp catalog ${station} ${isoWeek} failed`, (err as Error).message);
        continue;
      }
      for (const kind of ['initial', 'final'] as const) {
        const row = catalog.find((r) => SLP_FILE_MATCHERS[kind].test(r.name));
        if (row) weekHits[kind].push({ station, isoWeek, row });
      }
    }
    for (const kind of ['initial', 'final'] as const) {
      // Most recent week wins; a kind already found is never overwritten by an older week.
      if (!out[kind].length && weekHits[kind].length) out[kind] = weekHits[kind];
    }
  }
  return out;
}

/** Download every station's copy; identical copies (same bytes) are counted once. */
async function downloadAndMerge(env: Env, provider: WorkforceProvider, files: FoundFile[]): Promise<ParsedLossTable> {
  const password = String(env.AMAZON_EXCEL_OPEN_PASSWORD ?? '').trim();
  const seen = new Set<string>();
  let merged: ParsedLossTable | null = null;

  for (const file of files) {
    const bytes = await provider.downloadBinary(file.row.downloadUrl);
    const digest = await sha256(bytes);
    if (seen.has(digest)) continue;
    seen.add(digest);

    const grid = await fileToGrid(file.row, bytes, password);
    const { headers, records } = gridToRecords(grid);
    // Files without a station column are attributed to the catalog station they came from.
    const table = buildLossTable(headers, records, file.station);
    if (!merged) merged = table;
    else merged.rows.push(...table.rows);
  }
  if (!merged) throw new Error('No SLP file content could be read.');
  return merged;
}

async function fileToGrid(row: WorkforceSuppCatalogRow, bytes: Uint8Array, password: string): Promise<string[][]> {
  const type = row.type || row.name.split('.').pop()?.toLowerCase() || '';
  let sheetBytes = bytes;
  let isCsv = type === 'csv';
  if (type === 'zip') {
    const extracted = await extractPasswordProtectedExcelFromZip(bytes, password);
    sheetBytes = extracted.bytes;
    isCsv = extracted.contentType === 'text/csv';
  }
  if (isCsv) return parseCsv(new TextDecoder().decode(sheetBytes));

  let workbook;
  try {
    workbook = await XlsxPopulate.fromDataAsync(sheetBytes);
  } catch {
    workbook = await XlsxPopulate.fromDataAsync(sheetBytes, { password });
  }
  // Largest sheet = the data sheet (recovery files sometimes carry a summary tab first).
  let best: unknown[][] = [];
  for (const sheet of workbook.sheets()) {
    const values = sheet.usedRange()?.value() ?? [];
    if (values.length > best.length) best = values;
  }
  return best.map((r) => (r ?? []).map(cellToString));
}

function cellToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object' && 'text' in (v as Record<string, unknown>)) {
    return String((v as { text: () => string }).text?.() ?? '');
  }
  return String(v);
}

/** " EDSP SLP Final Recovery File- June-July.zip" → "June-July". */
function periodLabel(name: string): string | null {
  const m = /Recovery\s+File\s*-\s*(.+?)\.(zip|xlsx|xls|csv)$/i.exec(name.trim());
  return m?.[1]?.trim() || null;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
