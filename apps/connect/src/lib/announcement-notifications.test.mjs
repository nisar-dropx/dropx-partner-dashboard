import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announcementId, resolveAnnouncementNotices, hydrateAnnouncementNotices } from './announcement-notifications.ts';
import { visibleDashboardNotices } from './dashboard-notices.ts';
const id = '11111111-1111-4111-8111-111111111111';
const notice = { id: 'notification', event_code: 'communication_announcement', title: 'Preview', body: 'Truncated', data: { announcementId: id, showOnDashboard: true, dashboardUntil: '2026-10-13T06:30:00.000Z' } };
const a = { id, title: 'Full title', body: 'x'.repeat(5000), status: 'published', expires_at: null };
test('bell opens full current announcement, preserving banner data', () => {
  const rows = resolveAnnouncementNotices([notice], [a]);
  assert.equal(rows[0].body.length, 5000); assert.equal(rows[0].title, 'Full title');
  assert.equal(rows[0].data.openNotice, true); assert.equal(rows[0].data.showOnDashboard, true);
});
test('missing receipt, drafts, archived and expired updates are not exposed', () => {
  assert.deepEqual(resolveAnnouncementNotices([notice], []), []);
  for (const status of ['draft','archived']) assert.deepEqual(resolveAnnouncementNotices([notice], [{ ...a, status }]), []);
  assert.deepEqual(resolveAnnouncementNotices([notice], [{ ...a, expires_at: '2020-01-01' }]), []);
});
test('banner disappears at deadline while Connect content remains available', () => {
  const before = Date.parse('2026-10-13T06:29:59Z'), after = before + 1000;
  assert.equal(visibleDashboardNotices([notice], before).length, 1);
  assert.equal(visibleDashboardNotices([notice], after).length, 0);
  assert.equal(resolveAnnouncementNotices([notice], [a], after).length, 1);
});
test('ordinary notifications are unchanged; invalid announcement IDs cannot be queried', () => {
  const other = { ...notice, event_code: 'attendance_punch_in' };
  assert.deepEqual(resolveAnnouncementNotices([other], []), [other]);
  assert.equal(announcementId({ ...notice, data: { announcementId: 'unsafe' } }), null);
});
test('removed banners disappear even if old notification metadata still says enabled', () => {
  const rows = resolveAnnouncementNotices([notice], [{ ...a, show_on_dashboard: false }]);
  assert.equal(visibleDashboardNotices(rows).length, 0);
  assert.equal(rows.length, 1); // Notification content remains accessible.
});
test('a canonical no-expiry banner remains until removed; explicit deadlines still expire', () => {
  const rows = resolveAnnouncementNotices([notice], [{ ...a, show_on_dashboard: true, dashboard_until: null, dashboard_summary: 'Please read' }]);
  assert.equal(visibleDashboardNotices(rows, Date.parse('2030-01-01')).length, 1);
  assert.equal(rows[0].data.summary, 'Please read');
  assert.equal(visibleDashboardNotices([{ ...notice, data: { showOnDashboard: true } }]).length, 0);
});
test('database hydration scopes to company, account, profile type and selected receipts', async () => {
  const calls = []; const query = { select: (...args) => { calls.push(['select',...args]); return query; }, eq: (...args) => { calls.push(['eq',...args]); return query; }, in: (...args) => { calls.push(['in',...args]); return Promise.resolve({ data: [{ communication_announcements: a }], error: null }); } };
  const rows = await hydrateAnnouncementNotices({ from: () => query }, { companyId: 'company', id: 'contractor', profileType: 'contractor' }, [notice]);
  assert.equal(rows[0].body, a.body);
  for (const pair of [['company_id','company'],['recipient_account_id','contractor'],['recipient_profile_type','contractor'],['communication_announcements.company_id','company']]) assert(calls.some(c => c[0]==='eq' && c[1]===pair[0] && c[2]===pair[1]));
});
