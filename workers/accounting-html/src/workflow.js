import {
  catalog,
  daybook,
  bankVoucher,
  voucherXml,
  matchingVouchers,
  possibleExisting,
  sameVoucher,
  COMPANY,
} from "./tally.js";
import { date, digest, money, decimal } from "./statement.js";

export class Workflow {
  constructor(sql, atomic = (fn) => fn()) {
    this.sql = sql;
    this.atomic = atomic;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS sync_settings (key TEXT PRIMARY KEY,payload TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS sync_jobs (id TEXT PRIMARY KEY,source_key TEXT UNIQUE NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,creator TEXT NOT NULL,approver TEXT,package_id TEXT,updated_at TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS sync_packages (id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS sync_evidence (id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS sync_payment_plans (id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL)",
    );
  }
  setting(key) {
    const row = [
      ...this.sql.exec("SELECT payload FROM sync_settings WHERE key=?", key),
    ][0];
    return row ? JSON.parse(row.payload) : null;
  }
  set(key, value) {
    this.sql.exec(
      "INSERT INTO sync_settings(key,payload) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
      key,
      JSON.stringify(value),
    );
  }
  job(id) {
    const row = [...this.sql.exec("SELECT * FROM sync_jobs WHERE id=?", id)][0];
    if (!row) throw Error("Voucher job not found.");
    return {
      ...JSON.parse(row.payload),
      state: row.state,
      version: row.version,
      creator: row.creator,
      approver: row.approver,
      packageId: row.package_id,
    };
  }
  package(id) {
    const row = [
      ...this.sql.exec("SELECT * FROM sync_packages WHERE id=?", id),
    ][0];
    if (!row) throw Error("Posting package not found.");
    return { ...JSON.parse(row.payload), state: row.state };
  }
  status() {
    const masters = this.setting("catalog");
    return {
      company: COMPANY,
      catalog: masters
        ? {
            company: masters.company,
            sha256: masters.sha256,
            capturedAt: masters.capturedAt,
            ledgers: masters.ledgers,
          }
        : null,
      backup: this.setting("backup"),
      evidence: [
        ...this.sql.exec(
          "SELECT id,created_at FROM sync_evidence ORDER BY created_at DESC LIMIT 20",
        ),
      ],
      jobs: [
        ...this.sql.exec(
          "SELECT id FROM sync_jobs ORDER BY updated_at DESC LIMIT 500",
        ),
      ].map((r) => this.job(r.id)),
      packages: [
        ...this.sql.exec(
          "SELECT id,state,created_at FROM sync_packages ORDER BY created_at DESC LIMIT 100",
        ),
      ].map((p) => ({ ...p, stage: this.setting(`stage:${p.id}`) })),
      paymentPlans: [
        ...this.sql.exec(
          "SELECT id,state,created_at,payload FROM sync_payment_plans ORDER BY created_at DESC LIMIT 50",
        ),
      ].map((r) => {
        const p = JSON.parse(r.payload);
        return {
          id: r.id,
          state: r.state,
          createdAt: r.created_at,
          count: p.items.length,
          total: p.total,
          bankLast4: p.bankLast4,
        };
      }),
      capabilities: {
        bankSubmission: "user_handoff",
        tallyImport: "html_handoff",
        tallyVerification: "xml_readback",
        automaticPosting: false,
      },
    };
  }
  async uploadCatalog(input) {
    const value = await catalog(input.xml, input.company);
    this.set("catalog", value);
    return { count: value.ledgers.length, sha256: value.sha256 };
  }
  async evidence(input, actor) {
    if (input.complete !== true)
      throw Error(
        "Confirm this is a complete Day Book export for the selected company and period.",
      );
    const value = await daybook(input.xml, input);
    value.uploadedBy = actor;
    const id = await digest(
      JSON.stringify([value.sha256, value.company, value.from, value.to]),
    );
    this.sql.exec(
      "INSERT INTO sync_evidence(id,payload,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
      id,
      JSON.stringify(value),
      value.capturedAt,
    );
    return { id, count: value.vouchers.length, from: value.from, to: value.to };
  }
  readEvidence(id) {
    const row = [
      ...this.sql.exec("SELECT payload FROM sync_evidence WHERE id=?", id),
    ][0];
    if (!row) throw Error("Upload a complete Tally Day Book export first.");
    return JSON.parse(row.payload);
  }
  async draft(snapshot, input, actor) {
    const masters = this.setting("catalog");
    if (!masters) throw Error("Import Tally ledger masters first.");
    const job = await bankVoucher(snapshot, input.rowIndex, input, masters);
    this.atomic(() => {
      const existing = [
        ...this.sql.exec(
          "SELECT id FROM sync_jobs WHERE source_key=?",
          job.sourceKey,
        ),
      ][0];
      if (existing) {
        const current = this.job(existing.id);
        if (
          !["draft", "rejected"].includes(current.state) ||
          input.replaceVersion !== current.version
        )
          throw Error(
            "This bank transaction already has a voucher job. Review its existing job.",
          );
        this.sql.exec(
          "UPDATE sync_jobs SET state=?,version=version+1,payload=?,creator=?,approver=NULL,updated_at=? WHERE id=?",
          "draft",
          JSON.stringify(job),
          actor,
          new Date().toISOString(),
          current.id,
        );
        return;
      }
      this.sql.exec(
        "INSERT INTO sync_jobs(id,source_key,state,version,payload,creator,updated_at) VALUES(?,?,?,1,?,?,?)",
        job.id,
        job.sourceKey,
        "draft",
        JSON.stringify(job),
        actor,
        new Date().toISOString(),
      );
    });
    return this.job(job.id);
  }
  decide(input, actor) {
    return this.atomic(() => {
      const j = this.job(input.id);
      const reviewable =
        j.state === "draft" ||
        (j.state === "approved" && input.decision === "reject" && !j.packageId);
      if (j.version !== input.version || !reviewable)
        throw Error(
          "Voucher changed or is no longer a draft. Reload before reviewing.",
        );
      if (!["approve", "reject"].includes(input.decision))
        throw Error("Choose approve or reject.");
      if (input.decision === "approve" && input.confirmed !== true)
        throw Error(
          "Confirm the voucher date, ledgers and amount before approval.",
        );
      if (
        input.decision === "approve" &&
        j.catalogHash !== this.setting("catalog")?.sha256
      )
        throw Error(
          "Tally masters changed. Create a new reviewed draft after resolving this job.",
        );
      this.sql.exec(
        "UPDATE sync_jobs SET state=?,version=version+1,approver=?,updated_at=? WHERE id=?",
        input.decision === "approve" ? "approved" : "rejected",
        actor,
        new Date().toISOString(),
        j.id,
      );
      return this.job(j.id);
    });
  }
  backup(input, actor) {
    if (
      input.confirmed !== true ||
      typeof input.reference !== "string" ||
      input.reference.trim().length < 5 ||
      input.reference.length > 500
    )
      throw Error("Record the successful Tally backup location or reference.");
    const value = {
      reference: input.reference.trim(),
      confirmedAt: new Date().toISOString(),
      actor,
    };
    this.set("backup", value);
    return value;
  }
  async issue(input, actor) {
    if (
      !Array.isArray(input.ids) ||
      input.ids.length < 1 ||
      input.ids.length > 100 ||
      new Set(input.ids).size !== input.ids.length
    )
      throw Error("Select 1–100 distinct approved vouchers.");
    if (input.confirmed !== true)
      throw Error(
        "Confirm the backup and one-time Tally import before issuing a package.",
      );
    const evidence = this.readEvidence(input.evidenceId),
      backup = this.setting("backup");
    if (!backup || Date.now() - Date.parse(backup.confirmedAt) > 86400000)
      throw Error(
        "Confirm a successful Tally backup taken within the last 24 hours.",
      );
    if (Date.now() - Date.parse(evidence.capturedAt) > 1800000)
      throw Error(
        "Upload a fresh complete Day Book export before issuing vouchers.",
      );
    const jobs = input.ids.map((id) => this.job(id));
    for (const j of jobs) {
      if (j.state !== "approved")
        throw Error("Only approved, unissued jobs can enter a package.");
      if (j.catalogHash !== this.setting("catalog")?.sha256)
        throw Error(
          "Tally masters changed after voucher approval. Review the mapping again.",
        );
      if (j.date < evidence.from || j.date > evidence.to)
        throw Error("Day Book export does not cover every voucher date.");
      if (
        matchingVouchers(j, evidence).length ||
        possibleExisting(j, evidence).length
      )
        throw Error(
          "A matching voucher already exists in Tally. Resolve it before export.",
        );
    }
    const xml = voucherXml(jobs),
      sha256 = await digest(xml),
      id = crypto.randomUUID(),
      now = new Date().toISOString();
    const value = {
      id,
      jobIds: input.ids,
      xml,
      sha256,
      issuedBy: actor,
      issuedAt: now,
      evidenceId: input.evidenceId,
      backupReference: backup.reference,
    };
    this.atomic(() => {
      for (const j of jobs) {
        const current = this.job(j.id);
        if (current.state !== "approved" || current.version !== j.version)
          throw Error("Voucher changed during package creation.");
      }
      this.sql.exec(
        "INSERT INTO sync_packages(id,payload,state,created_at) VALUES(?,?,?,?)",
        id,
        JSON.stringify(value),
        "issued",
        now,
      );
      for (const j of jobs)
        this.sql.exec(
          "UPDATE sync_jobs SET state=?,version=version+1,package_id=?,updated_at=? WHERE id=?",
          "issued",
          id,
          now,
          j.id,
        );
    });
    return {
      id,
      sha256,
      count: jobs.length,
      message:
        "Import this package once through CoCloud HTML, then upload a fresh Day Book export for verification. Never re-import after an uncertain result.",
    };
  }
  verify(input, actor) {
    const pkg = this.package(input.packageId),
      evidence = this.readEvidence(input.evidenceId);
    if (Date.parse(evidence.capturedAt) < Date.parse(pkg.issuedAt))
      throw Error(
        "Verification requires a Day Book export captured after this package was issued.",
      );
    return this.atomic(() => {
      const results = pkg.jobIds.map((id) => {
        const j = this.job(id);
        if (j.date < evidence.from || j.date > evidence.to)
          throw Error("Verification export does not cover the package period.");
        const found = matchingVouchers(j, evidence);
        return {
          id,
          state:
            found.length === 1 &&
            /^[1-9]\d*$/.test(found[0].masterId) &&
            sameVoucher(j, found[0])
              ? "verified"
              : found.length
                ? "exception"
                : "awaiting_import",
          voucherNumber: found.length === 1 ? found[0].number : null,
        };
      });
      const now = new Date().toISOString();
      for (const r of results)
        this.sql.exec(
          "UPDATE sync_jobs SET state=?,version=version+1,updated_at=? WHERE id=?",
          r.state,
          now,
          r.id,
        );
      const state = results.every((r) => r.state === "verified")
        ? "verified"
        : "needs_review";
      this.sql.exec(
        "UPDATE sync_packages SET state=? WHERE id=?",
        state,
        pkg.id,
      );
      this.set(`verification:${pkg.id}`, {
        actor,
        evidenceId: input.evidenceId,
        at: now,
        results,
      });
      return { state, results };
    });
  }
  async paymentPlan(input, actor) {
    // Input comes only from Fin's server-side, freshly scoped approval query.
    if (
      !Array.isArray(input.items) ||
      !input.items.length ||
      input.items.length > 100
    )
      throw Error("Select 1–100 eligible payment requests.");
    const valueDate = date(input.valueDate);
    let total = 0n;
    const items = input.items.map((i) => {
      const amount = money(i.amount);
      if (
        amount <= 0n ||
        !/^[0-9]{8,34}$/.test(i.account) ||
        !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(i.ifsc) ||
        !i.name ||
        !i.id ||
        !i.reference
      )
        throw Error("A payment has an invalid amount or beneficiary.");
      total += amount;
      return {
        id: i.id,
        reference: i.reference,
        amount: decimal(amount),
        account: i.account,
        ifsc: i.ifsc,
        name: String(i.name).slice(0, 150),
      };
    });
    if (new Set(items.map((i) => i.id)).size !== items.length)
      throw Error("Duplicate payment request selected.");
    if (!/^[0-9]{8,34}$/.test(input.debitAccount))
      throw Error("Choose a valid Federal Bank debit account.");
    const canonical = {
      valueDate,
      debitAccount: input.debitAccount,
      items: items.sort((a, b) => a.id.localeCompare(b.id)),
    };
    const id = await digest(JSON.stringify(canonical)),
      payload = {
        ...canonical,
        id,
        total: decimal(total),
        bankLast4: input.debitAccount.slice(-4),
        createdBy: actor,
      };
    this.sql.exec(
      "INSERT INTO sync_payment_plans(id,payload,state,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
      id,
      JSON.stringify(payload),
      "prepared",
      new Date().toISOString(),
    );
    return {
      id,
      count: items.length,
      total: payload.total,
      message:
        "Preparation only. Review and submit through FedNet yourself; Fin payment statuses have not changed.",
    };
  }
  plan(id) {
    const row = [
      ...this.sql.exec(
        "SELECT payload,state FROM sync_payment_plans WHERE id=?",
        id,
      ),
    ][0];
    if (!row) throw Error("Payment plan not found.");
    return { ...JSON.parse(row.payload), state: row.state };
  }
}
