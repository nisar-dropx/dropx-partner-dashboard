'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Tab = 'queue' | 'catalog' | 'tally' | 'automation';

type ListedInvoice = {
  draftInvoiceNumber: string;
  batchId: string;
  amzlUniqueId: string;
  serviceArea: string;
  regionName: string;
  status: string;
  approvalStatus: string;
  amount: string;
  portalYmd: string;
  bucket: string;
};

type CatalogRow = {
  draftInvoiceNumber: string;
  batchId: string;
  invoiceNumber: string;
  station: string;
  regionName: string;
  status: string;
  approvalStatus: string;
  amountPaise: number;
  amountText: string;
  portalYmd: string;
  paymentDate: string;
  bucket: string;
  lastSeenAt: string;
  lastAcceptedAt: string | null;
  pdfAvailable: boolean;
};

type RunStatus = {
  runId?: string;
  id?: string;
  from?: string;
  to?: string;
  filesReady?: boolean;
  parsed?: number;
  failed?: number;
  skipped?: number;
  remaining?: number;
  total?: number;
  invoices?: unknown[];
  fileName?: string;
  listingWarnings?: string[];
  error?: string | null;
};

type AcceptOutcome = {
  accepted?: number;
  ready?: number;
  failed?: number;
};

type CatalogSyncOutcome = {
  upserted?: number;
  listed?: number;
  from?: string;
  to?: string;
};

type AutoAcceptTickOutcome = {
  skipped?: boolean;
  reason?: string;
  accepted?: number;
  failed?: number;
};

const TABS: { id: Tab; label: string }[] = [
  { id: 'queue', label: 'Queue' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'tally', label: 'Tally' },
  { id: 'automation', label: 'Automation' },
];

const STATUS_FILTERS: { id: string; label: string; status?: string; approval?: string; bucket?: string }[] = [
  { id: '', label: 'All' },
  { id: 'pending', label: 'Pending', approval: 'PENDING_DSP_ACTION', bucket: 'pending_dsp' },
  { id: 'ready', label: 'Ready', status: 'READY_FOR_PAYMENT_V2', bucket: 'ready' },
  { id: 'paid', label: 'Paid', status: 'PAID_V2', bucket: 'paid' },
  { id: 'disputed', label: 'Disputed', status: 'DISPUTED_V2', bucket: 'disputed' },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/finance/amazon-invoices/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    cache: 'no-store',
  });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return undefined as T;
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function money(paise: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(paise / 100);
}

function formatIst(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function statusKind(status: string, approval: string) {
  const s = `${status} ${approval}`.toUpperCase();
  if (s.includes('PENDING_DSP') || s.includes('AWAITING_REVIEW')) return 'pending';
  if (s.includes('READY') || s.includes('PENDING_PAYMENT')) return 'ready';
  if (s.includes('PAID')) return 'paid';
  if (s.includes('DISPUT')) return 'disputed';
  if (s.includes('HOLD')) return 'hold';
  return '';
}

function chipLabel(status: string, approval: string) {
  const kind = statusKind(status, approval);
  if (kind === 'pending') return 'Pending';
  if (kind === 'ready') return 'Ready';
  if (kind === 'paid') return 'Paid';
  if (kind === 'disputed') return 'Disputed';
  if (kind === 'hold') return 'Hold';
  return approval || status || '—';
}

function StatusChip({ status, approval }: { status: string; approval: string }) {
  return <span className={`ai-chip ${statusKind(status, approval)}`}>{chipLabel(status, approval)}</span>;
}

function runIdOf(status: RunStatus | null | undefined) {
  return status?.runId || status?.id || '';
}

/** Keeps button labels busy until the async work (including polls) actually finishes. */
function useBusyMap() {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const locks = useRef<Set<string>>(new Set());
  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    if (locks.current.has(key)) return;
    locks.current.add(key);
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      await fn();
    } finally {
      locks.current.delete(key);
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  }, []);
  const isBusy = useCallback((key: string) => Boolean(busy[key]), [busy]);
  const anyBusy = Object.values(busy).some(Boolean);
  return { busy, run, isBusy, anyBusy };
}

function ActionButton({
  idleLabel,
  busyLabel,
  busy = false,
  disabled = false,
  onClick,
  type = 'button',
  className,
}: {
  idleLabel: string;
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  type?: 'button' | 'submit';
  className?: string;
}) {
  return (
    <button type={type} className={className} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick}>
      {busy ? busyLabel || 'Working…' : idleLabel}
    </button>
  );
}

function ymdRangeError(from: string, to: string): string | null {
  if (from && to && from > to) return 'From date must be on or before To date.';
  return null;
}

function pdfUrl(draftInvoiceNumber: string) {
  return `/api/finance/amazon-invoices/pdf?draftInvoiceNumber=${encodeURIComponent(draftInvoiceNumber)}`;
}

function PdfPreviewModal({ row, onClose }: { row: CatalogRow; onClose: () => void }) {
  const shellRef = useRef<HTMLElement | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const title = row.invoiceNumber || row.draftInvoiceNumber;
  const fileName = `${(row.invoiceNumber || row.draftInvoiceNumber).replace(/[^\w.-]+/g, '_')}.pdf`;

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    setLoading(true);
    setError('');
    setBlobUrl(null);
    fetch(pdfUrl(row.draftInvoiceNumber), { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `PDF failed (${response.status})`);
        }
        return response.blob();
      })
      .then((blob) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch((err) => {
        if (!revoked) setError(err instanceof Error ? err.message : 'Unable to load PDF.');
      })
      .finally(() => {
        if (!revoked) setLoading(false);
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [row.draftInvoiceNumber]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [onClose]);

  const toggleFullscreen = async () => {
    const node = shellRef.current;
    if (!node) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await node.requestFullscreen();
    } catch {
      setError('Fullscreen is not available in this browser.');
    }
  };

  const download = () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="fp-modal-backdrop ai-pdf-backdrop" onClick={onClose} role="presentation">
      <section
        ref={shellRef}
        className={`fp-modal ai-pdf-modal${fullscreen ? ' ai-pdf-fullscreen' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Invoice PDF ${title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ai-pdf-head">
          <div>
            <p className="fp-eyebrow">INVOICE PDF</p>
            <h2>{title}</h2>
            <p className="ai-muted">
              {row.station || '—'}
              {row.portalYmd ? ` · ${row.portalYmd}` : ''}
              {row.amountPaise ? ` · ${money(row.amountPaise)}` : row.amountText ? ` · ${row.amountText}` : ''}
            </p>
          </div>
          <div className="fp-actions ai-pdf-actions">
            <button type="button" disabled={!blobUrl} onClick={download}>
              Download
            </button>
            <button type="button" disabled={!blobUrl} onClick={() => void toggleFullscreen()}>
              {fullscreen ? 'Exit full screen' : 'Full screen'}
            </button>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="ai-pdf-stage">
          {loading && <p className="ai-muted ai-pdf-status">Loading PDF from Amazon…</p>}
          {error && (
            <p className="fp-warning" role="alert">
              {error}
            </p>
          )}
          {blobUrl && !error && (
            <iframe title={`PDF ${title}`} src={`${blobUrl}#toolbar=1&navpanes=0`} className="ai-pdf-frame" />
          )}
        </div>
      </section>
    </div>
  );
}

function defaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 21 * 24 * 60 * 60 * 1000);
  const ymd = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return { from: ymd(from), to: ymd(to) };
}

export function AmazonInvoicesWorkspace({
  initialTab,
  canEdit,
}: {
  initialTab: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (TABS.some((t) => t.id === initialTab) ? initialTab : 'queue') as Tab;
  const [notice, setNotice] = useState('');
  const [stats, setStats] = useState({ pending: 0, ready: 0, paid: 0, catalog: 0 });

  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/finance/amazon-invoices?${params.toString()}`);
  };

  const refreshStats = useCallback(() => {
    Promise.all([
      api<{ total?: number; invoices?: ListedInvoice[] }>('pending')
        .then((d) => d.total ?? d.invoices?.length ?? 0)
        .catch(() => 0),
      api<{ total: number }>('catalog?bucket=ready&pageSize=1').then((d) => d.total || 0).catch(() => 0),
      api<{ total: number }>('catalog?bucket=paid&pageSize=1').then((d) => d.total || 0).catch(() => 0),
      api<{ total: number }>('catalog?pageSize=1').then((d) => d.total || 0).catch(() => 0),
    ]).then(([pendingCount, ready, paid, catalog]) => setStats({ pending: pendingCount, ready, paid, catalog }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{ total?: number; invoices?: ListedInvoice[] }>('pending')
        .then((d) => d.total ?? d.invoices?.length ?? 0)
        .catch(() => 0),
      api<{ total: number }>('catalog?bucket=ready&pageSize=1').then((d) => d.total || 0).catch(() => 0),
      api<{ total: number }>('catalog?bucket=paid&pageSize=1').then((d) => d.total || 0).catch(() => 0),
      api<{ total: number }>('catalog?pageSize=1').then((d) => d.total || 0).catch(() => 0),
    ]).then(([pendingCount, ready, paid, catalog]) => {
      if (!cancelled) setStats({ pending: pendingCount, ready, paid, catalog });
    });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  return (
    <main className="final-pnl ai-shell">
      <header className="ai-hero">
        <div>
          <p className="fp-eyebrow">DROPX FINANCE / BUSINESS PERFORMANCE</p>
          <h1>Amazon invoices</h1>
          <p>Accept DSP reviews, search the paid register, export Tally files, and keep auto-accept under control — without putting worker keys in the browser.</p>
        </div>
        <div className="fp-actions">
          <Link className="final-pnl" href="/finance/final-pnl" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', border: '1px solid #dce5ea', borderRadius: 7, padding: '9px 13px', fontWeight: 600, color: '#13566d' }}>
            Final P&L
          </Link>
        </div>
      </header>

      <section className="ai-kpis" aria-label="Invoice snapshot">
        <article className={stats.pending ? 'ai-kpi-warn' : ''}>
          <small>Awaiting DSP accept</small>
          <strong>{stats.pending}</strong>
          <span>Live Amazon queue</span>
        </article>
        <article className={stats.ready ? 'ai-kpi-ok' : ''}>
          <small>Ready for payment</small>
          <strong>{stats.ready}</strong>
          <span>From catalog</span>
        </article>
        <article>
          <small>Recently paid</small>
          <strong>{stats.paid}</strong>
          <span>From catalog</span>
        </article>
        <article className={!stats.catalog ? 'ai-kpi-bad' : ''}>
          <small>Catalog rows</small>
          <strong>{stats.catalog}</strong>
          <span>{stats.catalog ? 'Searchable in D1' : 'Sync required'}</span>
        </article>
      </section>

      <nav className="fp-tabs" aria-label="Amazon invoice sections">
        {TABS.map((entry) => (
          <button key={entry.id} aria-pressed={tab === entry.id} onClick={() => setTab(entry.id)}>
            {entry.label}
            {entry.id === 'queue' && stats.pending > 0 ? ` (${stats.pending})` : ''}
          </button>
        ))}
      </nav>

      {notice && (
        <p className="fp-notice" role="status">
          {notice}
        </p>
      )}

      {tab === 'queue' && <QueuePanel canEdit={canEdit} setNotice={setNotice} onChanged={refreshStats} />}
      {tab === 'catalog' && <CatalogPanel canEdit={canEdit} setNotice={setNotice} onChanged={refreshStats} />}
      {tab === 'tally' && <TallyPanel canEdit={canEdit} setNotice={setNotice} />}
      {tab === 'automation' && <AutomationPanel canEdit={canEdit} setNotice={setNotice} onChanged={refreshStats} />}
    </main>
  );
}

function QueuePanel({
  canEdit,
  setNotice,
  onChanged,
}: {
  canEdit: boolean;
  setNotice: (value: string) => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ListedInvoice[]>([]);
  const [readyRows, setReadyRows] = useState<CatalogRow[]>([]);
  const [paidRows, setPaidRows] = useState<CatalogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { run, isBusy, anyBusy } = useBusyMap();
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [pendingData, readyData, paidData] = await Promise.all([
        api<{ invoices?: ListedInvoice[]; total?: number }>('pending'),
        api<{ rows: CatalogRow[] }>('catalog?bucket=ready&pageSize=25&sort=portal_ymd_desc'),
        api<{ rows: CatalogRow[] }>('catalog?bucket=paid&pageSize=25&sort=portal_ymd_desc'),
      ]);
      setRows(pendingData.invoices || []);
      setReadyRows(readyData.rows || []);
      setPaidRows(paidData.rows || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load queue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const acceptOne = (row: ListedInvoice) => {
    void run(`accept:${row.draftInvoiceNumber}`, async () => {
      setRowBusy(row.draftInvoiceNumber);
      setNotice('');
      try {
        await api('accept', {
          method: 'POST',
          body: JSON.stringify({
            draftInvoiceNumber: row.draftInvoiceNumber,
            batchId: row.batchId,
            verifyReady: true,
          }),
        });
        setNotice(`Accepted ${row.amzlUniqueId || row.draftInvoiceNumber}`);
        await load();
        onChanged();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Accept failed.');
      } finally {
        setRowBusy(null);
      }
    });
  };

  const acceptAll = () => {
    if (!rows.length) return;
    void run('accept-all', async () => {
      setNotice('');
      try {
        const result = await api<AcceptOutcome>('accept', {
          method: 'POST',
          body: JSON.stringify({
            invoices: rows.slice(0, 50).map((row) => ({
              draftInvoiceNumber: row.draftInvoiceNumber,
              batchId: row.batchId,
            })),
            verifyReady: true,
          }),
        });
        setNotice(`Accepted ${result.accepted || 0} · ready ${result.ready || 0} · failed ${result.failed || 0}`);
        await load();
        onChanged();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Accept all failed.');
      }
    });
  };

  const readyCheck = (row: { draftInvoiceNumber: string; batchId: string; amzlUniqueId?: string; invoiceNumber?: string }) => {
    void run(`ready:${row.draftInvoiceNumber}`, async () => {
      setRowBusy(row.draftInvoiceNumber);
      setNotice('');
      try {
        const params = new URLSearchParams({ draftInvoiceNumber: row.draftInvoiceNumber });
        if (row.batchId) params.set('batchId', row.batchId);
        const result = await api<{
          ready?: boolean;
          batchStatus?: string;
          draftStatus?: string;
        }>(`ready-check?${params}`);
        const label = row.amzlUniqueId || row.invoiceNumber || row.draftInvoiceNumber;
        setNotice(
          result.ready
            ? `${label} is ready for payment`
            : `${label} not ready yet (${result.batchStatus || result.draftStatus || 'unknown'})`,
        );
        await load();
        onChanged();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Ready check failed.');
      } finally {
        setRowBusy(null);
      }
    });
  };

  return (
    <div className="ai-stack">
      <section className="fp-panel">
        <div className="ai-card-head">
          <div>
            <h2>Pending DSP accept</h2>
            <p>Live Amazon queue for invoices waiting on DSP review. Disputed and AMZL-pending stay out.</p>
          </div>
          <div className="fp-actions">
            <span className="ai-section-count">{rows.length} open</span>
            <ActionButton
              idleLabel="Refresh"
              busyLabel="Refreshing…"
              busy={isBusy('refresh')}
              disabled={loading || (anyBusy && !isBusy('refresh'))}
              onClick={() => void run('refresh', load)}
            />
            <ActionButton
              idleLabel="Accept all pending"
              busyLabel="Accepting…"
              busy={isBusy('accept-all')}
              disabled={!canEdit || !rows.length || (anyBusy && !isBusy('accept-all'))}
              onClick={acceptAll}
            />
          </div>
        </div>
        {loading && <p className="ai-muted">Loading live queue…</p>}
        {error && (
          <p className="fp-warning" role="alert">
            {error}
          </p>
        )}
        {!loading && !rows.length && !error ? (
          <div className="ai-empty">
            <strong>Queue is clear</strong>
            <p>No invoices are waiting for DSP accept right now. Auto-accept will keep watching every 2 hours.</p>
          </div>
        ) : rows.length ? (
          <div className="ai-scroll">
            <table className="ai-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Station</th>
                  <th>Region</th>
                  <th>Portal date</th>
                  <th className="ai-money">Amount</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const thisBusy = rowBusy === row.draftInvoiceNumber;
                  return (
                    <tr key={row.draftInvoiceNumber}>
                      <td>
                        <strong>{row.amzlUniqueId || '—'}</strong>
                        <small>{row.draftInvoiceNumber}</small>
                      </td>
                      <td>{row.serviceArea || '—'}</td>
                      <td>{row.regionName || '—'}</td>
                      <td>{row.portalYmd || '—'}</td>
                      <td className="ai-money">{row.amount || '—'}</td>
                      <td>
                        <StatusChip status={row.status} approval={row.approvalStatus} />
                      </td>
                      <td>
                        <div className="ai-row-actions">
                          <ActionButton
                            idleLabel="Accept"
                            busyLabel="Accepting…"
                            busy={thisBusy && isBusy(`accept:${row.draftInvoiceNumber}`)}
                            disabled={!canEdit || anyBusy}
                            onClick={() => acceptOne(row)}
                          />
                          <ActionButton
                            idleLabel="Ready check"
                            busyLabel="Checking…"
                            busy={thisBusy && isBusy(`ready:${row.draftInvoiceNumber}`)}
                            disabled={anyBusy}
                            onClick={() => readyCheck(row)}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <CatalogSlice
        title="Ready for payment"
        subtitle="Accepted invoices waiting for Amazon settlement. Sourced from the D1 catalog."
        rows={readyRows}
        empty="No ready-for-payment invoices in the catalog yet. Sync the catalog or accept a pending invoice."
        onReadyCheck={readyCheck}
        busy={anyBusy}
        busyDraft={rowBusy}
      />

      <CatalogSlice
        title="Recently paid"
        subtitle="Latest paid invoices from the catalog register."
        rows={paidRows}
        empty="No paid invoices in the catalog yet. Run Sync catalog on the Catalog tab."
      />
    </div>
  );
}

function CatalogSlice({
  title,
  subtitle,
  rows,
  empty,
  onReadyCheck,
  busy = false,
  busyDraft = null,
}: {
  title: string;
  subtitle: string;
  rows: CatalogRow[];
  empty: string;
  onReadyCheck?: (row: CatalogRow) => void;
  busy?: boolean;
  busyDraft?: string | null;
}) {
  return (
    <section className="fp-panel">
      <div className="ai-card-head">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <span className="ai-section-count">{rows.length} shown</span>
      </div>
      {!rows.length ? (
        <div className="ai-empty">
          <strong>{title}</strong>
          <p>{empty}</p>
        </div>
      ) : (
        <div className="ai-scroll">
          <table className="ai-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Station</th>
                <th>Portal</th>
                <th className="ai-money">Amount</th>
                <th>Status</th>
                <th>Payment</th>
                {onReadyCheck ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.draftInvoiceNumber}>
                  <td>
                    <strong>{row.invoiceNumber || '—'}</strong>
                    <small>{row.draftInvoiceNumber}</small>
                  </td>
                  <td>{row.station || '—'}</td>
                  <td>{row.portalYmd || '—'}</td>
                  <td className="ai-money">{row.amountPaise ? money(row.amountPaise) : row.amountText || '—'}</td>
                  <td>
                    <StatusChip status={row.status} approval={row.approvalStatus} />
                  </td>
                  <td>{row.paymentDate || '—'}</td>
                  {onReadyCheck ? (
                    <td>
                      <ActionButton
                        idleLabel="Ready check"
                        busyLabel="Checking…"
                        busy={busyDraft === row.draftInvoiceNumber}
                        disabled={busy && busyDraft !== row.draftInvoiceNumber}
                        onClick={() => onReadyCheck(row)}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CatalogPanel({
  canEdit,
  setNotice,
  onChanged,
}: {
  canEdit: boolean;
  setNotice: (value: string) => void;
  onChanged: () => void;
}) {
  const defaults = useMemo(() => defaultRange(), []);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [filterId, setFilterId] = useState('');
  const [station, setStation] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState('portal_ymd_desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncFrom, setSyncFrom] = useState(defaults.from);
  const [syncTo, setSyncTo] = useState(defaults.to);
  const [reloadToken, setReloadToken] = useState(0);
  const [pdfRow, setPdfRow] = useState<CatalogRow | null>(null);
  const { run, isBusy } = useBusyMap();
  const filterRangeError = ymdRangeError(from, to);
  const syncRangeError = ymdRangeError(syncFrom, syncTo);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, filterId, station, from, to, sort, pageSize]);

  useEffect(() => {
    if (filterRangeError) {
      setLoading(false);
      setError(filterRangeError);
      setRows([]);
      setTotal(0);
      return;
    }
    const selected = STATUS_FILTERS.find((f) => f.id === filterId);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sort,
    });
    if (debouncedQ) params.set('q', debouncedQ);
    if (selected?.status) params.set('status', selected.status);
    if (selected?.approval && !selected.status) params.set('approvalStatus', selected.approval);
    if (selected?.bucket && selected.id !== 'pending') params.set('bucket', selected.bucket);
    if (selected?.id === 'pending') params.set('bucket', 'pending_dsp');
    if (station) params.set('station', station);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    let cancelled = false;
    setLoading(true);
    setError('');
    api<{ total: number; rows: CatalogRow[] }>(`catalog?${params}`)
      .then((data) => {
        if (cancelled) return;
        setTotal(data.total || 0);
        setRows(data.rows || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Catalog unavailable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, filterId, station, from, to, sort, page, pageSize, reloadToken, filterRangeError]);

  const lastPage = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Math.min(page, lastPage);

  useEffect(() => {
    if (page > lastPage) setPage(lastPage);
  }, [page, lastPage]);

  const clearFilters = () => {
    setQ('');
    setFilterId('');
    setStation('');
    setFrom('');
    setTo('');
    setSort('portal_ymd_desc');
  };

  const syncCatalog = (rangeFrom = syncFrom, rangeTo = syncTo) => {
    const rangeErr = ymdRangeError(rangeFrom, rangeTo);
    if (rangeErr) {
      setNotice(rangeErr);
      return;
    }
    void run('sync', async () => {
      setNotice('');
      try {
        const result = await api<CatalogSyncOutcome>('catalog/sync', {
          method: 'POST',
          body: JSON.stringify({ from: rangeFrom || undefined, to: rangeTo || undefined }),
        });
        setNotice(
          `Catalog synced · ${result.upserted || 0} invoices (${result.from || rangeFrom} → ${result.to || rangeTo})`,
        );
        setPage(1);
        setFilterId('');
        setReloadToken((n) => n + 1);
        onChanged();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Catalog sync failed.');
      }
    });
  };

  const syncing = isBusy('sync');

  return (
    <section className="fp-panel">
      {pdfRow && <PdfPreviewModal row={pdfRow} onClose={() => setPdfRow(null)} />}
      <div className="ai-card-head">
        <div>
          <h2>Invoice catalog</h2>
          <p>Search the D1 register. Filters never call Amazon. Sync pulls a date range into the register once.</p>
        </div>
        <span className="ai-section-count">{total} matching</span>
      </div>

      <div className="ai-toolbar">
        <label className="ai-grow">
          Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="INV-… / station / draft id" disabled={syncing} />
        </label>
        <label>
          Station
          <input value={station} onChange={(e) => setStation(e.target.value.toUpperCase())} placeholder="RPRN" disabled={syncing} />
        </label>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} disabled={syncing} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} disabled={syncing} />
        </label>
        <label>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)} disabled={syncing}>
            <option value="portal_ymd_desc">Portal date ↓</option>
            <option value="portal_ymd_asc">Portal date ↑</option>
            <option value="invoice_number_asc">Invoice ↑</option>
            <option value="amount_desc">Amount ↓</option>
            <option value="station_asc">Station</option>
            <option value="status_asc">Status</option>
            <option value="last_seen_desc">Last seen</option>
          </select>
        </label>
        <label>
          Page size
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} disabled={syncing}>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
        <button type="button" onClick={clearFilters} disabled={syncing}>
          Clear
        </button>
      </div>

      <div className="ai-status-pills" role="group" aria-label="Status filter">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.id || 'all'}
            aria-pressed={filterId === filter.id}
            disabled={syncing}
            onClick={() => setFilterId(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className="ai-toolbar">
        <label>
          Sync from
          <input type="date" value={syncFrom} onChange={(e) => setSyncFrom(e.target.value)} disabled={syncing} />
        </label>
        <label>
          Sync to
          <input type="date" value={syncTo} onChange={(e) => setSyncTo(e.target.value)} disabled={syncing} />
        </label>
        <ActionButton
          idleLabel="Sync catalog from Amazon"
          busyLabel="Syncing…"
          busy={syncing}
          disabled={!canEdit || Boolean(syncRangeError)}
          onClick={() => syncCatalog()}
        />
        <span className="ai-muted">
          {syncRangeError || 'Lists invoices only — no PDF download, no Tally rebuild.'}
        </span>
      </div>

      {loading && <p className="ai-muted">Loading catalog…</p>}
      {error && (
        <p className="fp-warning" role="alert">
          {error}
        </p>
      )}

      {!loading && !rows.length && !error ? (
        <div className="ai-empty">
          <strong>No catalog rows yet</strong>
          <p>
            The searchable register is empty for these filters. Sync the last 21 days from Amazon, or clear filters if a
            sync already ran.
          </p>
          <div className="fp-actions">
            <ActionButton
              idleLabel="Sync last 21 days"
              busyLabel="Syncing…"
              busy={syncing}
              disabled={!canEdit}
              onClick={() => syncCatalog(defaults.from, defaults.to)}
            />
            <button type="button" onClick={clearFilters} disabled={syncing}>
              Clear filters
            </button>
          </div>
        </div>
      ) : rows.length ? (
        <div className="ai-scroll">
          <table className="ai-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Station</th>
                <th>Region</th>
                <th>Portal</th>
                <th className="ai-money">Amount</th>
                <th>Status</th>
                <th>Payment</th>
                <th>PDF</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.draftInvoiceNumber}>
                  <td>
                    <strong>{row.invoiceNumber || '—'}</strong>
                    <small>{row.draftInvoiceNumber}</small>
                  </td>
                  <td>{row.station || '—'}</td>
                  <td>{row.regionName || '—'}</td>
                  <td>{row.portalYmd || '—'}</td>
                  <td className="ai-money">{row.amountPaise ? money(row.amountPaise) : row.amountText || '—'}</td>
                  <td>
                    <StatusChip status={row.status} approval={row.approvalStatus} />
                  </td>
                  <td>{row.paymentDate || '—'}</td>
                  <td>
                    <button type="button" disabled={syncing} onClick={() => setPdfRow(row)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="ai-pager">
        <button disabled={safePage <= 1 || loading || syncing} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          Previous
        </button>
        <span>
          Page {safePage} / {lastPage}
        </span>
        <button disabled={safePage >= lastPage || loading || syncing} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
      </div>
    </section>
  );
}

function TallyPanel({ canEdit, setNotice }: { canEdit: boolean; setNotice: (value: string) => void }) {
  const defaults = useMemo(() => defaultRange(), []);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState('');
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const { run, isBusy, anyBusy } = useBusyMap();
  const rangeError = ymdRangeError(from, to);
  const building = isBusy('build');
  const refreshing = isBusy('refresh');

  const loadStatus = useCallback(async () => {
    try {
      const data = await api<RunStatus>('status');
      setStatus(data);
      setError('');
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No export run yet.');
      return null;
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const pollUntilReady = async (id?: string) => {
    const started = Date.now();
    let delay = 2000;
    while (Date.now() - started < 180000) {
      const data = await api<RunStatus>(`status${id ? `?runId=${encodeURIComponent(id)}` : ''}`);
      setStatus(data);
      if (data.filesReady) {
        setNotice('Tally export files are ready.');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay + 500, 3000);
    }
    setNotice('Export is still running in the background. Refresh status later.');
  };

  const buildExport = () => {
    if (rangeError) {
      setNotice(rangeError);
      return;
    }
    void run('build', async () => {
      setNotice('');
      setError('');
      try {
        const data = await api<RunStatus>('export', {
          method: 'POST',
          body: JSON.stringify({ from: from || undefined, to: to || undefined }),
        });
        setStatus(data);
        const id = runIdOf(data);
        if (data.filesReady) {
          setNotice('Export ready.');
          return;
        }
        setNotice('Export started…');
        await pollUntilReady(id);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Export failed.');
      }
    });
  };

  const download = (format: string) => {
    const id = runIdOf(status);
    if (!id || !status?.filesReady) {
      setNotice('Export files are not ready yet.');
      return;
    }
    const runQuery = `&runId=${encodeURIComponent(id)}`;
    window.open(`/api/finance/amazon-invoices/download?format=${format}${runQuery}`, '_blank', 'noopener,noreferrer');
  };

  const progress = useMemo(() => {
    const total = status?.total || status?.invoices?.length || 0;
    if (!total) return status?.filesReady ? 'Complete' : '—';
    const done = (status?.parsed || 0) + (status?.failed || 0) + (status?.skipped || 0);
    return `${done} / ${total}`;
  }, [status]);

  const id = runIdOf(status);

  return (
    <section className="fp-panel">
      <div className="ai-card-head">
        <div>
          <h2>Tally export</h2>
          <p>Monday 07:30 IST builds the last 21 days. Use this panel for an on-demand range — status polls gently until files are ready.</p>
        </div>
        <ActionButton
          idleLabel="Refresh status"
          busyLabel="Refreshing…"
          busy={refreshing}
          disabled={anyBusy && !refreshing}
          onClick={() => void run('refresh', async () => { await loadStatus(); })}
        />
      </div>

      {error && <p className="ai-muted">{error}</p>}
      {status?.error && (
        <p className="fp-warning" role="alert">
          {status.error}
        </p>
      )}

      <div className="ai-meta">
        <article>
          <small>Run</small>
          <strong>{id ? id.slice(0, 8) : '—'}</strong>
          <span>
            {status?.from || '—'} → {status?.to || '—'}
          </span>
        </article>
        <article className={status?.filesReady ? 'ai-kpi-ok' : ''}>
          <small>Progress</small>
          <strong>{progress}</strong>
          <span>
            {status?.filesReady
              ? 'Files ready'
              : building
                ? 'Working…'
                : status?.remaining != null
                  ? `${status.remaining} remaining`
                  : 'Not ready'}
          </span>
        </article>
        <article>
          <small>File</small>
          <strong className="ai-file">{status?.fileName || '—'}</strong>
        </article>
      </div>

      <div className="fp-actions" style={{ marginBottom: 14, justifyContent: 'flex-start' }}>
        <button disabled={!status?.filesReady || building} onClick={() => download('xlsx')}>
          Download xlsx
        </button>
        <button disabled={!status?.filesReady || building} onClick={() => download('tally-entries')}>
          Tally entries CSV
        </button>
        <button disabled={!status?.filesReady || building} onClick={() => download('tally-sales')}>
          Tally sales CSV
        </button>
        <button disabled={!status?.filesReady || building} onClick={() => download('components')}>
          Components CSV
        </button>
      </div>

      <div className="ai-toolbar">
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} disabled={building} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} disabled={building} />
        </label>
        <ActionButton
          idleLabel="Build export"
          busyLabel="Building…"
          busy={building}
          disabled={!canEdit || Boolean(rangeError) || (anyBusy && !building)}
          onClick={buildExport}
        />
        {rangeError ? <span className="ai-muted">{rangeError}</span> : null}
      </div>

      {!!status?.listingWarnings?.length && (
        <details className="fp-coverage">
          <summary>
            Listing warnings <span>{status.listingWarnings.length}</span>
          </summary>
          <ul>
            {status.listingWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function AutomationPanel({
  canEdit,
  setNotice,
  onChanged,
}: {
  canEdit: boolean;
  setNotice: (value: string) => void;
  onChanged: () => void;
}) {
  const defaults = useMemo(() => defaultRange(), []);
  const [autoAcceptEnabled, setAutoAcceptEnabled] = useState(true);
  const [lastAcceptRun, setLastAcceptRun] = useState<string | null>(null);
  const [lastCatalogSync, setLastCatalogSync] = useState<string | null>(null);
  const [lastTallyRunId, setLastTallyRunId] = useState<string | null>(null);
  const [session, setSession] = useState<{ hasSession?: boolean; savedAt?: string | null; probe?: string } | null>(null);
  const [recent, setRecent] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState('');
  const { run, isBusy, anyBusy } = useBusyMap();

  const load = useCallback(async () => {
    try {
      const [automation, sessionStatus] = await Promise.all([
        api<{
          autoAcceptEnabled: boolean;
          lastAcceptRun: string | null;
          lastCatalogSync: string | null;
          lastTallyRunId: string | null;
          recentAccepts: Array<Record<string, unknown>>;
        }>('automation'),
        api<{ hasSession?: boolean; savedAt?: string | null; probe?: string }>('session/status').catch(() => null),
      ]);
      setAutoAcceptEnabled(automation.autoAcceptEnabled);
      setLastAcceptRun(automation.lastAcceptRun);
      setLastCatalogSync(automation.lastCatalogSync);
      setLastTallyRunId(automation.lastTallyRunId);
      setRecent(automation.recentAccepts || []);
      setSession(sessionStatus);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Automation status unavailable.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (enabled: boolean) => {
    void run('toggle', async () => {
      setNotice('');
      try {
        await api('automation', {
          method: 'PUT',
          body: JSON.stringify({ autoAcceptEnabled: enabled }),
        });
        setAutoAcceptEnabled(enabled);
        setNotice(enabled ? 'Auto-accept enabled.' : 'Auto-accept disabled.');
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Unable to update kill switch.');
      }
    });
  };

  const runNow = () => {
    void run('tick', async () => {
      setNotice('');
      try {
        const result = await api<AutoAcceptTickOutcome>('auto-accept-tick', { method: 'POST', body: '{}' });
        setNotice(
          result.skipped
            ? `Skipped: ${result.reason || 'unknown'}`
            : `Tick done · accepted ${result.accepted || 0} · failed ${result.failed || 0}`,
        );
        await load();
        onChanged();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Auto-accept tick failed.');
      }
    });
  };

  const ensureSession = () => {
    void run('probe', async () => {
      setNotice('');
      try {
        await api('session/ensure', { method: 'POST', body: JSON.stringify({ force: false }) });
        setNotice('Session probe completed.');
        await load();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Session probe failed.');
      }
    });
  };

  const syncCatalog = () => {
    void run('sync', async () => {
      setNotice('');
      try {
        const result = await api<CatalogSyncOutcome>('catalog/sync', {
          method: 'POST',
          body: JSON.stringify({ from: defaults.from, to: defaults.to }),
        });
        setNotice(`Catalog synced · ${result.upserted || 0} invoices`);
        await load();
        onChanged();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Catalog sync failed.');
      }
    });
  };

  let lastAcceptSummary = '—';
  let lastAcceptAt = '';
  try {
    if (lastAcceptRun) {
      const parsed = JSON.parse(lastAcceptRun) as {
        at?: string;
        accepted?: number;
        failed?: number;
        reason?: string;
        attempted?: number;
      };
      lastAcceptAt = parsed.at || '';
      lastAcceptSummary =
        [
          parsed.accepted != null ? `accepted ${parsed.accepted}` : null,
          parsed.attempted != null ? `attempted ${parsed.attempted}` : null,
          parsed.failed ? `failed ${parsed.failed}` : null,
          parsed.reason || null,
        ]
          .filter(Boolean)
          .join(' · ') || 'Recorded';
    }
  } catch {
    lastAcceptSummary = lastAcceptRun || '—';
  }

  const sessionLabel =
    session?.probe === 'ok'
      ? 'Healthy'
      : session?.probe === 'expired'
        ? 'Expired'
        : session?.hasSession
          ? 'Present'
          : 'Missing';

  return (
    <section className="fp-panel">
      <div className="ai-card-head">
        <div>
          <h2>Automation</h2>
          <p>
            Auto-accept runs every 2 hours at :15 UTC for pending DSP invoices only (cap 25 / tick). Monday 07:30 IST
            rebuilds Tally. Final P&L syncs daily at 08:00 IST.
          </p>
        </div>
        <div className="fp-actions">
          <ActionButton
            idleLabel="Probe session"
            busyLabel="Probing…"
            busy={isBusy('probe')}
            disabled={!canEdit || (anyBusy && !isBusy('probe'))}
            onClick={ensureSession}
          />
          <ActionButton
            idleLabel="Sync catalog"
            busyLabel="Syncing…"
            busy={isBusy('sync')}
            disabled={!canEdit || (anyBusy && !isBusy('sync'))}
            onClick={syncCatalog}
          />
          <ActionButton
            idleLabel="Run accept now"
            busyLabel="Running…"
            busy={isBusy('tick')}
            disabled={!canEdit || (anyBusy && !isBusy('tick'))}
            onClick={runNow}
          />
        </div>
      </div>

      {error && (
        <p className="fp-warning" role="alert">
          {error}
        </p>
      )}

      <div className="ai-meta">
        <article className={autoAcceptEnabled ? 'ai-kpi-ok' : 'ai-kpi-warn'}>
          <small>Auto-accept</small>
          <strong>{autoAcceptEnabled ? 'On' : 'Off'}</strong>
          <div className="ai-toggle" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="ai-toggle-track"
              aria-checked={autoAcceptEnabled}
              disabled={!canEdit || anyBusy}
              onClick={() => toggle(!autoAcceptEnabled)}
              aria-label={autoAcceptEnabled ? 'Turn auto-accept off' : 'Turn auto-accept on'}
            >
              <span className="ai-toggle-thumb" />
            </button>
            <span className="ai-muted">
              {isBusy('toggle') ? 'Updating…' : autoAcceptEnabled ? 'Kill switch open' : 'Kill switch engaged'}
            </span>
          </div>
        </article>
        <article className={session?.probe === 'ok' ? 'ai-kpi-ok' : 'ai-kpi-warn'}>
          <small>Amazon session</small>
          <strong>{sessionLabel}</strong>
          <span>{formatIst(session?.savedAt)}</span>
        </article>
        <article>
          <small>Last accept run</small>
          <strong style={{ fontSize: 13 }}>{lastAcceptSummary}</strong>
          <span>{formatIst(lastAcceptAt)}</span>
        </article>
        <article className={!lastCatalogSync ? 'ai-kpi-warn' : ''}>
          <small>Last catalog sync</small>
          <strong style={{ fontSize: 13 }}>{lastCatalogSync ? formatIst(lastCatalogSync) : 'Never'}</strong>
          <span>D1 register refresh</span>
        </article>
        <article>
          <small>Latest Tally run</small>
          <strong className="ai-file" style={{ fontSize: 12 }}>
            {lastTallyRunId ? lastTallyRunId.slice(0, 8) : '—'}
          </strong>
          <span>{lastTallyRunId || 'No export yet'}</span>
        </article>
      </div>

      <div className="ai-card-head" style={{ marginTop: 8 }}>
        <div>
          <h2>Recent accepts</h2>
          <p>Audit trail from cron and manual accepts.</p>
        </div>
      </div>
      {!recent.length ? (
        <div className="ai-empty">
          <strong>No accept audit yet</strong>
          <p>When auto-accept or Queue accept runs, results appear here with actor and outcome.</p>
        </div>
      ) : (
        <div className="ai-scroll">
          <table className="ai-table">
            <thead>
              <tr>
                <th>When (IST)</th>
                <th>Invoice</th>
                <th>Actor</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row, index) => (
                <tr key={`${row.at}-${index}`}>
                  <td>{formatIst(String(row.at || ''))}</td>
                  <td>{String(row.invoice_number || row.draft_invoice_number || '—')}</td>
                  <td>{String(row.actor || '—')}</td>
                  <td>
                    {row.error ? (
                      <span className="ai-chip disputed">Error</span>
                    ) : row.accepted ? (
                      <span className="ai-chip ready">Accepted</span>
                    ) : row.ready ? (
                      <span className="ai-chip ready">Ready</span>
                    ) : (
                      <span className="ai-chip">Skipped</span>
                    )}
                    {row.error ? <small>{String(row.error)}</small> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="ai-muted" style={{ marginTop: 14 }}>
        Related: <Link href="/finance/final-pnl">Final P&L</Link>
      </p>
    </section>
  );
}
