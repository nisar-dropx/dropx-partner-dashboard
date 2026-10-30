import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import ts from 'typescript';

const secret = 'test-only-key';
function load(fetch, env = { SUPABASE_SERVICE_ROLE_KEY: secret }) {
  const source = readFileSync(new URL('./own-advance-deduction.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'exports', 'process', 'fetch', output)(name => {
    if (name === 'server-only') return {};
    assert.equal(name, 'node:crypto'); return crypto;
  }, module.exports, { env }, fetch);
  return module.exports.loadOwnAdvanceDeduction;
}
test('service lookup binds the canonical company, worker and month; never forwards actor cookies or secret', async () => {
  for (const amount of [0, 78.12]) {
    let calls = 0;
    const lookup = load(async (url, options) => {
      calls++;
      assert.equal(url.toString(), 'https://dashboard.dropxlogistics.com/api/internal/workforce-advance-deduction');
      assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
      assert.deepEqual(JSON.parse(options.body), { companyId: 'company', workforceId: 'canonical-worker', month: '2026-10' });
      assert.deepEqual(Object.keys(options.headers).sort(), ['content-type', 'x-dropx-signature', 'x-dropx-time']);
      assert.equal(options.headers['x-dropx-signature'], crypto.createHmac('sha256', secret)
        .update(`dropx:workforce-advance-deduction:v1.${options.headers['x-dropx-time']}.${options.body}`).digest('hex'));
      assert.equal(JSON.stringify(options).includes(secret), false);
      return Response.json({ advanceRecoveryAmount: amount });
    });
    assert.equal(await lookup('company', 'canonical-worker', '2026-10'), amount); assert.equal(calls, 1);
  }
});
test('invalid amounts, downstream errors and network failure never become zero deductions', async () => {
  for (const response of [() => Response.json({ error: 'PRIVATE' }, { status: 401 }),
    () => Response.json({}), () => Response.json(null), () => Response.json({ advanceRecoveryAmount: '50' }),
    () => Response.json({ advanceRecoveryAmount: -1 }), () => new Response('PRIVATE HTML'),
    () => { throw Error('PRIVATE network'); }]) {
    await assert.rejects(load(response)('company', 'worker', '2026-10'), error => {
      assert.equal(error.message, 'Your advance deductions could not be verified. Please retry.'); return true;
    });
  }
});
test('missing key fails without making a request; configured Dashboard origin is used', async () => {
  await assert.rejects(load(() => assert.fail('must not fetch'), {})('company', 'worker', '2026-10'));
  const lookup = load(async url => {
    assert.equal(url.origin, 'https://configured.example'); return Response.json({ advanceRecoveryAmount: 0 });
  }, { SUPABASE_SERVICE_ROLE_KEY: secret, DASHBOARD_URL: 'https://configured.example/base' });
  assert.equal(await lookup('company', 'worker', '2026-10'), 0);
});
