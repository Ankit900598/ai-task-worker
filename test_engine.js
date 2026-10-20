/**
 * test_engine.js
 *
 * Unit & regression test suite for PolicyEngine, VerificationGuard, and AgentState.
 * Uses built-in node:test and node:assert/strict.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine, parseAmountStrict } from './lib/policy.js';
import { VerificationGuard } from './lib/guard.js';
import { AgentState } from './lib/state.js';

const MOCK_ELEMENTS = [
  { id: 1, tag: 'input', type: 'text', name: 'invoiceId', label: 'Invoice ID' },
  { id: 2, tag: 'input', type: 'text', name: 'vendor', label: 'Vendor Name' },
  { id: 3, tag: 'input', type: 'text', name: 'amount', label: 'Total Amount (INR)' },
  { id: 4, tag: 'input', type: 'date', name: 'date', label: 'Invoice Date' },
  { id: 5, tag: 'button', type: 'submit', name: 'submit-btn', label: 'Submit Invoice Record' },
];

describe('PolicyEngine & Strict Amount Parsing (Step A1 Regressions)', () => {
  test('1. parseAmountStrict parses valid numbers and rejects dates/invoice codes', () => {
    assert.equal(parseAmountStrict('84,000'), 84000);
    assert.equal(parseAmountStrict('₹45,430'), 45430);
    assert.equal(parseAmountStrict('₹84,000.50'), 84000.5);
    assert.equal(parseAmountStrict(84000), 84000);
    assert.ok(Number.isNaN(parseAmountStrict('2026-11-20')));
    assert.ok(Number.isNaN(parseAmountStrict('INV-2026-84000')));
    assert.ok(Number.isNaN(parseAmountStrict('VOUCHER#88192-DEL')));
    assert.ok(Number.isNaN(parseAmountStrict('')));
  });

  test('2. Typing a date, invoice number, or even 84,000 never triggers the approval gate', async () => {
    const policy = new PolicyEngine({ autoApprove: false, approvalThreshold: 50000 });
    const state = new AgentState('Test');
    state.recordObservation('obs', MOCK_ELEMENTS);

    const typeTool = { name: 'browser_type', riskTier: 'write' };

    const r1 = await policy.checkAction({ tool: typeTool, args: { elementId: 1, text: 'VOUCHER#88192-DEL' }, state });
    state.recordFormField('invoiceId Invoice ID', 'VOUCHER#88192-DEL');
    assert.equal(r1.requiredApproval, false);

    const r2 = await policy.checkAction({ tool: typeTool, args: { elementId: 4, text: '2026-11-20' }, state });
    state.recordFormField('date Invoice Date', '2026-11-20');
    assert.equal(r2.requiredApproval, false);

    const r3 = await policy.checkAction({ tool: typeTool, args: { elementId: 3, text: '84,000' }, state });
    state.recordFormField('amount Total Amount (INR)', '84,000');
    assert.equal(r3.requiredApproval, false);
  });

  test('3. Clicking SUBMIT with Amount 84,000 triggers gate and displays ALL form values', async () => {
    let capturedPrompt = null;
    const policy = new PolicyEngine({
      autoApprove: false,
      approvalThreshold: 50000,
      approvalHandler: async (details) => {
        capturedPrompt = details.prompt;
        return true;
      },
    });

    const state = new AgentState('Test');
    state.recordObservation('obs', MOCK_ELEMENTS);
    state.recordFormField('invoiceId Invoice ID / Number', 'INV-2026-089');
    state.recordFormField('vendor Vendor / Supplier', 'Global Logistics Corp');
    state.recordFormField('amount Total Amount (₹)', '84,000');
    state.recordFormField('date Invoice Date', '2026-11-12');
    state.recordFormField('dueDate Due Date', '2026-11-30');

    const clickTool = { name: 'browser_click', riskTier: 'write' };
    const res = await policy.checkAction({ tool: clickTool, args: { elementId: 5 }, state });

    assert.equal(res.requiredApproval, true);
    assert.equal(res.allowed, true);
    assert.ok(capturedPrompt);
    assert.match(capturedPrompt, /Invoice ID \/ Number:\s+INV-2026-089/);
    assert.match(capturedPrompt, /Vendor \/ Supplier:\s+Global Logistics Corp/);
    assert.match(capturedPrompt, /Total Amount \(₹\):\s+84,000/);
    assert.match(capturedPrompt, /Invoice Date:\s+2026-11-12/);
    assert.match(capturedPrompt, /Due Date:\s+2026-11-30/);
  });

  test('4. Clicking SUBMIT with Amount 45,430 does NOT trigger the approval gate', async () => {
    const policy = new PolicyEngine({ autoApprove: false, approvalThreshold: 50000 });
    const state = new AgentState('Test');
    state.recordObservation('obs', MOCK_ELEMENTS);
    state.recordFormField('invoiceId Invoice ID', 'INV-2026-102');
    state.recordFormField('vendor Vendor Name', 'TechNova Solutions');
    state.recordFormField('amount Total Amount (INR)', '45,430');
    state.recordFormField('date Invoice Date', '2026-11-20');

    const clickTool = { name: 'browser_click', riskTier: 'write' };
    const res = await policy.checkAction({ tool: clickTool, args: { elementId: 5 }, state });
    assert.equal(res.requiredApproval, false);
  });

  test('5. VerificationGuard blocks finish when writesSinceLastObserve > 0', () => {
    const state = new AgentState('Test');
    state.recordObservation('Initial table', MOCK_ELEMENTS);
    state.recordWrite();
    assert.throws(
      () => VerificationGuard.verifyFinish({ state, args: { evidence: 'Invoice saved' } }),
      /Verification Guard Rejected/
    );
    state.recordObservation('Updated table with invoice', MOCK_ELEMENTS);
    assert.equal(VerificationGuard.verifyFinish({ state, args: { evidence: 'Invoice saved in Updated table' } }), true);
  });
});
