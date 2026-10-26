import { NextResponse } from 'next/server';
import { adminWorker, invoiceContext } from '@/lib/finance/amazon-invoices/server';
import { hasPermission } from '@/lib/authorization';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function workerPath(segments: string[]): string {
  if (segments[0] === 'session') {
    return `/api/admin/session/${segments.slice(1).join('/')}`;
  }
  return `/api/admin/invoices/${segments.join('/')}`;
}

async function handle(request: Request, segments: string[]) {
  const needsWrite = request.method !== 'GET' && request.method !== 'HEAD';

  try {
    const ctx = await invoiceContext(needsWrite ? 'edit' : undefined);
    if (needsWrite && !hasPermission(ctx.authorization, 'finance_pnl', 'edit')) {
      return NextResponse.json({ error: 'Your role cannot change Amazon invoices.' }, { status: 403 });
    }

    const url = new URL(request.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    const pathKey = segments.join('/');
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
      if (pathKey === 'accept' || pathKey === 'auto-accept-tick') {
        body = { ...(body as object), actor: ctx.authorization.userId };
      }
    }

    const upstream = await adminWorker(workerPath(segments), {
      method: request.method,
      body,
      query,
    });

    const contentType = upstream.headers.get('content-type') || 'application/json';
    if (contentType.includes('application/pdf') || contentType.includes('spreadsheet') || contentType.includes('text/csv') || contentType.includes('octet-stream')) {
      return new NextResponse(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': upstream.headers.get('content-disposition') || 'attachment',
          'Cache-Control': 'private, no-store',
        },
      });
    }

    const payload = await upstream.text();
    return new NextResponse(payload, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType.includes('json') ? 'application/json' : contentType,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Amazon invoice proxy failed.';
    const status = /not configured|Unauthorized|cannot change|not connected/i.test(message) ? 403 : 502;
    return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'private, no-store' } });
  }
}

type Ctx = { params: { path: string[] } };

export async function GET(request: Request, ctx: Ctx) {
  return handle(request, ctx.params.path || []);
}
export async function POST(request: Request, ctx: Ctx) {
  return handle(request, ctx.params.path || []);
}
export async function PUT(request: Request, ctx: Ctx) {
  return handle(request, ctx.params.path || []);
}
