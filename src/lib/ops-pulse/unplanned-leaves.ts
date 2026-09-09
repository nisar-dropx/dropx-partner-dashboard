export type LeaveStatus = { id: string; label: string; tone: string; display_order: number; is_terminal: boolean; is_active: boolean };
export type UnplannedPerson = {
  id: string; worker_type: string; worker_id: string; worker_code: string | null;
  worker_name: string; contact_number: string | null; designation_name: string | null; department_name: string | null;
  location_id: string | null; location_code: string | null; location_name: string | null;
  cluster: string | null; region: string | null; attendance_date: string;
  shift_label: string | null; shift_start: string | null; shift_end: string | null;
  employment_status: string; employment_active: boolean; last_working_date: string | null;
  status: LeaveStatus; reason: string | null; last_hr_update_at: string | null;
  first_punch_at: string | null; last_punch_at: string | null; check_out_at: string | null;
  recorded_punch_count: number; pending_punches: boolean; excluded_at: string | null; exclusion_reason: string | null;
};
export type LeaveLocation = { id: string; code: string; name: string | null; cluster: string | null; region: string | null };
export type UnplannedWorkspace = {
  from: string; to: string; today: string; checkedAt: string; graceMinutes: number; enabled: boolean;
  rows: UnplannedPerson[]; locations: LeaveLocation[]; statuses: LeaveStatus[];
};
export type UnplannedFilters = {
  from: string; to: string; view: 'open' | 'updated'; backlog: boolean;
  location: string; cluster: string; region: string; search: string; status: string; employment: string; page: number;
};
export const LEAVE_PAGE_SIZE = 50;
export function indiaToday(now = new Date()) { return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10); }
export function unplannedDate(input?: string, now = new Date()) {
  const date = input || indiaToday(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > indiaToday(now)) {
    throw Error('Choose a valid attendance date up to today.');
  }
  return date;
}
export function unplannedFilters(params: URLSearchParams, now = new Date()): UnplannedFilters {
  for (const key of ['date', 'from', 'to', 'view', 'location', 'cluster', 'region', 'search', 'status', 'employment', 'page']) {
    if (params.getAll(key).length > 1) throw Error('Choose one value per filter.');
  }
  const from = unplannedDate(params.get('from') || params.get('date') || undefined, now);
  const to = unplannedDate(params.get('to') || params.get('date') || from, now);
  if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 30) throw Error('Choose a date range of up to 31 days, with From before To.');
  const page = Number(params.get('page') || 1);
  const text = (key: string) => (params.get(key) || '').trim().slice(0, 200);
  return { from, to, view: params.get('view') === 'updated' ? 'updated' : 'open',
    backlog: params.getAll('backlog').at(-1) !== '0', location: text('location'), cluster: text('cluster'), region: text('region'),
    search: text('search'), status: text('status'), employment: text('employment'), page: Number.isSafeInteger(page) && page > 0 ? page : 1 };
}
export function unplannedQuery(filters: UnplannedFilters, changes: Partial<UnplannedFilters> = {}) {
  const f = { ...filters, ...changes };
  const params = new URLSearchParams({ from: f.from, to: f.to, view: f.view });
  for (const key of ['location', 'cluster', 'region', 'search', 'status', 'employment'] as const) if (f[key]) params.set(key, f[key]);
  if (!f.backlog) params.set('backlog', '0');
  if (f.page > 1) params.set('page', String(f.page));
  return params.toString();
}
export function hasLeavePunch(row: UnplannedPerson) {
  return row.recorded_punch_count > 0 || Boolean(row.first_punch_at || row.last_punch_at || row.check_out_at);
}
export function leaveOutcome(row: UnplannedPerson) {
  if (hasLeavePunch(row)) return { id: row.pending_punches ? 'punch_pending' : 'punched', label: row.pending_punches ? 'Punch pending approval' : 'Punched in', tone: row.pending_punches ? 'blue' : 'green' };
  if (row.excluded_at) return { id: 'excluded', label: row.exclusion_reason?.toLowerCase().includes('leave') ? 'Approved leave' : 'No follow-up needed', tone: 'neutral' };
  return row.status;
}
export function leaveIsUpdated(row: UnplannedPerson) { return hasLeavePunch(row) || Boolean(row.excluded_at) || row.status.is_terminal; }
export function employmentLabel(row: UnplannedPerson) {
  if (row.employment_status === 'active' && !row.employment_active) return 'Inactive';
  return ({ active: 'Active', suspended: 'Suspended', offboarding: 'Offboarding', offboarded: 'Offboarded / left' } as Record<string, string>)[row.employment_status] || 'Inactive';
}
export function filterUnplannedRows(data: UnplannedWorkspace, f: UnplannedFilters) {
  const search = f.search.toLowerCase();
  return data.rows.filter(row => row.attendance_date <= f.to && (row.attendance_date >= f.from || f.backlog)
    && (!f.location || (f.location === 'unassigned' ? !row.location_id : row.location_id === f.location))
    && (!f.cluster || (row.cluster || 'unassigned') === f.cluster) && (!f.region || (row.region || 'unassigned') === f.region)
    && (!f.status || leaveOutcome(row).id === f.status)
    && (!f.employment || (f.employment === 'inactive' ? !row.employment_active : row.employment_status === f.employment && (f.employment !== 'active' || row.employment_active)))
    && (!search || [row.worker_name, row.worker_code, row.contact_number, row.location_code, row.location_name, row.reason, leaveOutcome(row).label].some(value => value?.toLowerCase().includes(search))));
}
export function leaveReport(data: UnplannedWorkspace, filters: UnplannedFilters) {
  const matching = filterUnplannedRows(data, filters);
  const open = matching.filter(row => !leaveIsUpdated(row));
  const updated = matching.filter(row => leaveIsUpdated(row) && row.attendance_date >= filters.from);
  const rows = (filters.view === 'updated' ? updated : open).sort((a, b) =>
    (filters.view === 'updated' ? String(b.last_punch_at || b.last_hr_update_at || b.excluded_at).localeCompare(String(a.last_punch_at || a.last_hr_update_at || a.excluded_at)) : a.status.display_order - b.status.display_order)
    || b.attendance_date.localeCompare(a.attendance_date) || a.worker_name.localeCompare(b.worker_name));
  const pageCount = Math.max(1, Math.ceil(rows.length / LEAVE_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  return { rows, page, pageCount, pageRows: rows.slice((page - 1) * LEAVE_PAGE_SIZE, page * LEAVE_PAGE_SIZE),
    summary: { today: open.filter(r => r.attendance_date === data.today).length, earlier: open.filter(r => r.attendance_date < data.today).length,
      open: open.length, updated: updated.length, punched: updated.filter(hasLeavePunch).length } };
}
export function punchTime(value: string | null, date: string) {
  if (!value) return '—';
  const stamp = new Date(value);
  if (!Number.isFinite(stamp.getTime())) return '—';
  const time = stamp.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  return indiaToday(stamp) === date ? time : `${time} · ${stamp.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}`;
}
export function leaveExportRows(rows: UnplannedPerson[]) {
  return rows.map(r => ({ Date: r.attendance_date, Name: r.worker_name, 'People ID': r.worker_code,
    Type: r.worker_type === 'employee' ? 'Employee' : 'IC', Role: r.designation_name, Department: r.department_name,
    Location: r.location_code, 'Location name': r.location_name, Cluster: r.cluster, Region: r.region, Contact: r.contact_number,
    Employment: employmentLabel(r), 'Last working day': r.last_working_date, Shift: r.shift_label,
    'Attendance status': hasLeavePunch(r) || r.excluded_at ? leaveOutcome(r).label : 'Not punched',
    'First punch (IST)': punchTime(r.first_punch_at, r.attendance_date), 'Latest punch (IST)': punchTime(r.last_punch_at, r.attendance_date),
    'Check-out (IST)': punchTime(r.check_out_at, r.attendance_date), 'Follow-up': leaveOutcome(r).label, Reason: r.reason }));
}
