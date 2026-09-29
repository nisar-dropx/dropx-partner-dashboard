import type { ParsedLossRow, ParsedLossTable } from '../types';

/**
 * Column detection for Amazon loss files whose exact layout varies by report.
 * Candidates are matched against normalized header names in priority order;
 * the chosen columns are stored on the run so the dashboard can show them.
 */
const STATION_CANDIDATES = [
  'station_code', 'station', 'delivery_station', 'ds_code', 'ds', 'node_id', 'node', 'station_name', 'site', 'warehouse_id', 'fc',
];
const AMOUNT_CANDIDATES = [
  'loss_amount', 'recovery_amount', 'final_recovery_amount', 'initial_recovery_amount', 'recovery', 'amount', 'loss_value',
  'item_value', 'value', 'total', 'price', 'cost', 'debit',
];
const REFERENCE_CANDIDATES = [
  'tracking_id', 'trackingid', 'tracking', 'case_id', 'caseid', 'case', 'shipment_id', 'package_id', 'awb', 'scannable_id', 'id',
];

export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function parseAmount(value: string | undefined): number | null {
  if (value == null) return null;
  const cleaned = String(value).replace(/[₹,\s]|INR|Rs\.?/gi, '');
  if (!cleaned || !/^-?\(?\d*\.?\d+\)?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith('(') || cleaned.startsWith('-');
  const n = Number(cleaned.replace(/[()-]/g, ''));
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

/** "KOZA", "koza", "KOZA - Kozhikode" → "KOZA". */
export function normalizeStation(value: string | undefined): string | null {
  const upper = String(value ?? '').trim().toUpperCase();
  if (!upper) return null;
  const code = /\b[A-Z]{3}[A-Z0-9]\b/.exec(upper);
  return code ? code[0] : upper.slice(0, 32);
}

function pickColumn(
  headers: string[],
  candidates: string[],
  rows: Record<string, string>[],
  accept: (v: string) => boolean = () => true,
): string | null {
  const normalized = headers.map((h) => [h, normalizeHeader(h)] as const);
  const sample = rows.slice(0, 200);
  const fits = (h: string) => {
    const filled = sample.filter((r) => (r[h] ?? '').trim());
    return filled.length > 0 && filled.filter((r) => accept(r[h]!)).length / filled.length >= 0.6;
  };
  for (const cand of candidates) {
    const exact = normalized.find(([, n]) => n === cand);
    if (exact && fits(exact[0])) return exact[0];
  }
  for (const cand of candidates) {
    const partial = normalized.find(([, n]) => n.includes(cand));
    if (partial && fits(partial[0])) return partial[0];
  }
  return null;
}

export function buildLossTable(headers: string[], records: Record<string, string>[], fallbackStation?: string): ParsedLossTable {
  const stationColumn = pickColumn(headers, STATION_CANDIDATES, records);
  const amountColumn = pickColumn(headers, AMOUNT_CANDIDATES, records, (v) => parseAmount(v) !== null);
  const referenceColumn = pickColumn(headers, REFERENCE_CANDIDATES, records);
  const rows: ParsedLossRow[] = records.map((raw) => ({
    stationCode: (stationColumn ? normalizeStation(raw[stationColumn]) : null) ?? fallbackStation ?? null,
    amount: amountColumn ? parseAmount(raw[amountColumn]) : null,
    reference: referenceColumn ? (raw[referenceColumn] ?? '').trim() || null : null,
    raw,
  }));
  return { headers, stationColumn, amountColumn, referenceColumn, rows };
}

/** 2D grid (CSV or sheet) → records keyed by header; header = densest of the first 10 rows. */
export function gridToRecords(grid: string[][]): { headers: string[]; records: Record<string, string>[] } {
  let headerIdx = 0;
  let best = -1;
  for (let i = 0; i < Math.min(10, grid.length); i++) {
    const filled = (grid[i] ?? []).filter((c) => c.trim()).length;
    if (filled > best) {
      best = filled;
      headerIdx = i;
    }
  }
  const seen = new Map<string, number>();
  const headers = (grid[headerIdx] ?? []).map((h, i) => {
    const base = h.trim() || `column_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base}_${n}` : base;
  });
  const records: Record<string, string>[] = [];
  for (const row of grid.slice(headerIdx + 1)) {
    if (!row.some((c) => c.trim())) continue;
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      rec[h] = (row[i] ?? '').trim();
    });
    records.push(rec);
  }
  return { headers, records };
}

/** RFC 4180 CSV → grid. Handles quotes, escaped quotes, CRLF, and a BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
