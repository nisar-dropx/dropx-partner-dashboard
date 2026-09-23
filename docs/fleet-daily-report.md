# Daily fleet kilometres and mileage

Open Fleet → Report → Daily km & mileage. The existing fuel reports remain under the same Report submenu.

The report shows a row per active vehicle per IST calendar day, with historical rows for inactive vehicles where data exists. It supports up to 93 days per query, vehicle/station/model search, station and vehicle selection, fuel type and data-status filters, numeric/date sorting, 25/50/100-row pagination, expandable source details, and CSV export of all filtered rows in the displayed sort order.

Distance comes from `fleet_daily_km`. Multiple distance sources for one vehicle-day are alternatives, never summed. A valid manual distance takes precedence; otherwise the newest valid record is selected. GPS records with fewer than two valid points are unavailable, not zero. Complete saved records are paginated from Supabase, without the old summary endpoint's 1,000-fuel-row or 5,000-distance-row limits. Station labels and authorization reflect current vehicle allocation.

Fuel is joined by stored `transaction_date`, not the UTC date of its timestamp. Daily fuel quantities and amounts are summed. Estimated km/L uses the day's recorded kilometres divided by that day's purchased fuel, for petrol/diesel vehicles only. It is not measured consumption or a full-tank efficiency calculation. CNG/EV consumption units are not available in this feed. Missing records and unavailable ratios remain blank in CSV and show an em dash on screen. Summary mileage uses only rows with both distance and positive compatible fuel quantity.

Refresh GPS processes the currently filtered vehicle-days, for up to seven days at a time within the last 31 days. Batches contain at most 12 vehicle-days with three concurrent requests and a 20-second provider timeout. No-data responses do not overwrite prior valid distance. Saved results are retained if a user stops a refresh. The process runs on demand; no new recurring job is installed.

Both API routes enforce Fleet Report (or legacy Fleet) access, company scope and location scope before returning data or contacting the provider. Refresh validates every vehicle against that scope, disallows user-preview writes and rejects cross-origin requests. GPS writes match company and row ID and use an optimistic timestamp guard; the legacy unique key omits company_id and is not used for cross-company upserts. No schema changes are required.

Validation: `node scripts/verify-fleet-daily-report.mjs` (also part of prebuild), TypeScript, browser filter/sort/details/mobile checks, downloaded CSV comparison, and live provider probe. Refresh and live API verification are recorded in the release handoff.

GPS quality: segments implying more than 160 km/h (or movement with invalid time gaps) are flagged. If their distance exceeds the larger of 1 km or 5% of the raw total, the day is marked GPS needs review and excluded from this report’s distance/mileage totals. Raw distance and rejected-segment count are retained in existing quality columns for review. No automatic corrected distance is invented.
