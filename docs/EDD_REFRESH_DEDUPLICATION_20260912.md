# EDD refresh reuse — 12 September 2026

The durable review collector now reads the worker's current cached snapshot
before asking Amazon to collect the same feed again. These are authenticated,
no-store worker reads with a five-second budget, not browser/CDN caching.

Reuse requires the exact station, a valid source timestamp from today's IST
date no older than 15 minutes, and the correct stock day or outcome window.
Missing, stale, malformed, future, wrong-station and wrong-day cache responses
fall back to a real upstream refresh. Cache-read failures also fall back.

The stored source timestamp stays unchanged. The completion RPC schedules the
next job at source time plus 15 minutes (minimum 30 seconds from acknowledgement),
not acknowledgement time plus 15 minutes. This prevents repeatedly reading a
cached result from postponing its real refresh. Owner tokens, expired leases,
retained last successes, two global lanes and persistent retry backoff remain.

The cron response includes reusedSnapshots so adopted observations can be
distinguished from new upstream pulls. SESSION_UNAVAILABLE is treated as shared
login busy instead of rapidly consuming more locations during login recovery.

Deploy the source-clock migration before this client. Tests:

- node scripts/verify-review-source-queue.mjs
- EDD_TEST_PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js node scripts/verify-review-source-queue-sql.mjs
- TypeScript check and the full production build.

This reduces redundant requests. It does not promise upstream availability,
invent historical checkpoints, or turn unverified zero-pending into clearance.
