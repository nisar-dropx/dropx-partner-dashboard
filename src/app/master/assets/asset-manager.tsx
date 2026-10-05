"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { bulkRegisterAssets, registerAsset, updateAssetQuantity, uploadAssetAttachment } from "./actions";

type Location = { id: string; label: string };

const patterns: Record<string, string> = {
  "0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw","5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn",
  A:"wnnnnwnnw",B:"nnwnnwnnw",C:"wnwnnwnnn",D:"nnnnwwnnw",E:"wnnnwwnnn",F:"nnwnwwnnn",G:"nnnnnwwnw",H:"wnnnnwwnn",I:"nnwnnwwnn",J:"nnnnwwwnn",K:"wnnnnnnww",L:"nnwnnnnww",M:"wnwnnnnwn",N:"nnnnwnnww",O:"wnnnwnnwn",P:"nnwnwnnwn",Q:"nnnnnnwww",R:"wnnnnnwwn",S:"nnwnnnwwn",T:"nnnnwnwwn",U:"wwnnnnnnw",V:"nwwnnnnnw",W:"wwwnnnnnn",X:"nwnnwnnnw",Y:"wwnnwnnnn",Z:"nwwnwnnnn","-":"nwnnnnwnw","*":"nwnnwnwnn",
};

function Barcode({ code }: { code: string }) {
  let x = 4;
  const bars: ReactNode[] = [];
  for (const character of `*${code.toUpperCase().replace(/[^A-Z0-9-]/g, "-")}*`) {
    for (let i = 0; i < patterns[character].length; i += 1) {
      const width = patterns[character][i] === "w" ? 3 : 1;
      if (i % 2 === 0) bars.push(<rect key={`${x}${i}`} x={x} y="2" width={width} height="24" fill="#111" />);
      x += width;
    }
    x += 1;
  }
  return <span className="asset-label" title={`Code 39 barcode: ${code}`}>
    <svg viewBox={`0 0 ${x + 4} 36`} role="img" aria-label={`Scannable asset barcode ${code}`} preserveAspectRatio="none">
      <rect width="100%" height="100%" fill="white" />{bars}
      <text x={(x + 4) / 2} y="33" textAnchor="middle" fontSize="7" letterSpacing="1">{code}</text>
    </svg>
  </span>;
}

function Modal({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="fin-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="fin-dialog-head"><h2>{title}</h2><button className="button secondary" type="button" onClick={onClose}>Close</button></div>
    {children}
  </dialog>;
}

function money(value: string | number | null) {
  return value == null || value === "" ? "—" : `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function conditionLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const initial = {
  category_name: "", type_name: "", location_id: "", tracking_mode: "individual", quantity_total: "1", quantity_faulty: "0",
  ownership_type: "owned", condition: "good", manufacturer: "", model: "", serial_number: "", invoice_number: "",
  purchase_order_number: "", purchase_date: "", purchase_value: "", gst_rate: "", gst_amount: "", total_value: "",
  vendor_name: "", notes: "", rental_vendor_name: "", rental_agreement_number: "", rental_invoice_number: "",
  rental_rate: "", rental_billing_frequency: "monthly", rental_security_deposit: "0", rental_starts_on: "",
  rental_ends_on: "", rental_notice_period_days: "0",
};

export function AssetManager({ assets, locations, canAdd, canEdit }: { assets: any[]; locations: Location[]; canAdd: boolean; canEdit: boolean }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [attachmentAsset, setAttachmentAsset] = useState<string | null>(null);
  const [quantityAsset, setQuantityAsset] = useState<any | null>(null);
  const [history, setHistory] = useState<any | null>(null);
  const [label, setLabel] = useState<any | null>(null);
  const [batchLabels, setBatchLabels] = useState(false);
  const [labelLocation, setLabelLocation] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [form, setForm] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const shown = useMemo(() => assets.filter((asset) =>
    (filter === "all" || asset.ownership_type === filter)
    && `${asset.asset_code} ${asset.category_name} ${asset.type_name} ${asset.serial_number || ""} ${asset.vendor_name || ""}`
      .toLowerCase().includes(search.toLowerCase().trim())), [assets, filter, search]);

  const totalUnits = (items: any[]) => items.reduce((sum, asset) => sum + (Number(asset.quantity_total) || 1), 0);
  const assetLocation = (asset: any) => locations.find((location) => location.id === asset.location_id)?.label || "Unassigned";
  const update = (key: keyof typeof initial, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const open = (action: () => void) => { setError(""); action(); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError("");
    try {
      const result = await registerAsset(form);
      if (!result.ok) { setError(result.error); return; }
      if (photo) {
        const data = new FormData();
        data.set("asset_id", result.id); data.set("attachment_type", "photo"); data.set("file", photo);
        const attached = await uploadAssetAttachment(data);
        setNotice(attached.ok
          ? `Asset ${result.code} registered with its first photo and system label.`
          : `Asset ${result.code} was registered, but its optional photo needs to be added from history: ${attached.error}`);
      } else setNotice(`Asset ${result.code} registered with its system label.`);
      setEditing(false); setForm(initial); setPhoto(null); router.refresh();
    } catch { setError("Connection interrupted. Refresh before retrying."); }
    finally { setPending(false); }
  }

  async function uploadBulk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    try {
      const result = await bulkRegisterAssets(new FormData(event.currentTarget));
      if (!result.ok) { setError(result.error || "No assets were imported."); return; }
      setBulkOpen(false); setNotice(`${result.imported} asset register records imported with system codes.`); router.refresh();
    } catch { setError("Connection interrupted. Refresh before retrying."); }
    finally { setPending(false); }
  }

  async function uploadEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    try {
      const result = await uploadAssetAttachment(new FormData(event.currentTarget));
      if (!result.ok) { setError(result.error); return; }
      setAttachmentAsset(null); setNotice("Evidence attached to the asset history."); router.refresh();
    } catch { setError("Connection interrupted. Refresh before retrying."); }
    finally { setPending(false); }
  }

  async function updateQuantity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    try {
      const result = await updateAssetQuantity(new FormData(event.currentTarget));
      if (!result.ok) { setError(result.error); return; }
      setQuantityAsset(null); setHistory(null);
      setNotice(`${result.quantities.total} units recorded: ${result.quantities.working} working and ${result.quantities.faulty} faulty / not working.`);
      router.refresh();
    } catch { setError("Connection interrupted. Refresh before retrying."); }
    finally { setPending(false); }
  }

  return <>
    <section className="summary-grid">
      <div className="metric-card"><span>Total asset units</span><strong>{totalUnits(assets)}</strong><small>{assets.length} coded register records</small></div>
      <div className="metric-card"><span>Owned units</span><strong>{totalUnits(assets.filter((asset) => asset.ownership_type === "owned"))}</strong><small>Invoice and value retained</small></div>
      <div className="metric-card"><span>Rented / leased units</span><strong>{totalUnits(assets.filter((asset) => asset.ownership_type !== "owned"))}</strong><small>Rate, terms and off-hire tracked</small></div>
      <div className="metric-card"><span>Faulty / not working</span><strong className={assets.some((asset) => Number(asset.quantity_faulty) > 0) ? "fin-negative" : ""}>{assets.reduce((sum, asset) => sum + (Number(asset.quantity_faulty) || 0), 0)}</strong><small>Physical units requiring attention</small></div>
    </section>

    <div className="fin-toolbar"><div><span className="fin-chip">Finance owned</span> <span className="fin-chip">Individual or quantity</span> <span className="fin-chip">Audit-ready</span></div><div className="fin-actions">
      {canAdd && <><a className="button secondary" href="/master/assets/template">Download template & guide</a><button className="button secondary" type="button" onClick={() => open(() => setBulkOpen(true))}>Bulk upload</button><button className="button" type="button" onClick={() => open(() => setEditing(true))}>Add asset</button></>}
      {canEdit && <button className="button secondary" type="button" onClick={() => open(() => setAttachmentAsset("manual"))}>Attach evidence</button>}
      <button className="button secondary" type="button" disabled={!shown.length} onClick={() => setBatchLabels(true)}>Labels & download</button>
    </div></div>

    {notice && <div className="fin-notice success">{notice}</div>}
    <div className="fin-filters">
      <label>Search register<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Code, type, serial or vendor" /></label>
      <label>Ownership<select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All assets</option><option value="owned">Owned</option><option value="rented">Rented</option><option value="leased">Leased</option></select></label>
      <span className="subtle">{totalUnits(shown)} units · {shown.length} records</span>
    </div>

    <section className="panel"><div className="fin-table-wrap"><table className="fin-table">
      <thead><tr><th>Asset / label</th><th>Category</th><th>Location</th><th>Ownership</th><th>Quantity / condition</th><th>Commercial record</th><th>Evidence & history</th></tr></thead>
      <tbody>{shown.map((asset) => <tr key={asset.id}>
        <td><button className="asset-history-trigger" type="button" onClick={() => setHistory(asset)}><strong>{asset.type_name}{asset.tracking_mode === "quantity" ? ` × ${asset.quantity_total}` : ""}</strong><small>{asset.manufacturer || "Manufacturer not recorded"}{asset.model ? ` · ${asset.model}` : ""}{asset.serial_number ? ` · S/N ${asset.serial_number}` : ""}</small></button><div className="asset-label-row"><Barcode code={asset.barcode_value} /><button className="button secondary small" type="button" onClick={() => setLabel(asset)}>Reprint</button></div></td>
        <td><strong>{asset.category_name}</strong><small>{asset.asset_code}</small></td>
        <td>{assetLocation(asset)}<small>{asset.status.replace(/_/g, " ")}</small></td>
        <td><span className="fin-chip">{asset.ownership_type}</span>{asset.rental_term && <small>{asset.rental_term.vendor_name}<br />{money(asset.rental_term.rental_rate)} / {asset.rental_term.billing_frequency}</small>}</td>
        <td><span className={`fin-chip ${Number(asset.quantity_faulty) > 0 ? "warning" : ""}`}>{conditionLabel(asset.condition)}</span>{asset.tracking_mode === "quantity" ? <small><strong>{asset.quantity_total} total</strong><br />{asset.quantity_working} working · {asset.quantity_faulty} faulty / not working{canEdit && <><br /><button className="asset-history-trigger" type="button" onClick={() => open(() => setQuantityAsset(asset))}>Update count →</button></>}</small> : <small>Individually tracked</small>}</td>
        <td>{asset.ownership_type === "owned" ? <><strong>{money(asset.total_value || asset.purchase_value)}</strong><small>Base {money(asset.purchase_value)}{asset.gst_amount ? ` · GST ${money(asset.gst_amount)}` : ""}<br />{asset.invoice_number || "Invoice not recorded"}</small></> : <><strong>{money(asset.rental_term?.rental_rate || null)} / {asset.rental_term?.billing_frequency || "term"}</strong><small>Deposit {money(asset.rental_term?.security_deposit || null)}</small></>}</td>
        <td><button className="asset-history-trigger subtle" type="button" onClick={() => setHistory(asset)}>{asset.attachments.length} files · {asset.history.length} events<br /><span>View photos, invoices & audit remarks →</span></button></td>
      </tr>)}{!shown.length && <tr><td className="fin-empty" colSpan={7}>No assets match this register view.</td></tr>}</tbody>
    </table></div></section>

    {editing && <Modal title="Register asset" onClose={() => !pending && setEditing(false)}><form onSubmit={submit}>
      <div className="fin-notice"><strong>Choose how this asset is counted.</strong> Use an individual item for separately identified assets such as laptops or vehicles. Use a quantity group for interchangeable assets such as CCTV cameras, chairs, or tools. A quantity group receives one register code and tracks total, working, and faulty units.</div>
      <div className="fin-form-grid">
        <label>Category<input required value={form.category_name} onChange={(event) => update("category_name", event.target.value)} placeholder="IT, security, electrical or furniture" /></label>
        <label>Asset type<input required value={form.type_name} onChange={(event) => update("type_name", event.target.value)} placeholder="Laptop, CCTV camera, worktable…" /></label>
        <label>Location<select value={form.location_id} onChange={(event) => update("location_id", event.target.value)}><option value="">Unassigned / Finance holding</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.label}</option>)}</select></label>
        <label>Record method<select value={form.tracking_mode} onChange={(event) => update("tracking_mode", event.target.value)}><option value="individual">Individual item</option><option value="quantity">Quantity group</option></select></label>
        {form.tracking_mode === "quantity" ? <>
          <label>Total quantity<input required min="1" type="number" inputMode="numeric" value={form.quantity_total} onChange={(event) => update("quantity_total", event.target.value)} /></label>
          <label>Faulty / not working quantity<input required min="0" type="number" inputMode="numeric" value={form.quantity_faulty} onChange={(event) => update("quantity_faulty", event.target.value)} /><span className="subtle">Working: {Math.max(0, (Number(form.quantity_total) || 0) - (Number(form.quantity_faulty) || 0))}</span></label>
        </> : <label>Condition<select value={form.condition} onChange={(event) => update("condition", event.target.value)}><option value="good">Good</option><option value="fair">Fair</option><option value="damaged">Damaged</option><option value="unusable">Unusable</option></select></label>}
        <label>Ownership<select value={form.ownership_type} onChange={(event) => update("ownership_type", event.target.value)}><option value="owned">Owned</option><option value="rented">Rented</option><option value="leased">Leased</option></select></label>
        <label>Asset photo <span className="subtle">Optional</span><input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => setPhoto(event.target.files?.[0] || null)} /></label>
        <label>Make / manufacturer<input value={form.manufacturer} onChange={(event) => update("manufacturer", event.target.value)} /></label>
        <label>Model<input value={form.model} onChange={(event) => update("model", event.target.value)} /></label>
        {form.tracking_mode === "individual" && <label>Serial / chassis number<input value={form.serial_number} onChange={(event) => update("serial_number", event.target.value)} /></label>}
        <label>Vendor / supplier<input value={form.vendor_name} onChange={(event) => update("vendor_name", event.target.value)} /></label>
        <label>Invoice number<input value={form.invoice_number} onChange={(event) => update("invoice_number", event.target.value)} /></label>
        <label>Purchase order number<input value={form.purchase_order_number} onChange={(event) => update("purchase_order_number", event.target.value)} /></label>
        <label>Purchase date<input type="date" value={form.purchase_date} onChange={(event) => update("purchase_date", event.target.value)} /></label>
        <label>Taxable / base value (₹)<input inputMode="decimal" value={form.purchase_value} onChange={(event) => update("purchase_value", event.target.value)} /></label>
        <label>GST rate (%)<input inputMode="decimal" value={form.gst_rate} onChange={(event) => update("gst_rate", event.target.value)} /></label>
        <label>GST amount (₹)<input inputMode="decimal" value={form.gst_amount} onChange={(event) => update("gst_amount", event.target.value)} /></label>
        <label>Total landed value (₹)<input inputMode="decimal" value={form.total_value} onChange={(event) => update("total_value", event.target.value)} /></label>
      </div>
      {form.ownership_type !== "owned" && <><h3 className="asset-form-heading">Rental / lease terms</h3><div className="fin-form-grid">
        <label>Rental vendor<input required value={form.rental_vendor_name} onChange={(event) => update("rental_vendor_name", event.target.value)} /></label>
        <label>Agreement number<input value={form.rental_agreement_number} onChange={(event) => update("rental_agreement_number", event.target.value)} /></label>
        <label>Rental invoice<input value={form.rental_invoice_number} onChange={(event) => update("rental_invoice_number", event.target.value)} /></label>
        <label>Rate (₹)<input required inputMode="decimal" value={form.rental_rate} onChange={(event) => update("rental_rate", event.target.value)} /></label>
        <label>Frequency<select value={form.rental_billing_frequency} onChange={(event) => update("rental_billing_frequency", event.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
        <label>Security deposit (₹)<input inputMode="decimal" value={form.rental_security_deposit} onChange={(event) => update("rental_security_deposit", event.target.value)} /></label>
        <label>Starts on<input required type="date" value={form.rental_starts_on} onChange={(event) => update("rental_starts_on", event.target.value)} /></label>
        <label>Ends on<input type="date" value={form.rental_ends_on} onChange={(event) => update("rental_ends_on", event.target.value)} /></label>
        <label>Notice days<input inputMode="numeric" value={form.rental_notice_period_days} onChange={(event) => update("rental_notice_period_days", event.target.value)} /></label>
      </div></>}
      <label className="fin-label">Notes<textarea value={form.notes} onChange={(event) => update("notes", event.target.value)} /></label>
      {error && <div className="fin-notice error">{error}</div>}
      <div className="fin-dialog-footer"><button type="button" className="button secondary" onClick={() => setEditing(false)}>Cancel</button><button className="button" disabled={pending}>{pending ? "Registering…" : "Register asset & generate label"}</button></div>
    </form></Modal>}

    {bulkOpen && <Modal title="Bulk upload asset register" onClose={() => !pending && setBulkOpen(false)}><form onSubmit={uploadBulk}>
      <div className="fin-notice">The workbook contains individual and quantity-group examples plus a full Instructions tab. Each successful row receives one system code and barcode.</div>
      <label className="fin-label">Completed Asset Register template<input required name="bulk_file" type="file" accept=".xlsx,.xls,.csv" /></label>
      {error && <div className="fin-notice error">{error}</div>}
      <div className="fin-dialog-footer"><a className="button secondary" href="/master/assets/template">Download template & guide</a><button className="button" disabled={pending}>{pending ? "Importing…" : "Import assets"}</button></div>
    </form></Modal>}

    {attachmentAsset && <Modal title="Attach asset evidence" onClose={() => setAttachmentAsset(null)}><form onSubmit={uploadEvidence}>
      <div className="fin-notice">Attach an invoice, agreement, new asset photo, or audit/damage evidence. Every file is retained in the asset history.</div>
      <div className="fin-form-grid"><label>Asset<select required name="asset_id" defaultValue={attachmentAsset === "manual" ? "" : attachmentAsset}><option value="" disabled>Choose coded asset</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.asset_code} · {asset.type_name}{asset.tracking_mode === "quantity" ? ` × ${asset.quantity_total}` : ""}</option>)}</select></label><label>Evidence type<select required name="attachment_type" defaultValue="photo"><option value="invoice">Invoice</option><option value="agreement">Agreement</option><option value="photo">Photo / damage evidence</option><option value="other">Other document</option></select></label></div>
      <label className="fin-label">File<input required name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" /></label>
      {error && <div className="fin-notice error">{error}</div>}
      <div className="fin-dialog-footer"><button type="button" className="button secondary" onClick={() => setAttachmentAsset(null)}>Cancel</button><button className="button" disabled={pending}>{pending ? "Attaching…" : "Attach to history"}</button></div>
    </form></Modal>}

    {quantityAsset && <Modal title={`Update quantity · ${quantityAsset.asset_code}`} onClose={() => !pending && setQuantityAsset(null)}><form onSubmit={updateQuantity}>
      <input type="hidden" name="asset_id" value={quantityAsset.id} />
      <div className="fin-notice">Record the current physical count for this group. Working quantity and overall condition are calculated automatically, and the change is added to the audit history.</div>
      <div className="fin-form-grid"><label>Total quantity<input required name="quantity_total" type="number" inputMode="numeric" min="1" defaultValue={quantityAsset.quantity_total} /></label><label>Faulty / not working quantity<input required name="quantity_faulty" type="number" inputMode="numeric" min="0" defaultValue={quantityAsset.quantity_faulty} /></label></div>
      {error && <div className="fin-notice error">{error}</div>}
      <div className="fin-dialog-footer"><button type="button" className="button secondary" onClick={() => setQuantityAsset(null)}>Cancel</button><button className="button" disabled={pending}>{pending ? "Updating…" : "Save quantity status"}</button></div>
    </form></Modal>}

    {history && <Modal title={`${history.asset_code} · full asset history`} onClose={() => setHistory(null)}><div className="asset-history">
      <div className="asset-history-summary"><Barcode code={history.barcode_value} /><div><strong>{history.type_name}{history.tracking_mode === "quantity" ? ` × ${history.quantity_total}` : ""}</strong><p>{history.category_name} · {history.ownership_type} · {conditionLabel(history.condition)}</p><p>{assetLocation(history)}{history.tracking_mode === "quantity" ? ` · ${history.quantity_working} working · ${history.quantity_faulty} faulty / not working` : ` · serial ${history.serial_number || "not recorded"}`}</p></div></div>
      <div className="fin-actions">{canEdit && history.tracking_mode === "quantity" && <button className="button secondary" type="button" onClick={() => open(() => setQuantityAsset(history))}>Update quantity</button>}<button className="button secondary" type="button" onClick={() => open(() => setAttachmentAsset(history.id))}>Add evidence</button><button className="button secondary" type="button" onClick={() => setLabel(history)}>Reprint label</button></div>
      <h3>Photos and documents</h3>{history.attachments.length ? <div className="asset-attachment-grid">{history.attachments.map((file: any) => <a key={file.id} href={file.signed_url || "#"} target="_blank" rel="noreferrer" className="asset-attachment">{file.content_type?.startsWith("image/") && file.signed_url ? <img src={file.signed_url} alt={`${file.attachment_type} evidence`} /> : <span>Document</span>}<strong>{file.attachment_type}</strong><small>{file.file_name}</small></a>)}</div> : <p className="subtle">No photos or documents attached yet.</p>}
      <h3>Lifecycle and audit history</h3><ol className="asset-timeline">{history.history.map((event: any, index: number) => <li key={`${index}${event.created_at}`}><strong>{conditionLabel(event.event_type)}</strong><small>{event.created_at ? new Date(event.created_at).toLocaleString("en-IN") : "Timestamp unavailable"} · {event.source === "audit" ? "Audit record" : "Lifecycle event"}</small>{event.notes && <p>{event.notes}</p>}</li>)}</ol>
    </div></Modal>}

    {label && <Modal title={`System label · ${label.asset_code}`} onClose={() => setLabel(null)}><div className="asset-print-label"><Barcode code={label.barcode_value} /><strong>{label.asset_code}</strong><span>{label.type_name}{label.tracking_mode === "quantity" ? ` × ${label.quantity_total}` : ""} · {assetLocation(label)}</span></div><p className="subtle">This Code 39 barcode identifies the register record. Quantity groups use one code for the complete group.</p><div className="fin-dialog-footer"><button className="button secondary" type="button" onClick={() => window.print()}>Print / save PDF</button><button className="button" type="button" onClick={() => setLabel(null)}>Done</button></div></Modal>}

    {batchLabels && <Modal title="Print or download system labels" onClose={() => setBatchLabels(false)}><div className="asset-history">
      <label>Location scope<select value={labelLocation} onChange={(event) => setLabelLocation(event.target.value)}><option value="">Current register results ({shown.length})</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.label}</option>)}</select></label>
      <p className="subtle">Choose the current search results or one location. Print from the browser, or choose Save as PDF to download labels.</p>
      <div className="asset-label-sheet">{(labelLocation ? assets.filter((asset) => asset.location_id === labelLocation) : shown).map((asset) => <div className="asset-print-label" key={asset.id}><Barcode code={asset.barcode_value} /><strong>{asset.asset_code}</strong><span>{asset.type_name}{asset.tracking_mode === "quantity" ? ` × ${asset.quantity_total}` : ""} · {assetLocation(asset)}</span></div>)}</div>
      <div className="fin-dialog-footer"><button className="button secondary" type="button" onClick={() => window.print()}>Print / save PDF labels</button><button className="button" type="button" onClick={() => setBatchLabels(false)}>Done</button></div>
    </div></Modal>}
  </>;
}
