/**
 * test/ledgerly.test.js
 * 
 * Comprehensive test suite for Ledgerly mock application and chaos flags.
 * Uses built-in node:test and node:assert (zero extra test dependencies).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerlyApp } from '../ledgerly/server.js';

describe('Ledgerly Mock Accounting Portal & Chaos Engine', () => {
  const PORT = 3456;
  const BASE_URL = `http://localhost:${PORT}`;
  let app;

  before(async () => {
    app = new LedgerlyApp(PORT);
    await app.start();
  });

  after(async () => {
    await app.stop();
  });

  test('1. Dashboard renders HTML with seeded invoices', async () => {
    const res = await fetch(BASE_URL);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Ledgerly/);
    assert.match(html, /INV-1001/);
    assert.match(html, /Acme Supplies Ltd/);
  });

  test('2. Successful invoice submission under ₹50,000 threshold', async () => {
    const payload = new URLSearchParams({
      invoiceId: 'INV-2026-T1',
      vendor: 'Acme Supplies Ltd',
      amount: '35000',
      date: '2026-11-01',
      notes: 'Hardware batch',
    });

    const res = await fetch(`${BASE_URL}/invoices`, {
      method: 'POST',
      body: payload.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    assert.equal(res.status, 201);
    const html = await res.text();
    assert.match(html, /processed successfully with status: Approved/);

    // Verify in admin state
    const stateRes = await fetch(`${BASE_URL}/__admin/state`);
    const state = await stateRes.json();
    const created = state.invoices.find(i => i.id === 'INV-2026-T1');
    assert.ok(created);
    assert.equal(created.status, 'Approved');
    assert.equal(created.amount, 35000);
  });

  test('3. Rejection of duplicate invoice ID', async () => {
    const payload = new URLSearchParams({
      invoiceId: 'INV-2026-T1', // already exists
      vendor: 'Acme Supplies Ltd',
      amount: '20000',
      date: '2026-11-02',
    });

    const res = await fetch(`${BASE_URL}/invoices`, {
      method: 'POST',
      body: payload.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    assert.equal(res.status, 409);
    const html = await res.text();
    assert.match(html, /Duplicate Error/);
  });

  test('4. High-value invoice > ₹50,000 triggers Pending Approval status', async () => {
    const payload = new URLSearchParams({
      invoiceId: 'INV-2026-HIGH',
      vendor: 'Global Logistics Corp',
      amount: '₹75,000.00', // formatted currency string
      date: '2026-11-03',
    });

    const res = await fetch(`${BASE_URL}/invoices`, {
      method: 'POST',
      body: payload.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    assert.equal(res.status, 201);
    const html = await res.text();
    assert.match(html, /Pending Approval/);

    const stateRes = await fetch(`${BASE_URL}/__admin/state`);
    const state = await stateRes.json();
    const created = state.invoices.find(i => i.id === 'INV-2026-HIGH');
    assert.ok(created);
    assert.equal(created.status, 'Pending Approval');
    assert.equal(created.amount, 75000);
  });

  test('5. Chaos Flag: flaky500 triggers 500 error on next app request', async () => {
    // Enable chaos flag
    await fetch(`${BASE_URL}/__admin/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flaky500: true }),
    });

    // Request should fail with 500
    const failedRes = await fetch(BASE_URL);
    assert.equal(failedRes.status, 500);

    // Subsequent request should recover
    const recoveredRes = await fetch(BASE_URL);
    assert.equal(recoveredRes.status, 200);
  });

  test('6. Chaos Flag: maintenanceMode triggers 503 Service Unavailable', async () => {
    await fetch(`${BASE_URL}/__admin/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maintenanceMode: true }),
    });

    const res = await fetch(BASE_URL);
    assert.equal(res.status, 503);

    // Disable maintenance mode
    await fetch(`${BASE_URL}/__admin/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maintenanceMode: false }),
    });

    const recovered = await fetch(BASE_URL);
    assert.equal(recovered.status, 200);
  });

  test('7. Chaos Flag: alteredFieldNames changes form inputs', async () => {
    await fetch(`${BASE_URL}/__admin/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alteredFieldNames: true }),
    });

    const res = await fetch(BASE_URL);
    const html = await res.text();
    assert.match(html, /name="invoice_code"/);
    assert.match(html, /name="supplier"/);
    assert.match(html, /name="total_sum"/);
    assert.match(html, /name="issue_date"/);

    // Revert
    await fetch(`${BASE_URL}/__admin/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alteredFieldNames: false }),
    });
  });

  test('8. Admin Reset restores initial seed state', async () => {
    const res = await fetch(`${BASE_URL}/__admin/reset`, { method: 'POST' });
    assert.equal(res.status, 200);

    const stateRes = await fetch(`${BASE_URL}/__admin/state`);
    const state = await stateRes.json();
    assert.equal(state.invoices.length, 2);
    assert.equal(state.invoices[0].id, 'INV-1001');
  });
});
