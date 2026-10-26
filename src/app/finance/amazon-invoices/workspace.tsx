'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';

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
  id?: string;
  from?: string;
  to?: string;
  filesReady?: boolean;
  parsed?: number;
  failed?: number;
  skipped?: number;
  nextIndex?: number;
  invoices?: unknown[];
  fileName?: string;
  listingWarnings?: string[];
};

const TABS: { id: Tab; label: string }[] = [
  { id: 'queue', label: 'Queue' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'tally', label: 'Tally' },
  { id: 'automation', label: 'Automation' },
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
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
}

function statusChip(status: string, approval: string) {
  const s = `${status} ${approval}`.toUpperCase();
  if (s.includes('PENDING_DSP') || s.includes('AWAITING_REVIEW')) return 'pending';
  if (s.includes('READY') || s.includes('PENDING_PAYMENT')) return 'ready';
  if (s.includes('PAID')) return 'paid';
  if (s.includes('DISPUT')) return 'disputed';
  if (s.includes('HOLD')) return 'hold';
  return '';
}

function chipLabel(status: string, approval: string) {
  const kind = statusChip(status, approval);
  if (kind === 'pending') return 'Pending';
  if (kind === 'ready') return 'Ready';
  if (kind === 'paid') return 'Paid';
  if (kind === 'disputed') return 'Disputed';
  if (kind === 'hold') return 'Hold';
  return approval || status || '—';
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
  const [pending, startTransition] = useTransition();

  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/finance/amazon-invoices?${params.toString()}`);
  };

  return (
    <main className="final-pnl">
      <header className="fp-header">
        <div>
          <p className="fp-eyebrow">DROPX FINANCE / BUSINESS PERFORMANCE</p>
          <h1>Amazon invoices</h1>
          <p>Accept pending DSP invoices, search the register, export Tally files, and control auto-accept.</p>
        </div>
      </header>

      <nav className="fp-tabs" aria-label="Amazon invoice sections">
        {TABS.map((entry) => (
          <button key={entry.id} aria-pressed={tab === entry.id} onClick={() => setTab(entry.id)}>
            {entry.label}
          </button>
        ))}
      </nav>

      {notice && (
        <p className="fp-notice" role="status">
          {notice}
        </p>
      )}

      {tab === 'queue' && <QueuePanel canEdit={canEdit} pending={pending} startTransition={startTransition} setNotice={setNotice} />}
      {tab === 'catalog' && <CatalogPanel setNotice={setNotice} />}
      {tab === 'tally' && <TallyPanel canEdit={canEdit} pending={pending} startTransition={startTransition} setNotice={setNotice} />}
      {tab === 'automation' && <AutomationPanel canEdit={canEdit} pending={pending} startTransition={startTransition} setNotice={setNotice} />}
    </main>
  );
}

function QueuePanel({
  canEdit,
  pending,
  startTransition,
  setNotice,
}: {
  canEdit: boolean;
  pending: boolean;
  startTransition: (fn: () => void) => void;
  setNotice: (value: string) => void;
}) {
  const [rows, setRows] = useState<ListedInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api<{ invoices: ListedInvoice[] }>('pending')
      .then((data) => setRows(data.invoices || []))
      .catch((err) => setError(err instanceof Error ? err.message : 'Unable to load pending invoices.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const acceptOne = (row: ListedInvoice) =>
    startTransition(() => {
      setNotice('');
      void api('accept', {
        method: 'POST',
        body: JSON.stringify({
          draftInvoiceNumber: row.draftInvoiceNumber,
          batchId: row.batchId,
          verifyReady: true,
        }),
      })
        .then(() => {
          setNotice(`Accepted ${row.amzlUniqueId || row.draftInvoiceNumber}`);
          load();
        })
        .catch((err) => setNotice(err instanceof Error ? err.message : 'Accept failed.'));
    });

  const acceptAll = () =>
    startTransition(() => {
      setNotice('');
      void api('accept', {
        method: 'POST',
        body: JSON.stringify({
          invoices: rows.slice(0, 50).map((row) => ({
            draftInvoiceNumber: row.draftInvoiceNumber,
            batchId: row.batchId,
          })),
          verifyReady: true,
        }),
      })
        .then((result: any) => {
          setNotice(`Accepted ${result.accepted || 0} · ready ${result.ready || 0} · failed ${result.failed || 0}`);
          load();
        })
        .catch((err) => setNotice(err instanceof Error ? err.message : 'Accept all failed.'));
    });

  const readyCheck = (row: ListedInvoice) =>
    startTransition(() => {
      setNotice('');
      void api(`ready-check?draftInvoiceNumber=${encodeURIComponent(row.draftInvoiceNumber)}&batchId=${encodeURIComponent(row.batchId)}`)
        .then((result: any) => {
          setNotice(
            result.ready
              ? `${row.amzlUniqueId || row.draftInvoiceNumber} is ready for payment`
              : `${row.amzlUniqueId || row.draftInvoiceNumber} not ready yet (${result.batchStatus || result.draftStatus || 'unknown'})`,
          );
        })
        .catch((err) => setNotice(err instanceof Error ? err.message : 'Ready check failed.'));
    });

  return (
    <section className="fp-panel">
      <div className="fp-section-head">
        <div>
          <h2>Pending DSP accept</h2>
          <p>Only invoices waiting on DSP action. Disputed and AMZL-pending stay out of this queue.</p>
        </div>
        <div className="fp-actions">
          <button disabled={loading || pending} onClick={load}>
            Refresh
          </button>
          <button disabled={!canEdit || pending || !rows.length} onClick={acceptAll}>
            Accept all pending
          </button>
        </div>
      </div>
      {loading && <p className="ai-muted">Loading queue…</p>}
      {error && (
        <p className="fp-warning" role="alert">
          {error}
        </p>
      )}
      <div className="fp-scroll">
        <table>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Station</th>
              <th>Region</th>
              <th>Portal date</th>
              <th>Amount</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.draftInvoiceNumber}>
                <td>
                  <strong>{row.amzlUniqueId || '—'}</strong>
                  <small className="ai-muted" style={{ display: 'block' }}>
                    {row.draftInvoiceNumber}
                  </small>
                </td>
                <td>{row.serviceArea}</td>
                <td>{row.regionName}</td>
                <td>{row.portalYmd || '—'}</td>
                <td className="ai-money">{row.amount || '—'}</td>
                <td>
                  <span className={`ai-chip ${statusChip(row.status, row.approvalStatus)}`}>
                    {chipLabel(row.status, row.approvalStatus)}
                  </span>
                </td>
                <td>
                  <div className="ai-row-actions">
                    <button disabled={!canEdit || pending} onClick={() => acceptOne(row)}>
                      Accept
                    </button>
                    <button disabled={pending} onClick={() => readyCheck(row)}>
                      Ready check
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !rows.length && !error && <p className="fp-empty">No invoices awaiting DSP accept.</p>}
      </div>
    </section>
  );
}

function CatalogPanel({ setNotice }: { setNotice: (value: string) => void }) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [status, setStatus] = useState('');
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

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, status, station, from, to, sort, pageSize]);

  useEffect(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sort,
    });
    if (debouncedQ) params.set('q', debouncedQ);
    if (status) params.set('status', status);
    if (station) params.set('station', station);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    setLoading(true);
    setError('');
    api<{ total: number; rows: CatalogRow[] }>(`catalog?${params}`)
      .then((data) => {
        setTotal(data.total || 0);
        setRows(data.rows || []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Catalog unavailable.'))
      .finally(() => setLoading(false));
  }, [debouncedQ, status, station, from, to, sort, page, pageSize]);

  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  const openPdf = (row: CatalogRow) => {
    if (!row.pdfAvailable) {
      setNotice('PDF is not available for this row yet.');
      return;
    }
    window.open(
      `/api/finance/amazon-invoices/pdf?draftInvoiceNumber=${encodeURIComponent(row.draftInvoiceNumber)}`,
      '_blank',
      'noopener,noreferrer',
    );
  };

  return (
    <section className="fp-panel">
      <div className="fp-section-head">
        <div>
          <h2>Invoice catalog</h2>
          <p>Search the D1 register — filters never call Amazon live.</p>
        </div>
        <small className="ai-muted">{total} matching</small>
      </div>
      <div className="ai-filters">
        <label>
          Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="INV-… / station / draft" />
        </label>
        <label>
          Status
          <input value={status} onChange={(e) => setStatus(e.target.value)} placeholder="READY_FOR_PAYMENT_V2" />
        </label>
        <label>
          Station
          <input value={station} onChange={(e) => setStation(e.target.value.toUpperCase())} placeholder="RPRN" />
        </label>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
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
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
      </div>
      {loading && <p className="ai-muted">Loading catalog…</p>}
      {error && (
        <p className="fp-warning" role="alert">
          {error}
        </p>
      )}
      <div className="fp-scroll">
        <table>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Station</th>
              <th>Region</th>
              <th>Portal</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Payment</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.draftInvoiceNumber}>
                <td>
                  <strong>{row.invoiceNumber || '—'}</strong>
                  <small className="ai-muted" style={{ display: 'block' }}>
                    {row.draftInvoiceNumber}
                  </small>
                </td>
                <td>{row.station}</td>
                <td>{row.regionName}</td>
                <td>{row.portalYmd || '—'}</td>
                <td className="ai-money">{row.amountPaise ? money(row.amountPaise) : row.amountText || '—'}</td>
                <td>
                  <span className={`ai-chip ${statusChip(row.status, row.approvalStatus)}`}>
                    {chipLabel(row.status, row.approvalStatus)}
                  </span>
                </td>
                <td>{row.paymentDate || '—'}</td>
                <td>
                  <button type="button" onClick={() => openPdf(row)}>
                    PDF
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !rows.length && !error && <p className="fp-empty">No catalog rows match these filters.</p>}
      </div>
      <div className="ai-pager">
        <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          Previous
        </button>
        <span>
          Page {Math.min(page, lastPage)} / {lastPage}
        </span>
        <button disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
      </div>
    </section>
  );
}

function TallyPanel({
  canEdit,
  pending,
  startTransition,
  setNotice,
}: {
  canEdit: boolean;
  pending: boolean;
  startTransition: (fn: () => void) => void;
  setNotice: (value: string) => void;
}) {
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [polling, setPolling] = useState(false);

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

  const pollUntilReady = async (runId?: string) => {
    setPolling(true);
    const started = Date.now();
    let delay = 2000;
    try {
      while (Date.now() - started < 180000) {
        const data = await api<RunStatus>(`status${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`);
        setStatus(data);
        if (data.filesReady) {
          setNotice('Tally export files are ready.');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay + 500, 3000);
      }
      setNotice('Export is still running in the background. Refresh status later.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Status poll failed.');
    } finally {
      setPolling(false);
    }
  };

  const buildExport = () =>
    startTransition(() => {
      setNotice('');
      void api<RunStatus>('export', {
        method: 'POST',
        body: JSON.stringify({ from: from || undefined, to: to || undefined }),
      })
        .then(async (data) => {
          setStatus(data);
          if (data.filesReady) {
            setNotice('Export ready.');
            return;
          }
          setNotice('Export started…');
          await pollUntilReady(data.id);
        })
        .catch((err) => setNotice(err instanceof Error ? err.message : 'Export failed.'));
    });

  const download = (format: string) => {
    const runId = status?.id ? `&runId=${encodeURIComponent(status.id)}` : '';
    window.open(`/api/finance/amazon-invoices/download?format=${format}${runId}`, '_blank', 'noopener,noreferrer');
  };

  const progress = useMemo(() => {
    const total = status?.invoices?.length || 0;
    const done = (status?.parsed || 0) + (status?.failed || 0) + (status?.skipped || 0);
    return total ? `${done} / ${total}` : '—';
  }, [status]);

  return (
    <section className="fp-panel">
      <div className="fp-section-head">
        <div>
          <h2>Tally export</h2>
          <p>Weekly Monday cron builds the last 21 days. Use this panel for an on-demand date range.</p>
        </div>
        <button disabled={polling || pending} onClick={() => void loadStatus()}>
          Refresh status
        </button>
      </div>
      {error && <p className="ai-muted">{error}</p>}
      <div className="ai-status-grid">
        <section>
          <small>Run</small>
          <strong>{status?.id ? status.id.slice(0, 8) : '—'}</strong>
          <span className="ai-muted">
            {status?.from || '—'} → {status?.to || '—'}
          </span>
        </section>
        <section>
          <small>Progress</small>
          <strong>{progress}</strong>
          <span className="ai-muted">{status?.filesReady ? 'Files ready' : polling ? 'Working…' : 'Not ready'}</span>
        </section>
        <section>
          <small>File</small>
          <strong style={{ fontSize: 13 }}>{status?.fileName || '—'}</strong>
        </section>
      </div>
      <div className="fp-actions" style={{ marginBottom: 16 }}>
        <button disabled={!status?.filesReady} onClick={() => download('xlsx')}>
          Download xlsx
        </button>
        <button disabled={!status?.filesReady} onClick={() => download('tally-entries')}>
          Tally entries CSV
        </button>
        <button disabled={!status?.filesReady} onClick={() => download('tally-sales')}>
          Tally sales CSV
        </button>
        <button disabled={!status?.filesReady} onClick={() => download('components')}>
          Components CSV
        </button>
      </div>
      <div className="ai-filters">
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button disabled={!canEdit || pending || polling} onClick={buildExport}>
          Build export
        </button>
      </div>
      {!!status?.listingWarnings?.length && (
        <details>
          <summary>Listing warnings</summary>
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
  pending,
  startTransition,
  setNotice,
}: {
  canEdit: boolean;
  pending: boolean;
  startTransition: (fn: () => void) => void;
  setNotice: (value: string) => void;
}) {
  const [autoAcceptEnabled, setAutoAcceptEnabled] = useState(true);
  const [lastAcceptRun, setLastAcceptRun] = useState<string | null>(null);
  const [lastCatalogSync, setLastCatalogSync] = useState<string | null>(null);
  const [lastTallyRunId, setLastTallyRunId] = useState<string | null>(null);
  const [session, setSession] = useState<{ hasSession?: boolean; savedAt?: string | null; probe?: string } | null>(null);
  const [recent, setRecent] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    Promise.all([
      api<{
        autoAcceptEnabled: boolean;
        lastAcceptRun: string | null;
        lastCatalogSync: string | null;
        lastTallyRunId: string | null;
        recentAccepts: Array<Record<string, unknown>>;
      }>('automation'),
      api<{ hasSession?: boolean; savedAt?: string | null; probe?: string }>('session/status').catch(() => null),
    ])
      .then(([automation, sessionStatus]) => {
        setAutoAcceptEnabled(automation.autoAcceptEnabled);
        setLastAcceptRun(automation.lastAcceptRun);
        setLastCatalogSync(automation.lastCatalogSync);
        setLastTallyRunId(automation.lastTallyRunId);
        setRecent(automation.recentAccepts || []);
        setSession(sessionStatus);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Automation status unavailable.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (enabled: boolean) =>
    startTransition(() => {
      setNotice('');
      void api('automation', {
        method: 'PUT',
        body: JSON.stringify({ autoAcceptEnabled: enabled }),
      })
        .then(() => {
          setAutoAcceptEnabled(enabled);
          setNotice(enabled ? 'Auto-accept enabled.' : 'Auto-accept disabled.');
        })
        .catch((err) => setNotice(err instanceof Error ? err.message : 'Unable to update kill switch.'));
    });

  const runNow = () =>
    startTransition(() => {
      setNotice('');
      void api('auto-accept-tick', { method: 'POST', body: '{}' })
        .then((result: any) => {
          setNotice(
            result.skipped
              ? `Skipped: ${result.reason}`
              : `Tick done · accepted ${result.accepted || 0} · failed ${result.failed || 0}`,
          );
          load();
        })
        .catch((err) => setNotice(err instanceof Error ? err.message : 'Auto-accept tick failed.'));
    });

  const ensureSession = () =>
    startTransition(() => {
      setNotice('');
      void api('session/ensure', { method: 'POST', body: JSON.stringify({ force: false }) })
        .then(() => {
          setNotice('Session probe completed.');
          load();
        })
        .catch((err) => setNotice(err instanceof Error ? err.message : 'Session probe failed.'));
    });

  let lastAcceptSummary = '—';
  try {
    if (lastAcceptRun) {
      const parsed = JSON.parse(lastAcceptRun) as { at?: string; accepted?: number; failed?: number; reason?: string };
      lastAcceptSummary = `${parsed.at || lastAcceptRun}${parsed.accepted != null ? ` · accepted ${parsed.accepted}` : ''}${parsed.failed ? ` · failed ${parsed.failed}` : ''}${parsed.reason ? ` · ${parsed.reason}` : ''}`;
    }
  } catch {
    lastAcceptSummary = lastAcceptRun || '—';
  }

  return (
    <section className="fp-panel">
      <div className="fp-section-head">
        <div>
          <h2>Automation</h2>
          <p>
            Auto-accept runs every 2 hours at :15 UTC for <code>PENDING_DSP_ACTION</code> only (cap 25 / tick). Monday
            07:30 IST rebuilds Tally; Final P&L syncs daily at 08:00 IST.
          </p>
        </div>
        <div className="fp-actions">
          <button disabled={!canEdit || pending} onClick={ensureSession}>
            Probe session
          </button>
          <button disabled={!canEdit || pending} onClick={runNow}>
            Run accept now
          </button>
        </div>
      </div>
      {error && (
        <p className="fp-warning" role="alert">
          {error}
        </p>
      )}
      <div className="ai-status-grid">
        <section>
          <small>Auto-accept</small>
          <strong>{autoAcceptEnabled ? 'On' : 'Off'}</strong>
          <button disabled={!canEdit || pending} onClick={() => toggle(!autoAcceptEnabled)}>
            {autoAcceptEnabled ? 'Turn off' : 'Turn on'}
          </button>
        </section>
        <section>
          <small>Session</small>
          <strong>{session?.probe === 'ok' ? 'Healthy' : session?.probe === 'expired' ? 'Expired' : session?.hasSession ? 'Present' : 'Missing'}</strong>
          <span className="ai-muted">{session?.savedAt || '—'}</span>
        </section>
        <section>
          <small>Last accept run</small>
          <strong style={{ fontSize: 12 }}>{lastAcceptSummary}</strong>
        </section>
        <section>
          <small>Last catalog sync</small>
          <strong style={{ fontSize: 12 }}>{lastCatalogSync || '—'}</strong>
        </section>
        <section>
          <small>Latest Tally run</small>
          <strong style={{ fontSize: 12 }}>{lastTallyRunId || '—'}</strong>
        </section>
      </div>
      <h3>Recent accepts</h3>
      <div className="fp-scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Invoice</th>
              <th>Actor</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((row, index) => (
              <tr key={`${row.at}-${index}`}>
                <td>{String(row.at || '—')}</td>
                <td>{String(row.invoice_number || row.draft_invoice_number || '—')}</td>
                <td>{String(row.actor || '—')}</td>
                <td>
                  {row.error
                    ? String(row.error)
                    : row.accepted
                      ? 'Accepted'
                      : row.ready
                        ? 'Ready'
                        : 'Skipped'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!recent.length && <p className="fp-empty">No accept audit rows yet.</p>}
      </div>
      <p className="ai-muted">
        Docs: set <code>FINANCE_WORKER_ADMIN_KEY</code> on Fin (worker <code>ADMIN_API_KEY</code>). Keep{' '}
        <code>FIN_PNL_API_KEY</code> for Final P&L. Never expose either key to the browser.
      </p>
      <p className="ai-muted">
        Related: <Link href="/finance/final-pnl">Final P&L</Link>
      </p>
    </section>
  );
}
