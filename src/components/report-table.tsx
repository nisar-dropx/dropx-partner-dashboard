"use client";

import { Children, Fragment, cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode, type TableHTMLAttributes } from "react";
import { useOpsDesign, useOpsReportExport } from "./ops-design-context";
import { compareReportValues, type ReportSort } from "@/lib/report-table-values";
import { downloadReportExcel, type ExcelReport } from "@/lib/download-report-excel";
import styles from "./report-table.module.css";

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const element = (node: ReactNode): node is Element => isValidElement(node);
function nodes(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap(child => element(child) && child.type === Fragment ? nodes(child.props.children) : [child]);
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!element(node)) return Array.isArray(node) ? node.map(text).join(" ").trim() : "";
  if (node.props["aria-hidden"] || node.props.hidden || ["svg", "input", "select", "textarea"].includes(String(node.type))) return "";
  return nodes(node.props.children).map(text).filter(Boolean).join(" ").trim();
}
function primary(node: ReactNode): Element | undefined {
  if (!element(node)) return;
  if (node.type === "tr") return node;
  if (node.type === Fragment) return nodes(node.props.children).find(n => element(n) && n.type === "tr") as Element | undefined;
}
function cells(row: Element) { return nodes(row.props.children).filter(n => element(n) && (n.type === "td" || n.type === "th")) as Element[]; }
function value(row: Element, column: number): string {
  let index = 0;
  for (const cell of cells(row)) {
    const span = Number(cell.props.colSpan || 1);
    if (column >= index && column < index + span) return String(cell.props["data-sort-value"] ?? text(cell.props.children));
    index += span;
  }
  return "";
}
function hasControl(node: ReactNode): boolean {
  return nodes(node).some(child => element(child) && (["button", "a", "input", "select"].includes(String(child.type)) || typeof child.type !== "string" || hasControl(child.props.children)));
}
const actionColumn = (label: string) => !label || /^(?:actions?|select|edit|manage)$/i.test(label.trim());

/** Sort row groups through React, never by moving React-owned DOM nodes. */
export function sortReportBody(children: ReactNode, sort: ReportSort | null, rendered: Record<string, string[]> = {}): ReactNode[] {
  const groups: { key: string; children: ReactNode[]; row?: Element; fixed: boolean; span: number }[] = [];
  Children.toArray(children).forEach((child, index) => {
    const row = primary(child);
    const rowCells = row ? cells(row) : [];
    const previous = groups[groups.length - 1];
    const detail = rowCells.length === 1 && Number(rowCells[0].props.colSpan || 1) > 1;
    if (previous && (previous.span > 1 || detail)) {
      previous.children.push(child); previous.span = Math.max(1, previous.span - 1); return;
    }
    groups.push({ key: element(child) && child.key != null ? String(child.key) : String(index), children: [child], row,
      fixed: !row || detail || /^(?:grand total|total|subtotal)\b/i.test(rowCells.length ? text(rowCells[0].props.children) : ""),
      span: Math.max(1, ...rowCells.map(c => Number(c.props.rowSpan || 1))),
    });
  });
  // Total rows and group headings stay in place; sorting never crosses those boundaries.
  const result = [...groups];
  for (let start = 0; start < result.length;) {
    if (result[start].fixed) { start++; continue; }
    let end = start;
    while (end < result.length && !result[end].fixed) end++;
    if (sort) result.splice(start, end - start, ...result.slice(start, end).sort((a, b) => compareReportValues(rendered[a.key]?.[sort.column] ?? value(a.row!, sort.column), rendered[b.key]?.[sort.column] ?? value(b.row!, sort.column), sort.direction)));
    start = end;
  }
  function mark(node: ReactNode, key: string): ReactNode {
    if (!element(node)) return node;
    if (node.type === 'tr') return cloneElement(node, { 'data-report-row': key });
    if (node.type === Fragment) {
      let marked = false;
      return cloneElement(node, {}, nodes(node.props.children).map(child => {
        if (!marked && element(child) && child.type === 'tr') { marked = true; return mark(child, key); }
        return child;
      }));
    }
    return node;
  }
  return result.map(group => <Fragment key={group.key}>{group.children.map((child, index) => index === 0 ? mark(child, group.key) : child)}</Fragment>);
}

function cellText(cell: HTMLTableCellElement): string {
  if (cell.dataset.exportValue != null) return cell.dataset.exportValue;
  const clone = cell.cloneNode(true) as HTMLElement;
  // Nested reports have their own download. Do not duplicate their records in the parent.
  clone.querySelectorAll('table,svg,script,style,[hidden],[aria-hidden="true"],input[type="hidden"],input[type="password"],input[type="file"]').forEach(n => n.remove());
  const originalInputs = Array.from(cell.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input,select,textarea"));
  clone.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input,select,textarea").forEach((input, index) => {
    const source = originalInputs.filter(i => !["hidden", "password", "file"].includes(i.type))[index];
    const content = source instanceof HTMLSelectElement ? Array.from(source.selectedOptions).map(o => o.text).join(", ") : source instanceof HTMLInputElement && ["checkbox", "radio"].includes(source.type) ? (source.checked ? "Yes" : "No") : source?.value || "";
    input.replaceWith(document.createTextNode(content));
  });
  clone.querySelectorAll("br,small,p,div,li").forEach(n => { n.before(document.createTextNode("\n")); });
  return (clone.textContent || "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export function tableExcelData(table: HTMLTableElement): Pick<ExcelReport, "headers" | "rows"> {
  const headingRows = Array.from(table.tHead?.rows || []);
  const headers: string[] = [];
  const occupied: number[] = [];
  headingRows.forEach((row, rowIndex) => {
    let column = 0;
    Array.from(row.cells).forEach(cell => {
      while ((occupied[column] || 0) > rowIndex) column++;
      const label = cellText(cell).replace(/[↕↑↓▲▼]/g, "").trim();
      for (let i = 0; i < cell.colSpan; i++) {
        headers[column + i] = [headers[column + i], label].filter(Boolean).join(" · ");
        occupied[column + i] = rowIndex + cell.rowSpan;
      }
      column += cell.colSpan;
    });
  });
  const rows: string[][] = [];
  [...Array.from(table.tBodies), ...(table.tFoot ? [table.tFoot] : [])].forEach(body => {
    const carried = new Map<number, { value: string; remaining: number }>();
    Array.from(body.rows).filter(row => !row.hidden && row.style.display !== "none").forEach(row => {
      const values: string[] = [];
      carried.forEach((v, column) => { values[column] = v.value; if (--v.remaining === 0) carried.delete(column); });
      let column = 0;
      Array.from(row.cells).forEach(cell => {
        while (values[column] != null) column++;
        const content = cellText(cell);
        for (let i = 0; i < cell.colSpan; i++) {
          values[column + i] = i === 0 ? content : "";
          if (cell.rowSpan > 1) carried.set(column + i, { value: values[column + i], remaining: cell.rowSpan - 1 });
        }
        column += cell.colSpan;
      });
      rows.push(values);
    });
  });
  if (!headers.length) for (let i = 0; i < Math.max(0, ...rows.map(r => r.length)); i++) headers.push(`Column ${i + 1}`);
  const included = headers.map((h, i) => actionColumn(h) ? -1 : i).filter(i => i >= 0);
  return { headers: included.map(i => headers[i]), rows: rows.map(row => included.map(i => row[i] || "")) };
}

type Props = TableHTMLAttributes<HTMLTableElement> & {
  reportTitle?: string;
  /** Pass a dataset export for paginated reports; it must use the same authorised, filtered rows. */
  reportExport?: () => ExcelReport | Promise<ExcelReport>;
  reportCanExport?: boolean;
  reportHeaders?: string[];
};

function renderedTableValues(table: HTMLTableElement) {
  const next: Record<string, Record<string, string[]>> = {};
  Array.from(table.tBodies).forEach((body, index) => {
    const values: Record<string, string[]> = {};
    Array.from(body.rows).filter(row => row.dataset.reportRow != null).sort((a,b) => a.dataset.reportRow!.localeCompare(b.dataset.reportRow!)).forEach(row => {
      values[row.dataset.reportRow!] = Array.from(row.cells).flatMap(cell => Array.from({ length: cell.colSpan }, () => cell.dataset.sortValue ?? cellText(cell)));
    });
    next[String(index)] = values;
  });
  return next;
}

export function ReportTable({ children, reportTitle, reportExport, reportCanExport = true, reportHeaders, ...props }: Props) {
  const enabled = useOpsDesign();
  const mayExport = useOpsReportExport() && reportCanExport;
  const ref = useRef<HTMLTableElement>(null);
  const [sort, setSort] = useState<ReportSort | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [renderedValues, setRenderedValues] = useState<Record<string, Record<string, string[]>>>({});
  const valuesSignature = useRef("");
  // Read rendered values for cells supplied by components (badges, count/value pairs, etc.).
  // The DOM is never reordered; React keeps ownership of rows and editable controls.
  useEffect(() => {
    if (!enabled || !sort || !ref.current) return;
    const next = renderedTableValues(ref.current);
    const signature = JSON.stringify(next);
    if (signature !== valuesSignature.current) { valuesSignature.current = signature; setRenderedValues(next); }
  });
  if (!enabled) return <table {...props}>{children}</table>;

  async function download() {
    if (!ref.current || exporting || !mayExport) return;
    setExporting(true); setError("");
    try {
      const table = ref.current;
      const section = table.closest("section,.panel,[role=dialog],main");
      const title = reportTitle || props["aria-label"] || section?.querySelector("h2,h3,h1")?.textContent || document.title || "OpsPulse report";
      await downloadReportExcel(reportExport ? await reportExport() : { title, ...tableExcelData(table), scope: "Displayed table rows only, with current filters and order. Other pages and collapsed reports are not included." });
    } catch { setError("Download failed. Retry."); }
    finally { setExporting(false); }
  }

  function header(head: Element): Element {
    const occupied: number[] = [];
    const rows = nodes(head.props.children);
    return cloneElement(head, {}, rows.map((row, rowIndex) => {
      if (!element(row) || row.type !== "tr") return row;
      let column = 0;
      return cloneElement(row, {}, nodes(row.props.children).map(cell => {
        if (!element(cell) || cell.type !== "th") return cell;
        while ((occupied[column] || 0) > rowIndex) column++;
        const index = column, span = Number(cell.props.colSpan || 1);
        for (let i = 0; i < span; i++) occupied[column + i] = rowIndex + Number(cell.props.rowSpan || 1);
        column += span;
        const label = text(cell.props.children);
        // Preserve existing server/dataset sorting, checkboxes and grouped headings.
        if (span > 1 || actionColumn(label) || hasControl(cell.props.children) || cell.props.onClick || cell.props["data-report-sort"] === "off") return cell;
        const active = sort?.column === index;
        return cloneElement(cell, { "aria-sort": active ? sort.direction === "asc" ? "ascending" : "descending" : "none" },
          <button type="button" data-report-sort-button="true" className={styles.sort} title={`Sort displayed rows by ${label}`} onClick={() => {
            if (ref.current) { const next = renderedTableValues(ref.current); valuesSignature.current = JSON.stringify(next); setRenderedValues(next); }
            setSort(s => ({ column: index, direction: s?.column === index && s.direction === "asc" ? "desc" : "asc" }));
          }}>
            {cell.props.children}<span aria-hidden="true">{active ? sort.direction === "asc" ? "↑" : "↓" : "↕"}</span>
          </button>);
      }));
    }));
  }
  const parts = nodes(children);
  if (reportHeaders?.length && !parts.some(n => element(n) && n.type === "thead")) {
    const body = parts.findIndex(n => element(n) && n.type === "tbody");
    parts.splice(body < 0 ? 0 : body, 0, <thead key="report-head"><tr>{reportHeaders.map((label, index) => <th key={index}>{label}</th>)}</tr></thead>);
  }
  const caption = parts.find(n => element(n) && n.type === "caption") as Element | undefined;
  let bodyIndex = 0;
  return <table {...props} className={[props.className, styles.compact].filter(Boolean).join(" ")} ref={ref} data-report-table="true" onClickCapture={event => {
    const target = event.target as HTMLElement;
    if (target.closest("thead") && target.closest("button,a") && !target.closest("[data-report-sort-button]")) setSort(null);
    props.onClickCapture?.(event);
  }}>
    <caption className={styles.caption}>
      {caption ? <span className={String(caption.props.className || "")} style={caption.props.style as React.CSSProperties}>{caption.props.children}</span> : null}
      {mayExport ? <span className={styles.tools}>
        {error ? <span role="alert">{error}</span> : null}
        <button type="button" disabled={exporting} onClick={() => void download()} title={reportExport ? "Download all matching records as Excel" : "Download the displayed rows as Excel. Other pages are not included."}>
          {exporting ? "Preparing…" : reportExport ? "Excel · all results" : "Excel · shown rows"}
        </button>
      </span> : null}
    </caption>
    {parts.filter(n => !element(n) || n.type !== "caption").map(node => {
      if (!element(node)) return node;
      if (node.type === "thead") return header(node);
      if (node.type === "tbody") return cloneElement(node, {}, sortReportBody(node.props.children, sort, renderedValues[String(bodyIndex++)]));
      return node;
    })}
  </table>;
}
