# OpsPulse login refinement — September 2026

The DropX and OpsPulse logos and source assets are unchanged. A light, balanced operations overview now sits beside a navy sign-in panel. A four-area schematic explains Performance, Capacity, Cash and Fleet feeding a shared action view; it contains no invented live figures or status claims.

On narrow screens, sign-in appears before the marketing overview. Android download remains at `/downloads/DropX-OpsPulse.apk`; the existing browser installation prompt is retained, with a recoverable failure message. iPhone/iPad instructions are expandable. Google submission uses the existing server action and next-path field, with disabled/loading feedback during submission.

Styles are local CSS Modules, preventing this login design from leaking into other portals. The shared OpsPulse brand gets an accessible image role without changing its appearance. The OpsPulse login's browser title now correctly identifies DropX OpsPulse.

No auth-provider configuration, permission rules, data queries, workflow logic, logo assets, service worker, app packages, or scheduled jobs are changed.

Verification:
- `node --test src/components/ops-login-panel.test.mjs src/lib/finance/portal.test.mjs`: 17 tests passed.
- Existing full `prebuild` regression suite passed.
- Desktop/mobile visual checks and axe scans; no violations after contrast adjustments.
- 320px width check: no horizontal overflow; safe external next path becomes `/`; readable escaped error alert.
- iOS details expansion and simulated browser-install rejection verified locally.
- Existing logos and login actions byte-for-byte unchanged from live baseline `072461c5cb9d00ce748ed4bc885d7b1e3a05e417`.

Real Google authentication requires a user's account and is not completed during visual QA. Local testing uses the OpsPulse host header and no production credentials.
