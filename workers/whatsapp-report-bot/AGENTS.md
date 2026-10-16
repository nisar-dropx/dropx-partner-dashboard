# This folder is published to DROPX-LOGISTICS/Report-bot-worker

Render deploys this worker from https://github.com/DROPX-LOGISTICS/Report-bot-worker, not from here.
After changing anything in this folder:

1. `npm test` here, then commit in the dashboard repository.
2. From the dashboard repository root: `pnpm sync:report-bot-worker`.

Skipping step 2 leaves production running the old worker. Don't edit Report-bot-worker by hand.
