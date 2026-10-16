import type { CodCheck, CodRemittance, CodStatusSnapshot } from './cod-status';

export const defaultRemittanceTolerance = 5;
export const maxRemittanceTolerance = 999999.99;
export function validRemittanceTolerance(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maxRemittanceTolerance;
}
const currencyFormatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = (value: number) => currencyFormatter.format(value);

/** Compare submitted amounts in paise. Open remittances may legitimately have
 * no actual deposit yet. Recompute from amounts so a stale variance field cannot
 * hide a shortage. This checks portal amounts, not bank settlement. */
export function remittanceAmountCheck(row: CodRemittance, tolerance: number | null = defaultRemittanceTolerance): (CodCheck & { difference: number | null }) | null {
  if (row.status.trim().toUpperCase() !== 'SUBMITTED') return null;
  const code = row.code || row.id;
  const amounts = [row.expectedAmount, row.actualAmount];
  if (!validRemittanceTolerance(tolerance) || amounts.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)))) {
    return { tone: 'unavailable', label: 'Amount needs verification', reason: `${code}: expected cash, actual cash or variance tolerance is unavailable.`, difference: null };
  }
  const paise = (value: number) => Math.round((value + Number.EPSILON) * 100);
  const differencePaise = paise(row.actualAmount) - paise(row.expectedAmount);
  const difference = differencePaise / 100;
  const alert = Math.abs(differencePaise) > paise(tolerance);
  const description = differencePaise < 0 ? `Short by ${money(-difference)}` : differencePaise > 0 ? `Excess ${money(difference)}` : 'Amounts match';
  return {
    tone: alert ? 'attention' : 'clear',
    label: alert ? description : differencePaise === 0 ? 'Amounts match' : `Within ${money(tolerance)} tolerance`,
    reason: `${code}: expected ${money(row.expectedAmount)}, actual ${money(row.actualAmount)}. ${description}; ${alert ? 'above' : 'within'} ${money(tolerance)} tolerance.`,
    difference
  };
}

/** Some source responses include the latest submission only in their summary. */
export function codRemittanceRows(data: NonNullable<CodStatusSnapshot['remittances']['data']>): CodRemittance[] {
  const latest = data.latestSubmitted;
  return latest && !data.rows.some(row => row.id === latest.id) ? [...data.rows, latest] : data.rows;
}
