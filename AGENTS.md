
## Data-dependent filters across DropX

For every list, register, queue, dashboard and report in People, OpsPulse, Finance,
Recruit/HR, Workforce and Fleet, each filter must show options present in the
current permission-scoped dataset after all OTHER active filters are applied.
Multi-select values are OR within one dimension and AND between dimensions.
Preserve selected zero-match values so users can remove them; never silently
clear a selection or broaden the query. Date, search and permission context apply
before deriving available choices. Do not use the visible pagination page as the
source of available options. Record creation/edit controls and report-format,
sort-order or page-size controls are not data filters.

Do not add record counts to filter labels outside Recruit. Reuse complete data
already loaded, or return compact server-side distinct combinations. Never fetch
full personal/financial records merely to populate filters, issue a query per
option, or bypass authorization. Memoize local derivation and cancel stale search
requests. Verify cross-filter updates, empty results, paging, access scope and
performance before calling a menu complete. A rollout to one menu/product does
not complete the platform-wide rule.
