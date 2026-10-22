#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";

const CATCHUP_ROUTE = "/api/cron/attendance-reconciliation";
const AUDIT_ROUTE = "/api/cron/attendance-catchup-audit";
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXPECTED_SAMPLE_IDS = ["DF1088", "DROPX1143", "KGQC1201", "PEUA8096"];
const COMPLETION_EVENTS = new Set([
  "attendance_reconciliation_completed",
  "attendance_reconciliation_completed_with_retries"
]);
const TRANSIENT_WARNING_EVENTS = new Set([
  "attendance_reconciliation_company_lease_contended",
  "attendance_reconciliation_stale_mapping_skipped",
  "attendance_reconciliation_raw_activity_filter_unavailable",
  "attendance_reconciliation_lease_release_failed",
  "attendance_reconciliation_validation_lease_release_failed"
]);

function usage() {
  return `Usage:
  node scripts/run-attendance-catchup.mjs [options]

By default this only validates and prints the local execution plan. It cannot
write production unless --execute is supplied. The execution mode uses Vercel's
authenticated cron runner; CRON_SECRET is never read or printed locally.

Optimized catch-up cursor routes are temporary vercel.json registrations. They are
not kept deployed after the historical repair finishes. Re-add contiguous
mode=catchup cursor crons (schedule 0 0 1 1 *) before --execute.

Options:
  --execute                 Trigger the deployed production cron jobs.
  --from YYYY-MM-DD         First IST attendance date (default: 2026-09-01).
  --to YYYY-MM-DD           Last IST attendance date (default: 2026-10-11).
  --limit N                 Windows per registered cursor (default: 16).
  --start-cursor N          Resume the first pass at a verified cursor (default: 0).
  --expected-snapshot HASH  Required ownership snapshot when resuming after 0.
  --expected-total N        Required mapping count when resuming after 0.
  --max-passes N            Audit-driven full passes (default: 3).
  --max-retries N           Attempts per cursor (default: 8).
  --max-snapshot-restarts N Full-pass restarts after snapshot drift (default: 3).
  --poll-ms N               Delay between log polls (default: 5000).
  --wait-ms N               Maximum wait for one invocation (default: 330000).
  --backoff-ms N            Initial retry delay (default: 15000).
  --help                    Show this help.
`;
}

function parseWholeNumber(value, name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!/^\d+$/.test(String(value ?? ""))) {
    throw new Error(`${name} must be a whole number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseOptions(argv) {
  const values = new Map();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") return { help: true };
    if (item === "--execute") {
      execute = true;
      continue;
    }
    if (!item.startsWith("--")) throw new Error(`Unknown argument: ${item}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${item} requires a value.`);
    }
    values.set(item.slice(2), value);
    index += 1;
  }

  const from = values.get("from") ?? "2026-09-01";
  const to = values.get("to") ?? "2026-10-11";
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) {
    throw new Error("--from and --to must be a valid ascending YYYY-MM-DD range.");
  }
  const known = new Set([
    "from",
    "to",
    "limit",
    "start-cursor",
    "expected-snapshot",
    "expected-total",
    "max-passes",
    "max-retries",
    "max-snapshot-restarts",
    "poll-ms",
    "wait-ms",
    "backoff-ms"
  ]);
  for (const key of values.keys()) {
    if (!known.has(key)) throw new Error(`Unknown option: --${key}`);
  }

  const limit = parseWholeNumber(values.get("limit") ?? "16", "--limit", { maximum: 50 });
  const startCursor = parseWholeNumber(values.get("start-cursor") ?? "0", "--start-cursor", {
    minimum: 0
  });
  const expectedSnapshotToken = String(values.get("expected-snapshot") ?? "").trim().toLowerCase();
  const expectedTotalMappings = values.has("expected-total")
    ? parseWholeNumber(values.get("expected-total"), "--expected-total")
    : null;
  if (startCursor > 0) {
    if (!SHA256.test(expectedSnapshotToken) || expectedTotalMappings === null) {
      throw new Error(
        "--start-cursor after 0 requires --expected-snapshot and --expected-total from the verified prior batch."
      );
    }
    if (startCursor % limit !== 0) {
      throw new Error(`--start-cursor must be aligned to --limit (${limit}).`);
    }
    if (startCursor >= expectedTotalMappings) {
      throw new Error("--start-cursor must be less than --expected-total.");
    }
  } else if (expectedSnapshotToken || expectedTotalMappings !== null) {
    throw new Error("Snapshot resume guards can only be supplied with --start-cursor after 0.");
  }

  return {
    backoffMs: parseWholeNumber(values.get("backoff-ms") ?? "15000", "--backoff-ms", { maximum: 300_000 }),
    execute,
    expectedSnapshotToken: expectedSnapshotToken || null,
    expectedTotalMappings,
    from,
    help: false,
    limit,
    maxPasses: parseWholeNumber(values.get("max-passes") ?? "3", "--max-passes", { maximum: 10 }),
    maxRetries: parseWholeNumber(values.get("max-retries") ?? "8", "--max-retries", { maximum: 20 }),
    maxSnapshotRestarts: parseWholeNumber(
      values.get("max-snapshot-restarts") ?? "3",
      "--max-snapshot-restarts",
      { maximum: 10 }
    ),
    pollMs: parseWholeNumber(values.get("poll-ms") ?? "5000", "--poll-ms", { maximum: 60_000 }),
    startCursor,
    to,
    waitMs: parseWholeNumber(values.get("wait-ms") ?? "330000", "--wait-ms", { maximum: 600_000 })
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildCatchupPath({ cursor, from, limit, to }) {
  const parameters = new URLSearchParams();
  parameters.set("mode", "catchup");
  parameters.set("from", from);
  parameters.set("to", to);
  parameters.set("raw_activity_only", "true");
  parameters.set("limit", String(limit));
  parameters.set("cursor", String(cursor));
  return `${CATCHUP_ROUTE}?${parameters.toString()}`;
}

function parseJsonObject(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstJsonObject(value) {
  const lines = String(value ?? "").split(/\r?\n/);
  for (let start = 0; start < lines.length; start += 1) {
    if (!lines[start].trim().startsWith("{")) continue;
    for (let end = lines.length; end > start; end -= 1) {
      const parsed = parseJsonObject(lines.slice(start, end).join("\n"));
      if (parsed) return parsed;
    }
  }
  return null;
}

async function runVercel(arguments_, { timeoutMs = 120_000 } = {}) {
  const cliPath = fileURLToPath(new URL("../node_modules/vercel/dist/vc.js", import.meta.url));
  return await new Promise((resolve, reject) => {
    // Invoke the JavaScript entrypoint directly. This keeps every cron path a
    // literal argv item; in particular, its '&' query separators can never be
    // interpreted by cmd.exe or another shell.
    const child = spawn(process.execPath, [cliPath, ...arguments_], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Vercel CLI timed out while running: ${arguments_.slice(0, 2).join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const details = `${stdout}\n${stderr}`.trim().split(/\r?\n/).slice(-12).join("\n");
        reject(new Error(`Vercel CLI exited with ${code}.\n${details}`));
        return;
      }
      resolve({ stderr, stdout });
    });
  });
}

function validateCatchupCron(path, options) {
  const parsed = new URL(path, "https://cron.invalid");
  if (parsed.pathname !== CATCHUP_ROUTE) return null;
  if (
    parsed.searchParams.get("mode") !== "catchup"
    || parsed.searchParams.get("from") !== options.from
    || parsed.searchParams.get("to") !== options.to
    || parsed.searchParams.get("raw_activity_only") !== "true"
    || parsed.searchParams.get("limit") !== String(options.limit)
  ) return null;
  const cursor = parsed.searchParams.get("cursor");
  if (!/^\d+$/.test(cursor ?? "")) return null;
  return Number(cursor);
}

async function loadLocalInventory(options) {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const crons = Array.isArray(config.crons) ? config.crons : [];
  const paths = new Set(crons.map((cron) => cron?.path).filter((path) => typeof path === "string"));
  const cursors = crons
    .map((cron) => validateCatchupCron(String(cron?.path ?? ""), options))
    .filter((cursor) => cursor !== null)
    .sort((left, right) => left - right);
  if (!paths.has(AUDIT_ROUTE)) throw new Error(`Local vercel.json is missing ${AUDIT_ROUTE}.`);
  if (cursors.length) {
    if (cursors[0] !== 0) throw new Error("Local vercel.json is missing the optimized cursor 0 cron.");
    for (let index = 1; index < cursors.length; index += 1) {
      if (cursors[index] !== cursors[index - 1] + options.limit) {
        throw new Error(`Local optimized cron cursors are not contiguous at ${cursors[index - 1]} -> ${cursors[index]}.`);
      }
    }
  }
  return { cursors, paths };
}

function parseRemoteInventory(stdout, options) {
  const payload = firstJsonObject(stdout);
  const crons = Array.isArray(payload?.crons) ? payload.crons : null;
  if (!crons) throw new Error("Unable to parse `vercel crons list --format json` output.");
  const paths = new Set(crons.map((cron) => cron?.path).filter((path) => typeof path === "string"));
  const optimized = crons.filter((cron) => validateCatchupCron(String(cron?.path ?? ""), options) !== null);
  if (!paths.has(AUDIT_ROUTE)) throw new Error(`Deployed cron inventory is missing ${AUDIT_ROUTE}.`);
  if (!optimized.length) throw new Error("Deployed cron inventory has no matching optimized catch-up paths.");
  const hosts = new Set(optimized.map((cron) => String(cron.host ?? "").trim()).filter(Boolean));
  if (hosts.size !== 1) throw new Error("Optimized catch-up cron paths do not resolve to one deployment host.");
  return { host: Array.from(hosts)[0], paths };
}

async function loadRemoteInventory(options) {
  const result = await runVercel(["crons", "list", "--format", "json", "--no-color"]);
  return parseRemoteInventory(result.stdout, options);
}

function validateCoverage({ inventory, options, totalMappings }) {
  for (let cursor = 0; cursor < Math.max(totalMappings, 1); cursor += options.limit) {
    const path = buildCatchupPath({ ...options, cursor });
    if (!inventory.paths.has(path)) {
      throw new Error(`Cron inventory cannot cover ${totalMappings} windows; missing exact path ${path}.`);
    }
  }
}

async function triggerCron(path) {
  const result = await runVercel(["crons", "run", path, "--no-color"]);
  const combined = `${result.stdout}\n${result.stderr}`;
  const match = combined.match(/Invocation time:\s*([^\r\n]+)/i);
  const invocationAt = match ? new Date(match[1].trim()) : null;
  if (!invocationAt || Number.isNaN(invocationAt.getTime())) {
    throw new Error("Vercel accepted the cron trigger but did not return a valid invocation time.");
  }
  return invocationAt;
}

function parseLogEntries(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => parseJsonObject(line))
    .filter(Boolean);
}

function nestedEvents(entry) {
  const counts = new Map();
  for (const log of Array.isArray(entry?.logs) ? entry.logs : []) {
    const payload = parseJsonObject(log?.message);
    if (typeof payload?.event !== "string") continue;
    counts.set(payload.event, (counts.get(payload.event) ?? 0) + 1);
  }
  return counts;
}

async function pollForEvent({ host, invocationAt, matches, options, query }) {
  const invocationMs = invocationAt.getTime();
  const startedAt = Date.now();
  const since = new Date(invocationMs - 2_000).toISOString();
  while (Date.now() - startedAt < options.waitMs) {
    const result = await runVercel([
      "logs",
      host,
      "--since",
      since,
      "--json",
      "--limit",
      "100",
      "--no-branch",
      "--no-color",
      "--query",
      query
    ]);
    const candidates = parseLogEntries(result.stdout)
      .filter((entry) => Number(entry.timestamp) >= invocationMs)
      .sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
    for (const entry of candidates) {
      const payload = parseJsonObject(entry.message);
      if (payload && matches(payload, entry)) return { entry, payload };
    }
    await delay(options.pollMs);
  }
  throw new Error(`Timed out after ${options.waitMs} ms waiting for ${query} on ${host}.`);
}

function assertNonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is not a non-negative integer.`);
}

function validateResult(result, { cursor, options }) {
  for (const [name, value] of [
    ["attempted", result.attempted],
    ["completed", result.completed],
    ["punchesReconciled", result.punchesReconciled],
    ["skipped", result.skipped],
    ["startCursor", result.startCursor],
    ["totalMappings", result.totalMappings]
  ]) assertNonnegativeInteger(value, name);
  if (!Array.isArray(result.failures)) throw new Error("failures is not an array.");
  if (!SHA256.test(String(result.snapshotToken ?? ""))) throw new Error("snapshotToken is invalid.");
  if (result.fromDate !== options.from || result.toDate !== options.to) {
    throw new Error(`Unexpected reconciliation window ${result.fromDate} through ${result.toDate}.`);
  }
  const startCursor = Math.min(cursor, result.totalMappings);
  if (result.startCursor !== startCursor) {
    throw new Error(`Expected startCursor ${startCursor}, received ${result.startCursor}.`);
  }
  const expectedAttempted = Math.min(options.limit, Math.max(result.totalMappings - cursor, 0));
  const expectedNext = cursor + expectedAttempted < result.totalMappings
    ? cursor + expectedAttempted
    : null;
  const accounted = result.completed + result.skipped + result.failures.length;
  return {
    accounted,
    expectedAttempted,
    expectedNext,
    structurallyComplete:
      result.attempted === expectedAttempted
      && accounted === result.attempted
      && result.nextCursor === expectedNext
  };
}

function warningSummary(entry) {
  const events = nestedEvents(entry);
  return Array.from(events.entries())
    .filter(([event]) => TRANSIENT_WARNING_EVENTS.has(event))
    .map(([event, count]) => ({ count, event }));
}

async function runCursor({ baseline, cursor, inventory, options }) {
  const path = buildCatchupPath({ ...options, cursor });
  if (!inventory.paths.has(path)) throw new Error(`Deployed cron path is missing: ${path}`);
  for (let attempt = 1; attempt <= options.maxRetries; attempt += 1) {
    const invocationAt = await triggerCron(path);
    const completion = await pollForEvent({
      host: inventory.host,
      invocationAt,
      matches: (payload) =>
        COMPLETION_EVENTS.has(payload.event)
        && payload.fromDate === options.from
        && payload.toDate === options.to,
      options,
      query: "attendance_reconciliation_completed"
    });
    const result = completion.payload;
    const validation = validateResult(result, { cursor, options });
    const warnings = warningSummary(completion.entry);
    const summary = {
      attempt,
      attempted: result.attempted,
      completed: result.completed,
      cursor,
      failures: result.failures.length,
      nextCursor: result.nextCursor,
      punchesReconciled: result.punchesReconciled,
      skipped: result.skipped,
      totalMappings: result.totalMappings,
      warnings
    };
    console.log(JSON.stringify({ event: "attendance_catchup_batch", ...summary }));

    if (
      baseline
      && (result.snapshotToken !== baseline.snapshotToken || result.totalMappings !== baseline.totalMappings)
    ) {
      return { kind: "snapshot-changed", result };
    }
    if (result.failures.length === 0 && warnings.length === 0 && validation.structurallyComplete) {
      return { kind: "complete", result };
    }
    if (attempt === options.maxRetries) {
      throw new Error(
        `Cursor ${cursor} remained partial or transient after ${options.maxRetries} attempts: ${JSON.stringify(summary)}`
      );
    }
    const backoff = Math.min(options.backoffMs * (2 ** (attempt - 1)), 60_000);
    await delay(backoff);
  }
  throw new Error(`Cursor ${cursor} exhausted retries.`);
}

async function runFullPass({ inventory, options, pass }) {
  for (let restart = 0; restart <= options.maxSnapshotRestarts; restart += 1) {
    // A non-zero cursor is accepted only for the first attempt of the first
    // pass and only with the exact token/count recorded by the preceding
    // verified batch. Any ownership drift falls back to a complete pass.
    const useResume = pass === 1 && restart === 0 && options.startCursor > 0;
    let baseline = useResume
      ? {
          snapshotToken: options.expectedSnapshotToken,
          totalMappings: options.expectedTotalMappings
        }
      : null;
    let cursor = useResume ? options.startCursor : 0;
    if (useResume) validateCoverage({ inventory, options, totalMappings: baseline.totalMappings });
    while (true) {
      const outcome = await runCursor({ baseline, cursor, inventory, options });
      if (outcome.kind === "snapshot-changed") {
        console.warn(JSON.stringify({
          event: "attendance_catchup_snapshot_restart",
          pass,
          previousSnapshotToken: baseline?.snapshotToken ?? null,
          restart: restart + 1,
          totalMappings: outcome.result.totalMappings
        }));
        break;
      }
      const result = outcome.result;
      if (useResume && cursor === options.startCursor) {
        console.log(JSON.stringify({
          event: "attendance_catchup_resume_verified",
          pass,
          snapshotToken: result.snapshotToken,
          startCursor: cursor,
          totalMappings: result.totalMappings
        }));
      }
      if (!baseline) {
        baseline = {
          snapshotToken: result.snapshotToken,
          totalMappings: result.totalMappings
        };
        validateCoverage({ inventory, options, totalMappings: result.totalMappings });
      }
      if (result.nextCursor === null) {
        return baseline;
      }
      cursor = result.nextCursor;
    }
    if (restart === options.maxSnapshotRestarts) {
      throw new Error(`Attendance snapshot changed more than ${options.maxSnapshotRestarts} times.`);
    }
    await delay(options.backoffMs);
  }
  throw new Error("Attendance pass did not finish.");
}

function validateAudit(audit, options) {
  if (
    audit?.window?.from !== options.from
    || audit?.window?.to !== options.to
    || audit?.window?.timeZone !== "Asia/Kolkata"
  ) throw new Error("Audit returned an unexpected attendance window.");
  const global = audit?.global;
  const names = [
    "ambiguousUnresolvedCount",
    "capturedRawCount",
    "incompleteMappingUnresolvedCount",
    "rawTimelogCount",
    "safeMappedUnresolvedCount",
    "unmappedUnresolvedCount",
    "unresolvedRawCount"
  ];
  for (const name of names) assertNonnegativeInteger(global?.[name], `audit.global.${name}`);
  if (global.capturedRawCount + global.unresolvedRawCount !== global.rawTimelogCount) {
    throw new Error("Audit raw-event totals do not balance.");
  }
  if (
    global.safeMappedUnresolvedCount
      + global.ambiguousUnresolvedCount
      + global.incompleteMappingUnresolvedCount
      + global.unmappedUnresolvedCount
    !== global.unresolvedRawCount
  ) throw new Error("Audit unresolved classifications do not balance.");
  if (!Array.isArray(audit.samples)) throw new Error("Audit samples are missing.");
  const sampleIds = audit.samples.map((sample) => String(sample.dropxId ?? "").toUpperCase()).sort();
  if (new Set(sampleIds).size !== EXPECTED_SAMPLE_IDS.length
    || JSON.stringify(sampleIds) !== JSON.stringify(EXPECTED_SAMPLE_IDS)) {
    throw new Error(`Audit did not return the exact required samples: ${EXPECTED_SAMPLE_IDS.join(", ")}.`);
  }
  for (const sample of audit.samples) {
    assertNonnegativeInteger(sample.rawTimelogCount, `audit sample ${sample.dropxId} rawTimelogCount`);
    assertNonnegativeInteger(sample.uncapturedRawCount, `audit sample ${sample.dropxId} uncapturedRawCount`);
    if (sample.uncapturedRawCount > sample.rawTimelogCount) {
      throw new Error(`Audit sample ${sample.dropxId} has impossible counts.`);
    }
  }
}

function auditSummary(audit) {
  return {
    global: audit.global,
    samples: audit.samples.map((sample) => ({
      dropxId: sample.dropxId,
      profileFound: sample.profileFound,
      profileStatuses: sample.profileStatuses,
      rawTimelogCount: sample.rawTimelogCount,
      uncapturedRawCount: sample.uncapturedRawCount
    })),
    window: audit.window
  };
}

function auditIsComplete(audit) {
  return audit.global.safeMappedUnresolvedCount === 0
    && audit.samples.every((sample) => sample.profileFound && sample.uncapturedRawCount === 0);
}

async function runAudit({ inventory, options, phase }) {
  const invocationAt = await triggerCron(AUDIT_ROUTE);
  const completion = await pollForEvent({
    host: inventory.host,
    invocationAt,
    matches: (payload) => payload.event === "attendance_catchup_audit_completed",
    options,
    query: "attendance_catchup_audit_completed"
  });
  const { event: _event, durationMs: _durationMs, ...audit } = completion.payload;
  validateAudit(audit, options);
  console.log(JSON.stringify({ event: "attendance_catchup_audit", phase, ...auditSummary(audit) }));
  return audit;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const local = await loadLocalInventory(options);
  console.log(JSON.stringify({
    event: "attendance_catchup_plan",
    execute: options.execute,
    expectedSnapshotToken: options.expectedSnapshotToken,
    expectedTotalMappings: options.expectedTotalMappings,
    firstCursor: local.cursors[0] ?? null,
    from: options.from,
    lastCursor: local.cursors.at(-1) ?? null,
    limit: options.limit,
    registeredCursorCount: local.cursors.length,
    startCursor: options.startCursor,
    to: options.to
  }));
  if (!options.execute) {
    if (!local.cursors.length) {
      console.log(
        "Dry run only. No optimized catch-up cursor crons are registered in vercel.json; "
        + "re-add contiguous mode=catchup cursor routes before --execute."
      );
      return;
    }
    console.log("Dry run only. Re-run with --execute after the optimized deployment is live and verified.");
    return;
  }
  if (!local.cursors.length) {
    throw new Error(
      "vercel.json has no optimized catch-up cursor crons. Re-add contiguous "
      + "mode=catchup routes (schedule 0 0 1 1 *) before --execute."
    );
  }

  const inventory = await loadRemoteInventory(options);
  for (const path of local.paths) {
    if ((path === AUDIT_ROUTE || validateCatchupCron(path, options) !== null) && !inventory.paths.has(path)) {
      throw new Error(`Deployed cron inventory does not match local vercel.json; missing ${path}.`);
    }
  }
  console.log(JSON.stringify({ event: "attendance_catchup_remote_verified", host: inventory.host }));

  const before = await runAudit({ inventory, options, phase: "before" });
  if (auditIsComplete(before)) {
    console.log("attendance-catchup-already-complete");
    return;
  }

  for (let pass = 1; pass <= options.maxPasses; pass += 1) {
    const baseline = await runFullPass({ inventory, options, pass });
    console.log(JSON.stringify({ event: "attendance_catchup_pass_complete", pass, ...baseline }));
    const after = await runAudit({ inventory, options, phase: `after-pass-${pass}` });
    if (auditIsComplete(after)) {
      // Today's source can still be ingesting while the historical pass runs.
      // Require a second point-in-time proof after a short quiet interval so
      // a newly arrived mapped event cannot make a single zero audit look
      // durably complete.
      await delay(Math.max(options.pollMs * 2, 15_000));
      const confirmation = await runAudit({
        inventory,
        options,
        phase: `confirmation-after-pass-${pass}`
      });
      if (!auditIsComplete(confirmation)) {
        if (pass < options.maxPasses) {
          await delay(options.backoffMs);
          continue;
        }
        break;
      }
      const finalInventory = await loadRemoteInventory(options);
      if (finalInventory.host !== inventory.host) {
        throw new Error(`Production deployment changed during catch-up: ${inventory.host} -> ${finalInventory.host}.`);
      }
      console.log("attendance-catchup-complete");
      return;
    }
    if (pass < options.maxPasses) await delay(options.backoffMs);
  }
  throw new Error(
    `Attendance audit did not reach zero safe/sample gaps after ${options.maxPasses} full passes. `
    + "Do not remove the temporary audit until the remaining classifications are investigated."
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
