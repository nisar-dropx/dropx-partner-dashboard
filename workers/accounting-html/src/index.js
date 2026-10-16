import puppeteer from "@cloudflare/puppeteer";
import { digest, normalizeStatement } from "./statement.js";
import {
  collectFednet,
  cocloudInventory,
  stageCoCloudXml,
  FEDNET_LOGIN,
  isStatementUrl,
} from "./collectors.js";
import { Store } from "./store.js";
import { Workflow } from "./workflow.js";

const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const json = (body, status = 200) => Response.json(body, { status, headers });
const workflowActions = new Set([
  "catalog",
  "evidence",
  "draft",
  "decision",
  "backup",
  "issue",
  "verify",
  "payment-plan",
]);
const routes = new Set([
  "GET /v1/status",
  "GET /v1/snapshot",
  "GET /v1/workflow",
  "GET /v1/package",
  "GET /v1/plan",
  "POST /v1/session",
  "POST /v1/collect",
  "POST /v1/stage",
  ...[...workflowActions].map((a) => `POST /v1/${a}`),
]);
async function readJson(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) throw Error("Invalid request.");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw Error("Request too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const input = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("Invalid request.");
  return input;
}
export async function authorized(request, env) {
  const key = env.ACCOUNTING_API_KEY;
  return (
    typeof key === "string" &&
    key.length >= 32 &&
    request.headers.get("x-company-id") === env.COMPANY_ID &&
    (await digest(request.headers.get("authorization") ?? "")) ===
      (await digest(`Bearer ${key}`))
  );
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return json({ ok: true, service: "accounting-html-worker" });
    if (!(await authorized(request, env)))
      return json({ error: "Unauthorized" }, 401);
    if (!routes.has(`${request.method} ${url.pathname}`))
      return json({ error: "Not found" }, 404);
    const actor = request.headers.get("x-actor-id");
    if (!actor || !/^[a-zA-Z0-9:_-]{1,100}$/.test(actor))
      return json({ error: "Actor required" }, 400);
    // All requests for this deployment use one fixed company; the caller cannot
    // select another tenant or another user's browser session.
    return env.ACCOUNTING.get(env.ACCOUNTING.idFromName(env.COMPANY_ID)).fetch(
      request,
    );
  },
};

export class AccountingSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.store = new Store(state.storage.sql);
    this.workflow = new Workflow(state.storage.sql, (fn) =>
      state.storage.transactionSync(fn),
    );
    this.busy = false;
  }
  async browser(provider, create) {
    const id = this.store.session(provider);
    if (id) {
      try {
        return await puppeteer.connect(this.env.BROWSER, id);
      } catch {
        this.store.forgetSession(provider);
      }
    }
    if (!create)
      throw Error("Browser session expired. Open a new login session.");
    const browser = await puppeteer.launch(this.env.BROWSER, {
      keep_alive: 1200000,
    });
    try {
      const page = await browser.newPage();
      await page.goto(
        provider === "fednet" ? FEDNET_LOGIN : this.env.COCLOUD_URL,
        { waitUntil: "domcontentloaded", timeout: 45000 },
      );
      this.store.setSession(provider, browser.sessionId());
      return browser;
    } catch (e) {
      await browser.close();
      throw e;
    }
  }
  async fetch(request) {
    const url = new URL(request.url),
      actor = request.headers.get("x-actor-id");
    if (request.method === "GET") {
      try {
        if (url.pathname === "/v1/status") return json(this.store.status());
        if (url.pathname === "/v1/workflow")
          return json(this.workflow.status());
        const id = url.searchParams.get("id");
        if (url.pathname === "/v1/package")
          return json(this.workflow.package(id));
        if (url.pathname === "/v1/plan") return json(this.workflow.plan(id));
        if (!/^[a-f0-9]{64}$/.test(id ?? ""))
          return json({ error: "Invalid snapshot" }, 400);
        return json(this.store.snapshot(id));
      } catch {
        return json({ error: "Snapshot not found" }, 404);
      }
    }
    if (this.busy)
      return json(
        {
          error:
            "A browser operation is already running. Try again after it finishes.",
        },
        409,
      );
    this.busy = true;
    let browser;
    try {
      // Session control requests are small. Never accept arbitrary scripts, URLs,
      // mouse input, credentials or payment instructions from clients.
      const action = url.pathname.slice("/v1/".length);
      const input = await readJson(
        request,
        ["catalog", "evidence"].includes(action) ? 4000000 : 50000,
      );
      if (action === "stage") {
        if (input.confirmed !== true)
          throw Error(
            "Confirm upload of the approved voucher package to CoCloud.",
          );
        const pkg = this.workflow.package(input.packageId);
        if (pkg.state !== "issued")
          throw Error("Posting package is no longer ready for upload.");
        if (this.workflow.setting(`stage:${pkg.id}`))
          throw Error(
            "CoCloud upload was already attempted. Check File Manager; do not upload again automatically.",
          );
        browser = await this.browser("cocloud", false);
        const page = (await browser.pages()).find(
          (p) =>
            new URL(p.url()).origin === "https://app.cocloud.in" &&
            new URL(p.url()).pathname === "/file-manager",
        );
        if (!page)
          throw Error(
            "Open CoCloud File Manager > Export in the live session.",
          );
        await cocloudInventory(page);
        const filename = `fin-tally-${pkg.id}.xml`,
          startedAt = new Date().toISOString();
        this.workflow.set(`stage:${pkg.id}`, {
          state: "upload_started",
          actor,
          startedAt,
          filename,
        });
        try {
          const result = await stageCoCloudXml(page, filename, pkg.xml);
          this.workflow.set(`stage:${pkg.id}`, {
            state: "uploaded",
            actor,
            startedAt,
            filename,
            completedAt: new Date().toISOString(),
          });
          this.store.audit(actor, "stage:cocloud", "uploaded");
          return json(result);
        } catch (error) {
          this.workflow.set(`stage:${pkg.id}`, {
            state: "uncertain",
            actor,
            startedAt,
            filename,
          });
          throw error;
        }
      }
      if (workflowActions.has(action)) {
        let result;
        if (action === "catalog")
          result = await this.workflow.uploadCatalog(input);
        else if (action === "evidence")
          result = await this.workflow.evidence(input, actor);
        else if (action === "draft")
          result = await this.workflow.draft(
            this.store.snapshot(input.snapshotId),
            input,
            actor,
          );
        else if (action === "decision")
          result = this.workflow.decide(input, actor);
        else if (action === "backup")
          result = this.workflow.backup(input, actor);
        else if (action === "issue")
          result = await this.workflow.issue(input, actor);
        else if (action === "verify")
          result = this.workflow.verify(input, actor);
        else if (action === "payment-plan")
          result = await this.workflow.paymentPlan(input, actor);
        this.store.audit(actor, action, "completed");
        return json(result);
      }
      const provider = input.provider;
      if (!["fednet", "cocloud"].includes(provider))
        throw Error("Choose FedNet or CoCloud.");
      browser = await this.browser(provider, url.pathname === "/v1/session");
      const pages = await browser.pages();
      if (url.pathname === "/v1/session") {
        const page = pages.find((p) => {
          try {
            const u = new URL(p.url());
            return provider === "fednet"
              ? u.hostname === "fednet.federal.bank.in"
              : u.hostname === "app.cocloud.in" ||
                  u.hostname === this.env.TALLY_HTML_HOST;
          } catch {
            return false;
          }
        });
        if (!page) throw Error("Expected provider tab is missing.");
        const cdp = await page.createCDPSession();
        try {
          const view = await cdp.send("Cloudflare.getLiveView", {
            mode: "full",
            expiresInMs: 300000,
          });
          this.store.audit(actor, `session:${provider}`, "opened");
          return json({
            liveView: view.devtoolsFrontendUrl,
            expiresInSeconds: 300,
            message:
              "Sign in yourself. Credentials are not stored by the worker. The browser expires after inactivity.",
          });
        } finally {
          await cdp.detach();
        }
      }
      if (provider === "fednet") {
        const page = pages.find((p) => isStatementUrl(p.url()));
        if (!page)
          throw Error(
            "Open FedNet Statements of Accounts in the live session first.",
          );
        const snapshot = await normalizeStatement(await collectFednet(page));
        if (
          !Array.isArray(input.allowedAccounts) ||
          !input.allowedAccounts.includes(snapshot.account)
        )
          throw Error(
            "Statement account is not an active bank configured in Fin.",
          );
        const id = this.store.save(snapshot);
        this.store.audit(actor, "collect:fednet", "validated");
        return json({
          id,
          count: snapshot.rows.length,
          accountLast4: snapshot.account.slice(-4),
          start: snapshot.start,
          end: snapshot.end,
          opening: snapshot.opening,
          closing: snapshot.closing,
        });
      }
      const page = pages.find(
        (p) =>
          new URL(p.url()).origin === "https://app.cocloud.in" &&
          new URL(p.url()).pathname === "/file-manager",
      );
      if (!page)
        throw Error("Open CoCloud File Manager > Export in the live session.");
      const inventory = await cocloudInventory(page);
      this.store.audit(actor, "collect:cocloud", "inventory_only");
      return json(inventory);
    } catch (error) {
      // Never log banking URLs, signed live links, credentials or statement rows.
      this.store.audit(actor, "browser_operation", "failed");
      const message =
        error instanceof Error ? error.message : "Browser operation failed.";
      const safe =
        /^(Browser session|Open |Choose |Expected |Statement |Invalid |Running |Incomplete |A complete|Clear |FedNet |CoCloud |Unable |New bank|Indistinguishable|Tally |Unsupported |Export |Select |A bill|Voucher |This bank|Import Tally|Confirm |Only approved|A matching|Day Book|Verification |Upload |Posting |Payment |A payment|Duplicate payment|Request too large)/.test(
          message,
        )
          ? message
          : "Operation failed. Check the inputs or live session and try again.";
      return json({ error: safe }, 422);
    } finally {
      try {
        await browser?.disconnect();
      } catch {
        /* Session may have expired. */
      } finally {
        this.busy = false;
      }
    }
  }
}
