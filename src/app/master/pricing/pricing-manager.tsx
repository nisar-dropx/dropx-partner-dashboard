"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  amazonCsv,
  amazonFields,
  csvText,
  todayIndia,
  validatePricing,
  type PricingCard,
  type PricingInput,
} from "@/lib/finance/pricing";
import { savePricing } from "./actions";
function download(filename: string, body: string) {
  const url = URL.createObjectURL(
    new Blob([body], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className="fin-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="fin-dialog-head">
        <h2>{title}</h2>
        <button
          className="button secondary"
          onClick={onClose}
          type="button"
          aria-label="Close dialog"
        >
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}
const money = (value: string | null | undefined) =>
  value == null
    ? "Not supplied"
    : `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export function PricingManager({
  history,
  locations,
  canAdd,
  canEdit,
}: {
  history: PricingCard[];
  locations: { code: string; name: string }[];
  canAdd: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const months = [...new Set(history.map((c) => c.effective_month.slice(0, 7)))]
    .sort()
    .reverse();
  const [month, setMonth] = useState(months[0] || todayIndia().slice(0, 7));
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<PricingInput | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [upload, setUpload] = useState(false);
  const [preview, setPreview] = useState<PricingInput[] | null>(null);
  const importReadVersion = useRef(0);
  const [importMonth, setImportMonth] = useState(todayIndia().slice(0, 7));
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const latest = history.filter(
    (c, i, all) =>
      all.findIndex(
        (x) =>
          x.provider === c.provider &&
          x.station_code === c.station_code &&
          x.effective_month === c.effective_month,
      ) === i,
  );
  const cards = latest.filter(
    (c) =>
      (!month || c.effective_month === `${month}-01`) &&
      (!provider || c.provider === provider) &&
      `${c.station_code} ${c.rates.city || ""} ${locations.find((l) => l.code === c.station_code)?.name || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const close = () => {
    if (pending) return;
    setEditing(null);
    setUpload(false);
    setHistoryKey(null);
    setPreview(null);
    setError("");
  };
  const save = async (items: PricingInput[]) => {
    if (pending) return;
    setError("");
    setPending(true);
    try {
      const result = await savePricing(items);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(
        `${result.count} rate card${result.count === 1 ? "" : "s"} saved. Previous revisions are retained.`,
      );
      setMonth(items[0].effective_month.slice(0, 7));
      setEditing(null);
      setUpload(false);
      setPreview(null);
      router.refresh();
    } catch {
      setError(
        "The connection was interrupted. Refresh and check the latest revision before retrying.",
      );
    } finally {
      setPending(false);
    }
  };
  const edit = (c: PricingCard, copy = false) => {
    setError("");
    setEditing({
      ...c,
      expected_revision: copy ? 0 : c.revision,
      effective_month: copy
        ? `${todayIndia().slice(0, 7)}-01`
        : c.effective_month,
      reason: copy
        ? `Copied from ${c.effective_month.slice(0, 7)} revision ${c.revision}`
        : "",
      source_file: c.source_file,
      source_sha256: c.source_sha256,
    });
  };
  const newCard = () => {
    setError("");
    setEditing({
      provider: "Flipkart",
      station_code: "",
      effective_month: `${todayIndia().slice(0, 7)}-01`,
      expected_revision: 0,
      rates: {},
      slabs: [{ above: "0", upto: null, rate: "" }],
      slab_mode: "progressive",
      reason: "",
    });
  };
  async function readFile(file: File | undefined) {
    if (!file) return;
    const readVersion = ++importReadVersion.current;
    setError("");
    setPreview(null);
    try {
      if (file.size > 2_000_000)
        throw new Error("Choose a CSV smaller than 2 MB.");
      const bytes = await file.arrayBuffer();
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (readVersion !== importReadVersion.current) return;
      setPreview(
        amazonCsv(
          new TextDecoder().decode(bytes),
          importMonth,
          file.name,
          hash,
        ),
      );
    } catch (e) {
      if (readVersion === importReadVersion.current)
        setError(e instanceof Error ? e.message : "Unable to read CSV.");
    }
  }
  return (
    <>
      <div className="fin-toolbar">
        <div>
          <span className="fin-chip">Amazon · MG</span>{" "}
          <span className="fin-chip">Flipkart · Delivery slabs</span>
        </div>
        <div className="fin-actions">
          {canAdd && (
            <>
              <button
                className="button secondary"
                onClick={() => {
                  setUpload(true);
                  setError("");
                }}
              >
                Import Amazon CSV
              </button>
              <button className="button" onClick={newCard}>
                Add rate card
              </button>
            </>
          )}
          <button
            className="button secondary"
            disabled={!cards.length}
            onClick={() =>
              download(
                `pricing-${month || "all"}.csv`,
                csvText([
                  [
                    "Client",
                    "Station",
                    "Month",
                    "Revision",
                    ...amazonFields.map((f) => f[1]),
                    "Slab method",
                    "Slabs (JSON)",
                    "Source",
                    "Changed at",
                  ],
                  ...cards.map((c) => [
                    c.provider,
                    c.station_code,
                    c.effective_month.slice(0, 7),
                    c.revision,
                    ...amazonFields.map(([key]) => c.rates[key]),
                    c.provider === "Flipkart" ? c.slab_mode : "",
                    c.provider === "Flipkart" ? JSON.stringify(c.slabs) : "",
                    c.source_file,
                    c.created_at,
                  ]),
                ]),
              )
            }
          >
            Download
          </button>
        </div>
      </div>
      {notice && (
        <div className="fin-notice success" role="status">
          {notice}
        </div>
      )}
      <div className="fin-filters">
        <label>
          Effective month
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="">All months</option>
            {months.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          Client
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="">All clients</option>
            <option>Amazon</option>
            <option>Flipkart</option>
          </select>
        </label>
        <label>
          Location search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Station code or location"
          />
        </label>
        <span className="subtle">{cards.length} rate cards</span>
      </div>
      <div className="fin-notice">
        Amazon MG payout and volume are divided by calendar days. Daily excess
        deliveries use the variable slab rate; MFN uses its own rate. IHS/SMD
        settlement rules, shortfall recovery, fees and tax need confirmed rules
        before final invoicing. Blank source fields remain unspecified.
      </div>
      <section className="panel">
        <div className="fin-table-wrap">
          <table className="fin-table">
            <thead>
              <tr>
                <th>Allocation / location</th>
                <th>Client & model</th>
                <th>Effective month</th>
                <th>Monthly MG / slabs</th>
                <th>MG delivery volume</th>
                <th>Revision</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.station_code}</strong>
                    <small>
                      {locations.find((l) => l.code === c.station_code)?.name ||
                        c.rates.city ||
                        "Unmapped location"}
                    </small>
                    {!locations.some((l) => l.code === c.station_code) && (
                      <small className="fin-warning">
                        Location mapping needed
                      </small>
                    )}
                  </td>
                  <td>
                    {c.provider}
                    <small>
                      {c.provider === "Amazon"
                        ? "Minimum guarantee"
                        : `${c.slab_mode === "all_units" ? "All-units" : "Progressive"} slabs`}
                    </small>
                  </td>
                  <td>{c.effective_month.slice(0, 7)}</td>
                  <td>
                    {c.provider === "Amazon"
                      ? money(c.rates.mg_amount_including_mhe)
                      : `${c.slabs.length} slabs`}
                  </td>
                  <td>
                    {c.rates.delivery_mg_volume
                      ? Number(c.rates.delivery_mg_volume).toLocaleString(
                          "en-IN",
                          { maximumFractionDigits: 2 },
                        )
                      : "—"}
                  </td>
                  <td>v{c.revision}</td>
                  <td>
                    <div className="fin-actions">
                      {canEdit && (
                        <button
                          className="button secondary small"
                          onClick={() => edit(c)}
                        >
                          Edit
                        </button>
                      )}
                      {canAdd && (
                        <button
                          className="button secondary small"
                          onClick={() => edit(c, true)}
                        >
                          Copy to month
                        </button>
                      )}
                      <button
                        className="button secondary small"
                        onClick={() =>
                          setHistoryKey(
                            `${c.provider}/${c.station_code}/${c.effective_month}`,
                          )
                        }
                      >
                        Details & history
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!cards.length && (
          <div className="fin-empty">
            <h3>No rate cards for these filters</h3>
            <p>
              Import an Amazon MG file or add a Flipkart slab card. No rates are
              carried into a new month automatically.
            </p>
            <button
              className="button secondary"
              onClick={() => {
                setMonth("");
                setProvider("");
                setSearch("");
              }}
            >
              Show all available rates
            </button>
          </div>
        )}
      </section>
      {editing && (
        <Modal
          title={`${editing.expected_revision ? "Edit" : "Add"} ${editing.provider} rate card`}
          onClose={close}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              try {
                save([validatePricing(editing)]);
              } catch (err) {
                setError(
                  err instanceof Error ? err.message : "Invalid rate card.",
                );
              }
            }}
          >
            {error && (
              <p className="fin-notice error" role="alert">
                {error}
              </p>
            )}
            <div className="fin-form-grid">
              <label>
                Client
                <select
                  disabled={!!editing.expected_revision}
                  value={editing.provider}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      provider: e.target.value as PricingInput["provider"],
                      slabs: [{ above: "0", upto: null, rate: "" }],
                    })
                  }
                >
                  <option>Amazon</option>
                  <option>Flipkart</option>
                </select>
              </label>
              <label>
                Station code
                <input
                  required
                  list="fin-locations"
                  disabled={!!editing.expected_revision}
                  value={editing.station_code}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      station_code: e.target.value.toUpperCase().trim(),
                    })
                  }
                />
                <datalist id="fin-locations">
                  {locations.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </datalist>
              </label>
              <label>
                Effective month
                <input
                  type="month"
                  required
                  disabled={!!editing.expected_revision}
                  value={editing.effective_month.slice(0, 7)}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      effective_month: `${e.target.value}-01`,
                    })
                  }
                />
              </label>
            </div>
            <p className="subtle">
              Rates apply to this calendar month only. Use “Copy to month” for a
              new period. Editing this month creates a new revision and
              recalculates its estimates.
            </p>
            {editing.provider === "Amazon" ? (
              <div className="fin-form-grid">
                {amazonFields.map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      inputMode="decimal"
                      value={editing.rates[key] ?? ""}
                      placeholder="Not supplied"
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          rates: {
                            ...editing.rates,
                            [key]: e.target.value || null,
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            ) : (
              <>
                <label className="fin-label">
                  Monthly slab method
                  <select
                    value={editing.slab_mode}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        slab_mode: e.target.value as PricingInput["slab_mode"],
                      })
                    }
                  >
                    <option value="progressive">
                      Progressive — each band at its rate
                    </option>
                    <option value="all_units">
                      All-units — all deliveries at the reached band’s rate
                    </option>
                  </select>
                </label>
                <p className="subtle">
                  Quantity is the station’s imported total_delivery for the
                  month through the selected date. Lower bounds are exclusive;
                  upper bounds inclusive. Confirm this basis against your client
                  contract. Leave the final upper bound empty.
                </p>
                <div className="fin-table-wrap">
                  <table className="fin-table">
                    <thead>
                      <tr>
                        <th>Above deliveries</th>
                        <th>Up to deliveries</th>
                        <th>₹ / delivery</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {editing.slabs.map((s, i) => (
                        <tr key={i}>
                          {(["above", "upto", "rate"] as const).map((key) => (
                            <td key={key}>
                              <input
                                aria-label={`Slab ${i + 1} ${key}`}
                                inputMode="decimal"
                                value={s[key] ?? ""}
                                placeholder={key === "upto" ? "Unlimited" : ""}
                                onChange={(e) =>
                                  setEditing({
                                    ...editing,
                                    slabs: editing.slabs.map((row, j) =>
                                      j === i
                                        ? {
                                            ...row,
                                            [key]:
                                              e.target.value ||
                                              (key === "upto" ? null : ""),
                                          }
                                        : row,
                                    ),
                                  })
                                }
                              />
                            </td>
                          ))}
                          <td>
                            <button
                              type="button"
                              className="button secondary small"
                              disabled={editing.slabs.length === 1}
                              onClick={() =>
                                setEditing({
                                  ...editing,
                                  slabs: editing.slabs.filter(
                                    (_, j) => j !== i,
                                  ),
                                })
                              }
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    setEditing({
                      ...editing,
                      slabs: [
                        ...editing.slabs,
                        {
                          above: editing.slabs.at(-1)?.upto || "",
                          upto: null,
                          rate: "",
                        },
                      ],
                    })
                  }
                >
                  Add slab
                </button>
              </>
            )}
            <label className="fin-label">
              Reason for change
              <textarea
                required
                maxLength={500}
                value={editing.reason}
                onChange={(e) =>
                  setEditing({ ...editing, reason: e.target.value })
                }
                placeholder="New monthly rate card or reason for correction"
              />
            </label>
            <div className="fin-dialog-footer">
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                onClick={close}
              >
                Cancel
              </button>
              <button className="button" disabled={pending}>
                {pending
                  ? "Saving…"
                  : `Save ${editing.expected_revision ? "new revision" : "rate card"}`}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {upload && (
        <Modal title="Import Amazon MG pricing" onClose={close}>
          <p>
            Upload the original Amazon MG CSV. Review the month and station
            amounts before saving. Existing cards must be edited individually to
            preserve deliberate revision history.
          </p>
          <label className="fin-label">
            Effective month
            <input
              type="month"
              value={importMonth}
              onChange={(e) => {
                importReadVersion.current++;
                setImportMonth(e.target.value);
                setPreview(null);
              }}
              required
            />
          </label>
          <label className="fin-label">
            Amazon MG CSV
            <input
              key={importMonth}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void readFile(e.target.files?.[0])}
            />
          </label>
          {error && (
            <div className="fin-notice error" role="alert">
              {error}
            </div>
          )}
          {preview && (
            <>
              <p>
                <strong>
                  {preview.length} stations · {importMonth}
                </strong>
              </p>
              <div className="fin-table-wrap fin-preview">
                <table className="fin-table">
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th>Monthly MG</th>
                      <th>Delivery MG volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((c) => (
                      <tr key={c.station_code}>
                        <td>{c.station_code}</td>
                        <td>{money(c.rates.mg_amount_including_mhe)}</td>
                        <td>{c.rates.delivery_mg_volume}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="subtle">
                Exact decimal values and blanks are retained. This imports
                pricing, not invoices or expenses.
              </p>
            </>
          )}
          <div className="fin-dialog-footer">
            <button
              className="button secondary"
              disabled={pending}
              onClick={close}
            >
              Cancel
            </button>
            <button
              className="button"
              disabled={pending || !preview}
              onClick={() => preview && save(preview)}
            >
              {pending ? "Importing…" : "Save reviewed import"}
            </button>
          </div>
        </Modal>
      )}
      {historyKey && (
        <Modal title="Rate card details & history" onClose={close}>
          {history
            .filter(
              (c) =>
                `${c.provider}/${c.station_code}/${c.effective_month}` ===
                historyKey,
            )
            .map((c) => (
              <details className="fin-history" key={c.id} open>
                <summary>
                  <strong>
                    {c.station_code} · {c.provider} ·{" "}
                    {c.effective_month.slice(0, 7)} · v{c.revision}
                  </strong>
                </summary>
                <p>{c.reason}</p>
                <p className="subtle">
                  {new Date(c.created_at).toLocaleString("en-IN", {
                    timeZone: "Asia/Kolkata",
                  })}{" "}
                  IST · {c.source_file || "Manual entry"}
                </p>
                {c.provider === "Amazon" ? (
                  <dl className="fin-detail-grid">
                    {amazonFields.map(([key, label]) => (
                      <div key={key}>
                        <dt>{label}</dt>
                        <dd>{c.rates[key] ?? "Not supplied"}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <>
                    <p>
                      {c.slab_mode === "all_units"
                        ? "All-units"
                        : "Progressive"}{" "}
                      monthly delivery slabs
                    </p>
                    <ul>
                      {c.slabs.map((s, i) => (
                        <li key={i}>
                          Above {s.above}, up to {s.upto ?? "unlimited"}: ₹
                          {s.rate} / delivery
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {c.source_sha256 && (
                  <small className="fin-checksum">
                    Source SHA-256: {c.source_sha256}
                  </small>
                )}
              </details>
            ))}
        </Modal>
      )}
    </>
  );
}
