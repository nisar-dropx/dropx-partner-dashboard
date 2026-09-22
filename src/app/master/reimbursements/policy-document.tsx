"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { MasterRow } from "./reimbursement-master";
export function PolicyDocument({
  documents,
  canAdd,
  canEdit,
}: {
  documents: MasterRow[];
  canAdd: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const current = documents.find((d) => d.is_current);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function publish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(e.currentTarget);
    form.set("expected_id", current?.id ?? "");
    try {
      const r = await fetch("/api/finance/reimbursements/policy", {
        method: "POST",
        body: form,
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || "Unable to publish");
      setEditing(false);
      setMessage(
        "Published. One will use this document when users next open or refresh Expense requests.",
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to publish.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="reimbursement-master rm-panel rm-policy-document">
      <header>
        <div>
          <h2>Business travel policy</h2>
          <p>
            {current
              ? `${current.title} · ${current.version_label} · Effective ${current.effective_from}`
              : "No policy published yet."}
          </p>
        </div>
        <div className="rm-policy-actions">
          {current ? (
            <>
              <a
                href="/api/finance/reimbursements/policy"
                target="_blank"
                rel="noopener noreferrer"
              >
                View PDF
              </a>
              <a href="/api/finance/reimbursements/policy?download=1">
                Download
              </a>
            </>
          ) : null}
          {(current ? canEdit : canAdd) ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(!editing)}
            >
              {editing
                ? "× Close"
                : current
                  ? "Replace policy"
                  : "Publish policy"}
            </button>
          ) : null}
        </div>
      </header>
      {message ? (
        <p role="status" className="rm-note">
          {message}
        </p>
      ) : null}
      {editing ? (
        <form className="rm-document-form" onSubmit={publish}>
          <label>
            Document title
            <input
              name="title"
              defaultValue={String(
                current?.title ?? "Business Travel Expense Policy",
              )}
              required
              minLength={3}
              maxLength={160}
            />
          </label>
          <label>
            Version
            <input
              name="version_label"
              placeholder="e.g. Version 2.0"
              required
              maxLength={60}
            />
          </label>
          <label>
            Effective from
            <input name="effective_from" type="date" required />
          </label>
          <label>
            Policy PDF
            <input name="file" type="file" accept="application/pdf" required />
            <small>PDF up to 4 MB. Previous versions are retained.</small>
          </label>
          <p className="rm-note">
            Publishing replaces the document shown in One on web, mobile and the
            installed web app. Update the designation limits separately when
            policy amounts change; uploading a PDF does not automatically
            interpret new rates.
          </p>
          <div className="rm-policy-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Publishing…" : "Publish policy"}
            </button>
          </div>
        </form>
      ) : null}
      {documents.length > 1 ? (
        <details>
          <summary>Previous versions ({documents.length - 1})</summary>
          <ul>
            {documents
              .filter((d) => !d.is_current)
              .map((d) => (
                <li key={d.id}>
                  {String(d.title)} · {String(d.version_label)} ·{" "}
                  {String(d.effective_from)}{" "}
                  <a
                    href={`/api/finance/reimbursements/policy?id=${d.id}&download=1`}
                  >
                    Download
                  </a>
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
