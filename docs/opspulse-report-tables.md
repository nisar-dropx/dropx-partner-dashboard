# OpsPulse table controls

Use `ReportTable` instead of native `table` for application tables. It preserves the native table in other portals and adds compact header sorting and an Excel download in OpsPulse. Existing server/dataset sort controls are preserved; action and selection columns are not sorted.

The shell grants the new exports only with `ops_reports` access outside read-only preview. A table with additional export restrictions must also pass `reportCanExport`. Export never loads additional records or broadens the current location scope.

## Export scope

- `Excel · shown rows`: exports the currently rendered table records, including applied filtering and display order. It does **not** fetch other pages. The workbook's Export details sheet records this limitation.
- `reportExport`: use a callback over the complete authorised, filtered dataset for paginated reports. The button becomes `Excel · all results`. This is implemented in Redispute Tracking; sorting there also runs before paging.
- Keep existing full-report exports alongside the table control. Do not label a page-only export as a complete report.
- IDs/reference numbers must remain text; amounts are numeric where unambiguous. Formula-looking user text is stored as an Excel string. Headers and filters are included.

## Sorting and row groups

Wrap each primary row and its expanded details in a keyed Fragment. Row spans and adjacent colspan detail rows are also grouped. Totals remain anchored. Use `data-sort-value` on a cell for an unambiguous raw value (ISO date, numeric amount) when the cell displays multiple pieces of information. Use `data-export-value` when the visible content is abbreviated.

Tables use React reconciliation to reorder rows, not DOM manipulation. Existing controlled and uncontrolled editing state stays with its record. Sorting of shared table controls is limited to displayed rows; use dataset-level sorting before pagination where a complete-report sort is needed.

## Redispute Tracking

Station, Cluster / AOM, Region and Station update filters use the authorised loss station scope. Workflow chips remain independent: active, awaiting station, awaiting review, ticket follow-up and closed/disabled. Counts and value follow filters. Header sorting and Excel use every matching result, before pagination. Exports include shipment value, separate station/ownership fields, reason, description, Cloak ticket ID, evidence URLs, vendor ticket, follow-up and update details. No workflow/approval permissions or deduction behaviour changed.
