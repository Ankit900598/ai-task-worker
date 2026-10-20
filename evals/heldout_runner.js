/**
 * evals/heldout_runner.js
 *
 * Held-Out Evaluation Suite with Unseen Wording and Complex Invoices.
 * Verifies DB state invariants, termination reason, finish status, and turns vs tool calls.
 */

import 'dotenv/config';
import fs from 'fs';
import { LedgerlyApp } from '../ledgerly/server.js';
import { TaskWorkerAgent } from '../automation_engine.js';
import { checkInvariants } from './runner.js';

const PORT = 3456;
const BASE_URL = `http://localhost:${PORT}`;

export const HELDOUT_TASKS = [
  {
    id: 'H1',
    name: 'Held-Out: Purchase Voucher with Net Payable',
    goal: 'Process the purchase voucher at invoices/heldout_po_881.txt into our accounting site http://localhost:3456. Make sure to use the net payable as total amount and confirm entry.',
    verify: async (db, res) => {
      const inv = db.invoices.find(i => i.id === 'VOUCHER#88192-DEL' || i.id.includes('88192'));
      return checkInvariants(db, res, { totalInvoices: 3, statuses: ['completed'] }) &&
        inv?.amount === 45430 && inv?.vendor.includes('Global Logistics') && inv?.status === 'Approved' &&
        res.approvalEvents.length === 0;
    },
  },
  {
    id: 'H2',
    name: 'Held-Out: Commercial Lease (> ₹50k Approval Gate)',
    goal: 'Review the lease document "invoices/heldout_lease_902.txt" and record the payment obligation in Ledgerly (http://localhost:3456). Observe company policy for large disbursements.',
    verify: async (db, res) => {
      const inv = db.invoices.find(i => i.id === 'LEASE-2026-X77' || i.id.includes('LEASE'));
      return checkInvariants(db, res, { totalInvoices: 3, statuses: ['completed'] }) &&
        inv?.amount === 65000 && inv?.status === 'Pending Approval' && res.approvalEvents.length >= 1;
    },
  },
  {
    id: 'H3',
    name: 'Held-Out: Dual-Vendor Entity Disambiguation',
    goal: 'Record the professional services invoice in invoices/heldout_subcontractor_903.txt into Ledgerly at http://localhost:3456. Be careful to select the actual vendor providing the service, not the client entity.',
    verify: async (db, res) => {
      const inv = db.invoices.find(i => i.id === 'SRV-2026-903' || i.id.includes('903'));
      return checkInvariants(db, res, { totalInvoices: 3, statuses: ['completed'] }) &&
        inv?.vendor === 'Apex Solutions India' && inv?.amount === 35000;
    },
  },
  {
    id: 'H4',
    name: 'New Held-Out: SaaS Statement with Rebate (Northstar)',
    goal: 'Post the cloud subscription statement in invoices/heldout_saas_904.txt to Ledgerly (http://localhost:3456) using the net balance payable after rebate, then verify the table.',
    verify: async (db, res) => {
      const inv = db.invoices.find(i => i.id === 'NS-BILL-2026-441');
      return checkInvariants(db, res, { totalInvoices: 3, statuses: ['completed'] }) &&
        inv?.vendor === 'Northstar Cloud Systems' && inv?.amount === 31500 && inv?.status === 'Approved';
    },
  },
  {
    id: 'H5',
    name: 'New Held-Out: Industrial Capital Dispatch (> ₹50k Gate)',
    goal: 'Enter the equipment dispatch note at invoices/heldout_customs_905.txt into http://localhost:3456 and confirm its approval status in the ledger.',
    verify: async (db, res) => {
      const inv = db.invoices.find(i => i.id === 'BPT/2026/778');
      return checkInvariants(db, res, { totalInvoices: 3, statuses: ['completed'] }) &&
        inv?.vendor === 'Bharat Precision Tooling' && inv?.amount === 92500 &&
        inv?.status === 'Pending Approval' && res.approvalEvents.length >= 1;
    },
  },
  {
    id: 'H6',
    name: 'New Held-Out: Disputed Legal Retainer (Ambiguity)',
    goal: 'Log the legal retainer memo in invoices/heldout_disputed_906.txt into Ledgerly at http://localhost:3456.',
    verify: async (db, res) => {
      return checkInvariants(db, res, { totalInvoices: 2, statuses: ['needs_human'] });
    },
  },
];

export async function runHeldOutEvals(tasks = HELDOUT_TASKS) {
  console.log('\n======================================================');
  console.log('🧪 RUNNING HELD-OUT EVALUATION SUITE (1x run per task)');
  console.log('======================================================\n');

  const ledgerly = new LedgerlyApp(PORT);
  await ledgerly.start();
  const results = [];

  try {
    for (const task of tasks) {
      console.log(`\n▶ [Task ${task.id}] ${task.name}`);
      const startTime = Date.now();
      await fetch(`${BASE_URL}/__admin/reset`, { method: 'POST' });

      const agent = new TaskWorkerAgent({ provider: 'azure', maxSteps: 12, headless: true });
      const agentRes = await agent.run({
        goal: task.goal,
        startUrl: BASE_URL,
        runId: `heldout_${task.id}_${Date.now()}`,
      });

      const dbState = await (await fetch(`${BASE_URL}/__admin/state`)).json();
      const passed = await task.verify(dbState, agentRes);
      const sec = (Date.now() - startTime) / 1000;
      const endedAs = `${agentRes.terminationReason}(${agentRes.finishStatus || 'none'})`;

      let tokens = 0;
      if (fs.existsSync(agentRes.tracePath)) {
        for (const line of fs.readFileSync(agentRes.tracePath, 'utf8').trim().split('\n')) {
          try { tokens += JSON.parse(line).usage?.totalTokens || 0; } catch {}
        }
      }

      console.log(`    ${passed ? '✅ PASS' : '❌ FAIL'} (${sec.toFixed(1)}s, turns=${agentRes.llmTurns}/12, tools=${agentRes.stepsTaken}, ended=${endedAs}, tokens=${tokens})`);
      results.push({
        id: task.id,
        name: task.name,
        passed,
        llmTurns: `${agentRes.llmTurns}/12`,
        toolCalls: agentRes.stepsTaken,
        endedAs,
        tokens,
        sec: sec.toFixed(1),
      });
    }
  } finally {
    await ledgerly.stop();
  }

  console.table(results);
  return results;
}

const isDirect = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isDirect) {
  const newOnly = process.argv.includes('--new-only');
  const subset = newOnly ? HELDOUT_TASKS.filter(t => ['H4', 'H5', 'H6'].includes(t.id)) : HELDOUT_TASKS;
  runHeldOutEvals(subset).catch(err => { console.error(err); process.exit(1); });
}
