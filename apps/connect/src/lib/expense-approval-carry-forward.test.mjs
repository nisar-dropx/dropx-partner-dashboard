import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carryForwardApprovedExpenseRequest } from './expense-approval-carry-forward.ts';

const steps = [
  { step_order: 1, stage_code: 'manager', approver_user_id: 'manager-1', step_name: 'Reporting manager' },
  { step_order: 2, stage_code: 'manager', approver_user_id: 'manager-2', step_name: 'Next reporting manager' },
  { step_order: 3, stage_code: 'finance', approver_user_id: 'finance', step_name: 'Finance approval' }
];
const request = {
  status: 'approved', decided_by: 'manager-2', decided_at: '2026-09-28T04:36:09.000Z', estimated_amount: 1742,
  expected_expenses: { food: 397, travel: 1345 }
};

test('higher-manager request approval carries a matching claim directly to Finance', () => {
  const result = carryForwardApprovedExpenseRequest(steps, request, [
    { categoryId: 'food', amount: 397 }, { categoryId: 'travel', amount: 1345 }
  ]);
  assert.equal(result.applied, true);
  assert.equal(result.skippedManagerCount, 2);
  assert.deepEqual(result.steps.map(step => [step.step_order, step.stage_code, step.approver_user_id]), [[1, 'finance', 'finance']]);
});

test('a lower claim within every approved expense head can reuse approval', () => {
  const result = carryForwardApprovedExpenseRequest(steps, request, [
    { categoryId: 'food', amount: 300 }, { categoryId: 'travel', amount: 1200 }
  ]);
  assert.equal(result.applied, true);
});

test('total, category, or new-head increases retain the full manager chain', () => {
  const cases = [
    [{ categoryId: 'food', amount: 398 }, { categoryId: 'travel', amount: 1345 }],
    [{ categoryId: 'food', amount: 100 }, { categoryId: 'travel', amount: 1300 }, { categoryId: 'hotel', amount: 100 }],
    [{ categoryId: 'food', amount: 397 }, { categoryId: 'travel', amount: 1400 }]
  ];
  for (const items of cases) {
    const result = carryForwardApprovedExpenseRequest(steps, request, items);
    assert.equal(result.applied, false);
    assert.equal(result.steps.length, 3);
  }
});

test('a stale approver outside the current route cannot be carried forward', () => {
  const result = carryForwardApprovedExpenseRequest(steps, { ...request, decided_by: 'former-manager' }, [
    { categoryId: 'food', amount: 397 }, { categoryId: 'travel', amount: 1345 }
  ]);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'approver_not_in_route');
});

test('policy exceptions remain even when prior manager approvals are reused', () => {
  const route = [
    ...steps.slice(0, 2),
    { step_order: 3, stage_code: 'policy_exception', approver_user_id: 'exception', step_name: 'Policy exception' },
    { ...steps[2], step_order: 4 }
  ];
  const result = carryForwardApprovedExpenseRequest(route, request, [
    { categoryId: 'food', amount: 397 }, { categoryId: 'travel', amount: 1345 }
  ]);
  assert.deepEqual(result.steps.map(step => step.stage_code), ['policy_exception', 'finance']);
  assert.deepEqual(result.steps.map(step => step.step_order), [1, 2]);
});
