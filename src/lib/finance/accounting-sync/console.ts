export const accountingConsole = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Bank & Tally sync</title>
    <style>
      :root {
        font:
          15px/1.55 system-ui,
          sans-serif;
        color: #193046;
        background: #f5f7fa;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        padding: 24px;
        max-width: 1250px;
        margin-inline: auto;
      }
      h1,
      h2,
      p {
        margin-top: 0;
      }
      h2 {
        font-size: 19px;
      }
      .muted,
      small {
        color: #65768a;
      }
      .cards {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
      }
      .card {
        background: white;
        border: 1px solid #dce3ea;
        border-radius: 14px;
        padding: 23px;
        margin-bottom: 20px;
      }
      button,
      .link {
        display: inline-block;
        border: 1px solid #c6d3df;
        background: #fff;
        color: #17466c;
        padding: 10px 15px;
        border-radius: 8px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        text-decoration: none;
        margin: 4px 6px 4px 0;
      }
      button.primary {
        background: #174d76;
        color: white;
        border-color: #174d76;
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      a {
        color: #174d76;
      }
      select {
        padding: 10px;
        border: 1px solid #bac9d7;
        border-radius: 7px;
        max-width: 100%;
        font: inherit;
      }
      #notice {
        white-space: pre-wrap;
        padding: 14px;
        border-radius: 8px;
        background: #edf3f9;
        margin-bottom: 18px;
      }
      #notice.error {
        background: #fff0eb;
        color: #8e341c;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      th,
      td {
        padding: 10px;
        text-align: left;
        border-bottom: 1px solid #e3e9ef;
        vertical-align: top;
      }
      th {
        color: #64778b;
      }
      .scroll {
        overflow: auto;
        max-height: 360px;
      }
      .pill {
        display: inline-block;
        background: #edf3f9;
        color: #345973;
        border-radius: 20px;
        padding: 4px 10px;
        font-size: 12px;
      }
      .steps {
        border-left: 3px solid #789bb7;
        padding-left: 14px;
        margin: 16px 0;
      }
      .review {
        background: #f8fafc;
        padding: 16px;
        border-radius: 8px;
      }
      .kpis {
        display: flex;
        flex-wrap: wrap;
        gap: 24px;
        margin: 12px 0;
      }
      .kpis strong {
        display: block;
        font-size: 20px;
      }
      label {
        display: block;
        margin: 12px 0;
      }
      input {
        margin-right: 8px;
      }
      #preview[hidden] {
        display: none;
      }
      @media (max-width: 700px) {
        body {
          padding: 12px;
        }
        .cards {
          grid-template-columns: 1fr;
        }
        .card {
          padding: 17px;
        }
      }
    </style>
  </head>
  <body>
    <div id="notice" role="status" aria-live="polite">Checking connection…</div>
    <div class="cards">
      <section class="card">
        <span class="pill">BANK STATEMENTS</span>
        <h2>FedNet</h2>
        <p>
          Read complete statements from your bank session. Every row and running balance is checked
          before review.
        </p>
        <div class="steps">
          Open a session, sign in and open <b>Statements of Accounts</b>. Choose an unfiltered
          period, then return here to collect it.
        </div>
        <button data-provider="fednet" class="session primary">Open login session</button
        ><button data-provider="fednet" class="collect">Collect statement</button>
        <div id="fednet-link"></div>
      </section>
      <section class="card">
        <span class="pill">HOSTED TALLY</span>
        <h2>CoCloud HTML</h2>
        <p>
          Use your hosted Tally through the HTML login. Your accounts team's existing Remote App
          access stays available.
        </p>
        <div class="steps">
          Sign in, open <b>File Manager → Export</b> and use the Tally workspace below to prepare,
          import and verify vouchers.
        </div>
        <button data-provider="cocloud" class="session primary">Open login session</button
        ><button data-provider="cocloud" class="collect">Read export inventory</button>
        <div id="cocloud-link"></div>
        <p class="muted">
          The final Tally import happens in your HTML session. Fin verifies its result from a fresh
          Day Book export.
        </p>
      </section>
    </div>
    <section class="card">
      <h2>Statements ready for review</h2>
      <p class="muted">
        Collection saves evidence only. Import a reviewed statement to use Fin's existing
        reconciliation workspace.
      </p>
      <button id="refresh">Refresh</button>
      <div id="statements"></div>
    </section>
    <section class="card" id="preview" hidden>
      <h2>Review statement</h2>
      <div id="summary"></div>
      <div class="scroll" id="rows"></div>
      <div class="review">
        <label
          >Bank account in Fin
          <select id="bank">
            <option value="">Select bank account</option>
          </select></label
        ><label
          ><input type="checkbox" id="confirm" />I reviewed the account, dates, opening and closing
          balances and all transactions.</label
        ><button id="import" class="primary">Import reviewed statement</button
        ><a class="link" href="/finance/treasury?tab=exceptions" target="_top"
          >View reconciliation</a
        >
      </div>
    </section>
    <section class="card" id="inventory" hidden>
      <h2>CoCloud export inventory</h2>
      <p class="muted">Visible page only. These files have not been imported into Fin.</p>
      <div id="files" class="scroll"></div>
    </section>
    <section class="card">
      <span class="pill">APPROVED PAYMENTS</span>
      <h2>Prepare FedNet payments</h2>
      <p>
        Only approved account-transfer requests are eligible. Requests already processing are
        excluded. Preparation does not change payment status.
      </p>
      <button id="payments-load" class="owner-action">Load approved requests</button>
      <div id="payment-candidates" class="scroll"></div>
      <label
        >Debit bank
        <select id="payment-bank">
          <option value="">Select account</option>
        </select></label
      ><label>Payment date <input type="date" id="payment-date" /></label
      ><button id="payment-prepare" class="owner-action primary">Prepare selected payments</button>
      <p class="muted">
        Use the review checklist while completing transfers in FedNet. It is not a bank-upload
        format. Record the bank result in
        <a href="/payments/process" target="_top">Payment processing</a>, then collect the statement
        to reconcile.
      </p>
      <div id="payment-plans"></div>
    </section>
    <section class="card">
      <span class="pill">TALLY SETUP</span>
      <h2>DROPX 2026–27</h2>
      <p>
        Import the existing ledger masters from Tally as XML. Drafts use exact ledger names; no new
        ledgers or tax rules are guessed.
      </p>
      <div id="catalog-status" class="muted"></div>
      <label
        >Tally ledger masters XML
        <input type="file" id="masters-file" accept=".xml,application/xml,text/xml" /></label
      ><label
        ><input type="checkbox" id="masters-company" />This export belongs to DROPX 2026-27.</label
      ><button id="masters-upload" class="owner-action">Load ledger masters</button>
      <hr />
      <label
        >Successful backup location / reference
        <input
          id="backup-reference"
          maxlength="500"
          placeholder="Backup file or backup job reference"
          style="width: 100%; padding: 10px" /></label
      ><label
        ><input type="checkbox" id="backup-confirm" />I verified that this Tally backup completed
        successfully.</label
      ><button id="backup-save" class="owner-action">Record backup</button>
      <div id="backup-status" class="muted"></div>
    </section>
    <section class="card">
      <span class="pill">DRAFT VOUCHER</span>
      <h2>Turn bank evidence into a Tally voucher</h2>
      <p>
        First open a statement using Review above. Select its row and the corresponding ledgers.
        These are bank Payment/Receipt vouchers; review bill allocation before approving.
      </p>
      <label
        >Statement row
        <select id="draft-row">
          <option value="">Review a statement first</option>
        </select></label
      ><label
        >Tally bank ledger
        <select id="bank-ledger"></select></label
      ><label
        >Counterparty / expense ledger
        <select id="counter-ledger"></select></label
      ><label
        >Existing bill reference, if bill-wise <input id="bill-reference" maxlength="100" /></label
      ><button id="draft-create" class="owner-action primary">Create voucher draft</button>
      <p class="muted">
        For rejected drafts, selecting the same bank row creates a revised draft. An issued voucher
        cannot be issued again.
      </p>
    </section>
    <section class="card">
      <span class="pill">TALLY EVIDENCE</span>
      <h2>Upload Day Book XML</h2>
      <p>
        In the CoCloud HTML Tally session, export the complete Day Book for the period as XML.
        Download it through File Manager. Upload before issuing a package, and again after importing
        it.
      </p>
      <label>From <input type="date" id="evidence-from" /></label
      ><label>To <input type="date" id="evidence-to" /></label
      ><label
        >Day Book XML
        <input type="file" id="evidence-file" accept=".xml,application/xml,text/xml" /></label
      ><label
        ><input type="checkbox" id="evidence-complete" />This is the complete, unfiltered Day Book
        of DROPX 2026-27 for these dates.</label
      ><button id="evidence-upload" class="owner-action">Load Day Book evidence</button
      ><label
        >Evidence for issue / verification
        <select id="evidence-select"></select
      ></label>
    </section>
    <section class="card">
      <span class="pill">POSTING QUEUE</span>
      <h2>Review and approve vouchers</h2>
      <p>
        Approval confirms the shown date, amount, ledger names and bill reference. Issuing requires
        a recent backup and a fresh Day Book covering every selected voucher.
      </p>
      <div id="voucher-jobs" class="scroll"></div>
      <label
        ><input type="checkbox" id="issue-confirm" />I reviewed the selected vouchers and will
        import the resulting package only once.</label
      ><button id="issue-package" class="owner-action primary">
        Issue selected approved vouchers
      </button>
      <div class="steps">
        <b>HTML import:</b> Download the XML package, upload it through CoCloud File Manager, then
        use Tally <b>Alt+O → Transactions</b> and select that file. Verify the company and backup
        option before importing. If the result is uncertain, export Day Book and verify below before
        attempting anything else.
      </div>
      <div id="posting-packages"></div>
    </section>
    <section class="card">
      <h2>Activity</h2>
      <div id="activity" class="scroll"></div>
    </section>
    <p class="muted">
      Browser sessions expire after inactivity. Login links expire after five minutes and give
      control of the session—keep them private. Bank submission and Tally import require your
      action; statement validation, package generation and read-back checks run automatically.
    </p>
    <script>
      const base = "/api/finance/accounting-sync/";
      let state = null,
        selected = null,
        busy = false,
        workflow = null;
      const el = (id) => document.getElementById(id);
      function notice(text, error = false) {
        el("notice").textContent = text;
        el("notice").className = error ? "error" : "";
      }
      async function api(action, body) {
        const response = await fetch(base + action, {
          method: body === undefined ? "GET" : "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!response.headers.get("content-type")?.includes("application/json"))
          throw Error("Sign in to Fin again, then reload this page.");
        const data = await response.json();
        if (!response.ok) throw Error(data.error || "Operation failed.");
        return data;
      }
      function controls() {
        document
          .querySelectorAll(".session,.collect,.owner-action")
          .forEach((b) => (b.disabled = busy || !state?.configured || !state?.owner));
        el("import").disabled =
          busy || !state?.canImport || !selected || !el("confirm").checked || !el("bank").value;
        el("refresh").disabled = busy;
      }
      async function run(fn) {
        if (busy) return;
        busy = true;
        controls();
        try {
          await fn();
        } catch (e) {
          notice(e.message, true);
        } finally {
          busy = false;
          controls();
        }
      }
      function table(headers, rows) {
        const t = document.createElement("table"),
          head = t.createTHead().insertRow();
        for (const h of headers) {
          const c = document.createElement("th");
          c.textContent = h;
          head.append(c);
        }
        const body = t.createTBody();
        for (const r of rows) {
          const tr = body.insertRow();
          for (const v of r) {
            const td = tr.insertCell();
            if (v instanceof Node) td.append(v);
            else td.textContent = String(v ?? "");
          }
        }
        return t;
      }
      function dateTime(s) {
        return new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      }
      async function load() {
        state = await api("status");
        for (const id of ["bank", "payment-bank"])
          el(id).replaceChildren(
            new Option("Select bank account", ""),
            ...state.banks.map((b) => new Option(b.name + " · " + b.last4, b.id)),
          );
        el("statements").replaceChildren();
        if (!state.snapshots.length) el("statements").textContent = "No collected statements yet.";
        else
          el("statements").append(
            table(
              ["Account", "Collected (IST)", "Review"],
              state.snapshots.map((s) => {
                const b = document.createElement("button");
                b.textContent = "Review";
                b.onclick = () => run(() => preview(s.id));
                return ["…" + s.account_last4, dateTime(s.captured_at), b];
              }),
            ),
          );
        el("activity").replaceChildren(
          table(
            ["Time (IST)", "Action", "Result"],
            (state.events || []).map((e) => [dateTime(e.at), e.action, e.outcome]),
          ),
        );
        if (state.owner && state.configured) await loadWorkflow();
        controls();
      }
      async function preview(id) {
        const s = await api("preview?id=" + encodeURIComponent(id));
        selected = s;
        el("confirm").checked = false;
        el("bank").value = "";
        el("preview").hidden = false;
        el("summary").textContent =
          "Account …" +
          s.accountLast4 +
          " · " +
          s.start +
          " to " +
          s.end +
          " · " +
          s.rows.length +
          " transactions · Opening ₹" +
          s.opening +
          " · Closing ₹" +
          s.closing;
        el("rows").replaceChildren(
          table(
            ["Date", "Description", "Bank reference", "Debit", "Credit", "Balance"],
            s.rows.map((r) => [
              r.date,
              r.description,
              r.reference || "Needs review",
              r.debit,
              r.credit,
              r.balance,
            ]),
          ),
        );
        el("draft-row").replaceChildren(
          new Option("Select transaction", ""),
          ...s.rows.map(
            (r, i) =>
              new Option(
                i +
                  1 +
                  ": " +
                  r.date +
                  " " +
                  r.description.slice(0, 80) +
                  " · " +
                  (Number(r.debit) > 0 ? "Debit " + r.debit : "Credit " + r.credit),
                String(i),
              ),
          ),
        );
        notice("Review the full statement and choose the matching bank account.");
        el("preview").scrollIntoView({ behavior: "smooth" });
      }
      document.querySelectorAll(".session").forEach(
        (b) =>
          (b.onclick = () =>
            run(async () => {
              notice("Opening browser session…");
              const p = b.dataset.provider,
                r = await api("session", { provider: p });
              const a = document.createElement("a");
              a.href = r.liveView;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
              a.className = "link";
              a.textContent = "Open " + (p === "fednet" ? "FedNet" : "CoCloud") + " live session";
              el(p + "-link").replaceChildren(a);
              notice(r.message);
            })),
      );
      document.querySelectorAll(".collect").forEach(
        (b) =>
          (b.onclick = () =>
            run(async () => {
              notice(
                "Collecting and validating. Keep the statement unchanged until this finishes.",
              );
              const p = b.dataset.provider,
                r = await api("collect", { provider: p });
              if (p === "fednet") {
                await load();
                await preview(r.id);
              } else {
                el("inventory").hidden = false;
                el("files").replaceChildren(
                  table(
                    ["File", "Size", "Modified"],
                    r.files.map((f) => [f.name, f.size, f.modified]),
                  ),
                );
                notice(r.message);
              }
            })),
      );
      el("refresh").onclick = () =>
        run(async () => {
          await load();
          notice(
            state.configured
              ? "Connection checked."
              : "Accounting worker has not been connected. Deployment and the shared server secret are required.",
          );
        });
      el("confirm").onchange = controls;
      el("bank").onchange = controls;
      el("import").onclick = () =>
        run(async () => {
          const r = await api("import", {
            id: selected.sha256,
            bankId: el("bank").value,
            confirmed: el("confirm").checked,
          });
          notice(r.message);
          selected = null;
          el("preview").hidden = true;
          await load();
        });
      function action(label, fn) {
        const b = document.createElement("button");
        b.textContent = label;
        b.className = "owner-action";
        b.onclick = () => run(fn);
        return b;
      }
      function download(label, path) {
        const a = document.createElement("a");
        a.textContent = label;
        a.href = base + path;
        a.className = "link";
        return a;
      }
      function checked(className) {
        return [...document.querySelectorAll("input." + className + ":checked")].map(
          (e) => e.value,
        );
      }
      async function xmlFile(id) {
        const f = el(id).files[0];
        if (!f || f.size > 3000000 || !f.name.toLowerCase().endsWith(".xml"))
          throw Error("Select an XML export smaller than 3 MB.");
        return f.text();
      }
      async function loadWorkflow() {
        workflow = await api("workflow");
        const masters = workflow.catalog;
        el("catalog-status").textContent = masters
          ? masters.ledgers.length + " ledgers · Imported " + dateTime(masters.capturedAt)
          : "No ledger masters loaded.";
        for (const id of ["bank-ledger", "counter-ledger"])
          el(id).replaceChildren(
            new Option("Select ledger", ""),
            ...(masters?.ledgers || [])
              .filter(
                (l) => id !== "bank-ledger" || ["Bank Accounts", "Bank OD A/c"].includes(l.parent),
              )
              .map((l) => new Option(l.name + (l.billwise ? " · bill-wise" : ""), l.name)),
          );
        el("backup-status").textContent = workflow.backup
          ? "Backup confirmed " +
            dateTime(workflow.backup.confirmedAt) +
            " · " +
            workflow.backup.reference
          : "A successful backup must be recorded before issuing a package.";
        el("evidence-select").replaceChildren(
          new Option("Select Day Book export", ""),
          ...workflow.evidence.map(
            (e) => new Option(dateTime(e.created_at) + " · " + e.id.slice(0, 10), e.id),
          ),
        );
        el("voucher-jobs").replaceChildren(
          table(
            ["Select", "Date / type", "Ledgers and signed amounts", "State", "Action"],
            workflow.jobs.map((j) => {
              const box = document.createElement("input");
              box.type = "checkbox";
              box.className = "job-choice";
              box.value = j.id;
              box.disabled = j.state !== "approved";
              const actions = document.createElement("div");
              if (["draft", "approved"].includes(j.state)) {
                for (const decision of j.state === "draft" ? ["approve", "reject"] : ["reject"])
                  actions.append(
                    action(decision === "approve" ? "Approve voucher" : "Reject", async () => {
                      await api("decision", {
                        id: j.id,
                        version: j.version,
                        decision,
                        confirmed: true,
                      });
                      await loadWorkflow();
                      notice("Voucher " + decision + " recorded.");
                    }),
                  );
              }
              return [
                box,
                j.date + " · " + j.type,
                j.entries
                  .map(
                    (e) =>
                      e.ledger +
                      ": " +
                      e.amount +
                      (e.billReference ? " · bill " + e.billReference : ""),
                  )
                  .join("\n"),
                j.state,
                actions,
              ];
            }),
          ),
        );
        el("posting-packages").replaceChildren(
          table(
            ["Package", "State", "Import / verify"],
            workflow.packages.map((p) => {
              const actions = document.createElement("div");
              if (p.state === "issued" && !p.stage)
                actions.append(
                  action("Upload XML to CoCloud", async () => {
                    const r = await api("stage", { packageId: p.id, confirmed: true });
                    await loadWorkflow();
                    notice(r.message);
                  }),
                );
              if (p.stage) {
                const note = document.createElement("p");
                note.textContent = "CoCloud upload: " + p.stage.state;
                actions.append(note);
              }
              actions.append(
                download("Download XML", "package?id=" + encodeURIComponent(p.id)),
                action("Verify against selected Day Book", async () => {
                  const r = await api("verify", {
                    packageId: p.id,
                    evidenceId: el("evidence-select").value,
                  });
                  await loadWorkflow();
                  notice(
                    "Verification: " + r.state + " · " + r.results.map((j) => j.state).join(", "),
                    r.state !== "verified",
                  );
                }),
              );
              return [p.id.slice(0, 12), p.state, actions];
            }),
          ),
        );
        el("payment-plans").replaceChildren(
          table(
            ["Plan", "Payments", "Total INR", "Checklist"],
            workflow.paymentPlans.map((p) => [
              p.id.slice(0, 12),
              p.count,
              p.total,
              download("Download review checklist", "plan?id=" + p.id),
            ]),
          ),
        );
        controls();
      }
      el("payments-load").onclick = () =>
        run(async () => {
          const r = await api("candidates");
          el("payment-candidates").replaceChildren(
            table(
              ["Select", "Request", "Beneficiary", "Account", "Amount INR", "Status"],
              r.items.map((i) => {
                const c = document.createElement("input");
                c.type = "checkbox";
                c.className = "payment-choice";
                c.value = i.id;
                c.disabled = !i.ready;
                return [
                  c,
                  i.reference,
                  i.name || "",
                  i.accountLast4 ? "…" + i.accountLast4 : "",
                  i.amount || "",
                  i.ready ? "Ready" : i.error,
                ];
              }),
            ),
          );
          notice(
            r.hasMore
              ? "Showing the first 500 candidates. Use Payment processing for the remaining requests."
              : "Approved requests loaded.",
          );
        });
      el("payment-prepare").onclick = () =>
        run(async () => {
          const r = await api("payment-plan", {
            requestIds: checked("payment-choice"),
            bankId: el("payment-bank").value,
            valueDate: el("payment-date").value,
          });
          await loadWorkflow();
          notice(r.message);
        });
      el("masters-upload").onclick = () =>
        run(async () => {
          if (!el("masters-company").checked)
            throw Error("Confirm the company before loading masters.");
          const r = await api("catalog", {
            xml: await xmlFile("masters-file"),
            company: "DROPX 2026-27",
          });
          await loadWorkflow();
          notice(r.count + " Tally ledgers loaded.");
        });
      el("backup-save").onclick = () =>
        run(async () => {
          await api("backup", {
            reference: el("backup-reference").value,
            confirmed: el("backup-confirm").checked,
          });
          await loadWorkflow();
          notice("Backup confirmation recorded.");
        });
      el("draft-create").onclick = () =>
        run(async () => {
          if (!selected || el("draft-row").value === "")
            throw Error("Review a statement and select its transaction first.");
          const rowIndex = Number(el("draft-row").value),
            existing = workflow?.jobs.find(
              (j) => j.source.fingerprint === selected.rows[rowIndex].fingerprint,
            );
          await api("draft", {
            snapshotId: selected.sha256,
            rowIndex,
            bankLedger: el("bank-ledger").value,
            counterLedger: el("counter-ledger").value,
            billReference: el("bill-reference").value,
            replaceVersion: existing?.version,
          });
          await loadWorkflow();
          notice("Voucher draft saved for review.");
        });
      el("evidence-upload").onclick = () =>
        run(async () => {
          const r = await api("evidence", {
            xml: await xmlFile("evidence-file"),
            company: "DROPX 2026-27",
            from: el("evidence-from").value,
            to: el("evidence-to").value,
            complete: el("evidence-complete").checked,
          });
          await loadWorkflow();
          el("evidence-select").value = r.id;
          notice(r.count + " Tally vouchers loaded as evidence.");
        });
      el("issue-package").onclick = () =>
        run(async () => {
          const r = await api("issue", {
            ids: checked("job-choice"),
            evidenceId: el("evidence-select").value,
            confirmed: el("issue-confirm").checked,
          });
          el("issue-confirm").checked = false;
          await loadWorkflow();
          notice(r.message);
        });
      run(async () => {
        await load();
        notice(
          state.configured
            ? "Ready. Open a login session to collect new evidence."
            : "Accounting worker has not been connected. Deployment and the shared server secret are required.",
        );
      });
    </script>
  </body>
</html>
`;
