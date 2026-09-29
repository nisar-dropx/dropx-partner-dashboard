import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { adminAuth } from './middleware/adminAuth';
import { errorHandler } from './middleware/errorHandler';
import {
  ensureCloakSessionHandler,
  healthHandler,
  runNlHandler,
  runSlpHandler,
  statusHandler,
  uploadCloakSessionHandler,
} from './routes/admin';
import { runNlLoss } from './services/nlLossRunner';
import { runSlpLoss } from './services/slpLossRunner';

const app = new Hono<{ Bindings: Env }>();

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-admin-key'],
    maxAge: 86400,
  }),
);

app.onError(errorHandler);

app.get('/api/health', healthHandler);

app.use('/api/admin/*', adminAuth);

app.get('/api/admin/status', statusHandler);
app.put('/api/admin/cloak/session', uploadCloakSessionHandler);
app.post('/api/admin/cloak/session/ensure', ensureCloakSessionHandler);
app.post('/api/admin/nl-loss/run', runNlHandler);
app.post('/api/admin/slp-loss/run', runSlpHandler);

/** Must match wrangler.toml [triggers]. */
const NL_CRON = '20 * * * *';
const SLP_CRON = '30 1,7 * * *';

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === SLP_CRON) {
      ctx.waitUntil(
        runSlpLoss(env, 'cron')
          .then((r) => console.log('slp loss', JSON.stringify(r.results), r.error ?? ''))
          .catch((e) => console.error('slp loss failed', e)),
      );
      return;
    }
    if (event.cron === NL_CRON) {
      ctx.waitUntil(
        runNlLoss(env, 'cron')
          .then((r) => console.log('nl loss', r.ok, r.rows ?? 0, r.error ?? ''))
          .catch((e) => console.error('nl loss failed', e)),
      );
    }
  },
};
