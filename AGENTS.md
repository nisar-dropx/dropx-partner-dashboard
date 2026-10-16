# Notes for AI coding agents

## WhatsApp Report Bot worker is published to a second repository

`workers/whatsapp-report-bot/` is the source of truth for the Report Bot worker, but Render deploys it from the
private repository **DROPX-LOGISTICS/Report-bot-worker** (https://github.com/DROPX-LOGISTICS/Report-bot-worker).

Whenever you change anything in `workers/whatsapp-report-bot/`:

1. Make the change here, run its tests (`npm test` in that folder), and commit it in this repository.
2. Publish it: `pnpm sync:report-bot-worker` (preview with `pnpm sync:report-bot-worker -- --dry-run`).
   This copies the tracked worker files to Report-bot-worker, removes files deleted here, commits with a
   reference to this repository's commit, and pushes. Render then redeploys the worker automatically.
3. Never edit Report-bot-worker directly, except its deploy-only files (`README.md`, `render.yaml`,
   `railway.json`, `AGENTS.md`, `CLAUDE.md`), which the sync leaves alone.

If the worker's HTTP contract changes (endpoints, payloads, auth), update the portal side in the same change:
`src/lib/report-bot/worker-client.ts`, `src/app/api/report-bot/worker/*`, and `src/app/api/report-bot/session`.
