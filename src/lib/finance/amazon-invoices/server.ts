import 'server-only';
import { financeContext } from '@/lib/finance/data';
import { hasPermission } from '@/lib/authorization';
import { FINAL_PNL_COMPANY } from '@/lib/finance/final-pnl/sources';
import { redirect } from 'next/navigation';

const WORKER_BASE = 'https://finance-worker.withered-voice-1c40.workers.dev';

export async function invoiceContext(write?: 'edit') {
  const ctx = await financeContext('finance_pnl');
  if (!ctx.authorization.hasAllLocationAccess) {
    redirect('/unauthorized?page=finance_pnl_company_scope');
  }
  if (ctx.companyId !== FINAL_PNL_COMPANY) {
    throw new Error('Amazon invoices are not connected for this company.');
  }
  if (write && !hasPermission(ctx.authorization, 'finance_pnl', write)) {
    throw new Error('Your role cannot change Amazon invoice automation or accepts.');
  }
  return ctx;
}

export async function adminWorker(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
): Promise<Response> {
  const key = process.env.FINANCE_WORKER_ADMIN_KEY;
  if (!key) throw new Error('Amazon invoice connection is not configured (FINANCE_WORKER_ADMIN_KEY).');

  const url = new URL(`${WORKER_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [name, value] of Object.entries(init.query || {})) {
    if (value != null && value !== '') url.searchParams.set(name, value);
  }

  const method = init.method || (init.body !== undefined ? 'POST' : 'GET');
  return fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': key,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(150000),
  });
}

export async function adminWorkerJson<T>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
): Promise<T> {
  const response = await adminWorker(path, init);
  const result = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(result.error || `Amazon invoice request failed (${response.status}).`);
  }
  return result;
}
