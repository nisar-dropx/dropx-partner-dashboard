# OpsPulse client demo

Separate public entries:

- Last Mile: `https://ops.dropxlogistics.com/demo/last-mile`
- Dark Store: `https://ops.dropxlogistics.com/demo/dark-store`

Each page receives only its own business catalogue. There is no workspace switch or combined chooser. Legacy workspace-qualified links redirect to the corresponding dedicated link; bare `/demo` has no chooser.

This is an interactive synthetic product walkthrough, not a production user account or a trial tenant. No sign-in is required. It is deliberately absent from normal navigation and is excluded from search indexing.

## Isolation

Only GET/HEAD of the exact `/demo`, `/demo/last-mile` and `/demo/dark-store` paths on the OpsPulse host (or local/selected OpsPulse preview hosts) bypass authentication. No demo cookie or query parameter grants access to any other route. The page has no database/client API calls, live action invocations, live documents, user records, credentials or messaging connections. Its CSP prohibits network connections, frames and form submissions. The normal PWA does not register on this surface.

All records and documents are fictional. Changes live in sessionStorage for this browser tab. Reset clears the current workspace and its sample activity state. No changes affect another visitor or any live system. Payment settlement, approvals, recovery, messages and integrations are simulations. Exported files carry sample labels.

## Coverage and maintenance

The menu hierarchy comes from `opsNavCatalogForMode`, the same catalogue used by the application. `src/lib/ops-pulse/demo/catalog.ts` supplies explicit fixtures for each destination. `pnpm test:ops-client-demo` runs before builds and fails if a new menu lacks sample data, has duplicate IDs or malformed rows. Add a suitable fixture when adding a real menu.

Payment screens share sample requests and state. Shift operations, store operations, shift report and store report reuse their production components, checklist templates and validation through an in-memory runtime adapter. The actual navigation and app shell are shared too. Live pages use their existing router, API and actions by default; only the demo installs the adapter. Sample proof replaces camera, location and uploads. WhatsApp sharing never sends a message in the demo. Audits demonstrate evidence, response and verification. Other screens provide populated records, search/filter/sort, sample exports and appropriate inspection/edit actions. Remaining screens still use the earlier generic populated demo views; full production component parity is not complete. Do not describe every menu as identical to the live application.

## Verification

Coverage test checks current menus, exact host/path/method boundaries, workspace-specific fictional locations, shared sample record identities, CSV escaping and network isolation. Typecheck the changed client/server modules. Browser QA covers the two workspaces, mobile/tablet layouts, a checklist-to-report journey, payment transitions, document preview and reset. Verify the live `/demo` route is accessible without authentication and the response retains its isolation headers after deployment.
