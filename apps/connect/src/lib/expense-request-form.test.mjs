import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyExpectedExpenses, normalizeExpectedExpenses, requestExpenseCategories, requestExpenseAmounts, sumExpectedExpenses, validateRequestExpenseAmounts } from './expense-request-form.ts';

const heads = [
  { id: 'travel', name: 'Renamed travel', show_in_expense_requests: true },
  { id: 'distance', name: 'Distance reimbursement', show_in_expense_requests: false },
  { id: 'new-head', name: 'New expense head', show_in_expense_requests: true }
];

test('Finance visibility and names determine request fields without code or name special cases', () => {
  assert.deepEqual(emptyExpectedExpenses(), {});
  assert.deepEqual(requestExpenseCategories(heads).map(x => x.name), ['Renamed travel', 'New expense head']);
  const enabled = heads.map(head => ({ ...head, show_in_expense_requests: true }));
  assert.equal(requestExpenseCategories(enabled).length, 3);
});

test('hidden stale amounts do not inflate totals or submitted payload', () => {
  const visible = requestExpenseAmounts({ travel: 200, distance: 900, 'new-head': 50, deleted: 800 }, heads);
  assert.deepEqual(visible, { travel: 200, 'new-head': 50 });
  assert.equal(sumExpectedExpenses(visible), 250);
  assert.deepEqual(requestExpenseAmounts({ travel: 200 }, []), {});
});

test('submission rejects disabled, deleted and unknown heads while history remains readable', () => {
  assert.doesNotThrow(() => validateRequestExpenseAmounts({ travel: 200, distance: 0 }, heads));
  for (const values of [{ distance: 1 }, { deleted: 1 }]) {
    assert.throws(() => validateRequestExpenseAmounts(values, heads), /Refresh/);
  }
  assert.deepEqual(normalizeExpectedExpenses({ travel: 200, distance: 900 }), { travel: 200, distance: 900 });
});
