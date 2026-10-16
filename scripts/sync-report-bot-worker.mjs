#!/usr/bin/env node
// Publishes workers/whatsapp-report-bot to DROPX-LOGISTICS/Report-bot-worker, the repository
// Render deploys the Report Bot worker from. The dashboard folder is the source of truth;
// run this after every change to it:  pnpm sync:report-bot-worker  (add --dry-run to preview).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REMOTE = "https://github.com/DROPX-LOGISTICS/Report-bot-worker.git";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "workers", "whatsapp-report-bot");
// Files that only exist in (or are tailored for) the deploy repository; never copied or deleted.
const DEPLOY_ONLY = new Set([".git", "README.md", "render.yaml", "railway.json", "AGENTS.md", "CLAUDE.md"]);
const dryRun = process.argv.includes("--dry-run");
const skipTests = process.argv.includes("--skip-tests");

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: options.quiet ? "pipe" : ["ignore", "pipe", "inherit"], shell: process.platform === "win32" && command === "npm" }).trim();
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

// 1. Only publish committed, tested code, so the deploy repo always matches a dashboard commit.
const pending = run("git", ["status", "--porcelain", "--", "workers/whatsapp-report-bot"], repoRoot);
if (pending && !dryRun) fail("workers/whatsapp-report-bot has uncommitted changes. Commit them in the dashboard repo first, then sync.");
const sourceCommit = run("git", ["rev-parse", "--short", "HEAD"], repoRoot);
// Tracked files only, so node_modules, local data and .env never leave this machine.
const files = run("git", ["ls-files", "--", "workers/whatsapp-report-bot"], repoRoot)
  .split("\n").filter(Boolean)
  .map((file) => path.relative(source, path.join(repoRoot, file)))
  .filter((file) => !DEPLOY_ONLY.has(file.split(path.sep)[0]));
if (!files.length) fail("No tracked worker files found.");

if (!skipTests) {
  console.log("Running worker tests…");
  if (!existsSync(path.join(source, "node_modules"))) run("npm", ["ci", "--no-audit", "--no-fund"], source);
  try {
    run("npm", ["test"], source, { quiet: true });
  } catch (error) {
    fail(`Worker tests failed; nothing was published.\n${error.stdout ?? ""}`);
  }
}

// 2. Fresh clone of the deploy repository, so a stale local checkout can't publish old files.
const target = mkdtempSync(path.join(os.tmpdir(), "report-bot-worker-"));
try {
  run("git", ["clone", "--quiet", REMOTE, target], repoRoot);

  // 3. Mirror: remove files deleted from the source, then copy every tracked source file.
  const wanted = new Set(files.map((file) => file.split(path.sep)[0]));
  for (const entry of readdirSync(target)) {
    if (!DEPLOY_ONLY.has(entry) && !wanted.has(entry)) rmSync(path.join(target, entry), { recursive: true, force: true });
  }
  for (const file of files) cpSync(path.join(source, file), path.join(target, file));

  run("git", ["add", "-A"], target);
  const changes = run("git", ["status", "--porcelain"], target);
  if (!changes) {
    console.log(`✓ Report-bot-worker already matches dashboard ${sourceCommit}. Nothing to publish.`);
    process.exit(0);
  }
  console.log(`Changes to publish:\n${changes}`);
  if (dryRun) {
    console.log("\nDry run: nothing was committed or pushed.");
    process.exit(0);
  }
  const subject = run("git", ["log", "-1", "--format=%s"], repoRoot);
  run("git", ["commit", "--quiet", "-m", `Sync worker from dropx-partner-dashboard ${sourceCommit}`, "-m", `Source commit: ${subject}`], target);
  run("git", ["push", "--quiet", "origin", "HEAD"], target);
  console.log(`✓ Published dashboard ${sourceCommit} to DROPX-LOGISTICS/Report-bot-worker. Render redeploys automatically.`);
} catch (error) {
  fail(`Sync failed: ${error.message}`);
} finally {
  rmSync(target, { recursive: true, force: true });
}
