/**
 * lib/policy.js
 * 
 * Policy Engine & Human Approval Gate.
 * Enforces risk tiers, executive approval on SUBMIT click when Amount > ₹50,000,
 * and guards against prompt injection from untrusted invoice/web content.
 */

import { PolicyViolationError } from './state.js';

/**
 * Strictly parses a numeric/currency amount string (e.g. "84,000", "₹45,430.50", 84000).
 * Rejects dates ("2026-11-20"), document codes ("DOC#99999"), or non-amount strings with NaN.
 */
export function parseAmountStrict(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw !== 'string') return NaN;
  const trimmed = raw.trim();
  if (!trimmed) return NaN;
  const strictPattern = /^[₹$€]?\s*(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?$/;
  if (!strictPattern.test(trimmed)) return NaN;
  return Number(trimmed.replace(/[₹$€,\s]/g, ''));
}

export class PolicyEngine {
  constructor(options = {}) {
    this.approvalThreshold = options.approvalThreshold || 50000;
    this.autoApprove = options.autoApprove ?? true;
    this.approvalHandler = options.approvalHandler || null;
  }

  isSubmitClick(tool, args, state) {
    if (tool.riskTier === 'destructive') return true;
    if (tool.name !== 'browser_click') return false;
    const el = state?.elementMap?.[args?.elementId];
    if (!el) return true;
    return el.type === 'submit' || /submit|save|confirm|post/i.test(`${el.name || ''} ${el.label || ''}`);
  }

  /**
   * Evaluates planned action against company safety policies.
   */
  async checkAction({ tool, args, state }) {
    // 1. Untrusted Prompt Injection Detection
    if (args && typeof args === 'object') {
      const serialized = JSON.stringify(args).toLowerCase();
      if (serialized.includes('ignore previous instructions') || serialized.includes('wipe the audit')) {
        throw new PolicyViolationError('Security Alert: Prompt injection attempt detected in tool arguments. Action blocked.');
      }
    }

    // 2. Read tools and typing never trigger the approval gate
    if (tool.riskTier === 'read' || !this.isSubmitClick(tool, args, state)) {
      return { allowed: true, requiredApproval: false };
    }

    // 3. Submit Click / Destructive Policy Check (reads amount ONLY from Amount field, parsed strictly)
    const fv = args?.formValues || state?.formValues || {};
    const parsedAmount = parseAmountStrict(fv.amount);
    let requiresApproval = false;
    let reason = 'Standard write action';

    if (Number.isFinite(parsedAmount) && parsedAmount > this.approvalThreshold) {
      requiresApproval = true;
      reason = `Amount (₹${parsedAmount.toLocaleString('en-IN')}) exceeds ₹${this.approvalThreshold.toLocaleString('en-IN')} approval threshold.`;
    } else if (tool.riskTier === 'destructive') {
      requiresApproval = true;
      reason = 'Destructive operation requested.';
    }

    if (!requiresApproval) {
      return { allowed: true, requiredApproval: false };
    }

    // 4. Approval Gate Prompting with ALL form values and true Ledgerly field labels
    const prompt = `[APPROVAL GATE] SUBMIT requires authorization.\n` +
      `Reason: ${reason}\n` +
      `Form Values:\n` +
      `  Invoice ID / Number: ${fv.invoiceId || 'N/A'}\n` +
      `  Vendor / Supplier:   ${fv.vendor || 'N/A'}\n` +
      `  Total Amount (₹):    ${fv.amount ?? 'N/A'}\n` +
      `  Invoice Date:        ${fv.date || 'N/A'}\n` +
      `  Due Date:            ${fv.dueDate || 'N/A'}`;
    console.log(`\n⚠️  ${prompt}`);

    if (this.approvalHandler) {
      const approved = await this.approvalHandler({ tool, args, reason, formValues: fv, prompt });
      if (!approved) throw new PolicyViolationError(`Action rejected by human operator: ${reason}`);
      return { allowed: true, requiredApproval: true, approvedBy: 'human', prompt, formValues: fv };
    }

    if (this.autoApprove) {
      console.log(`🛡️  [APPROVAL GATE] Policy satisfied. Approved under autonomous execution policy.`);
      return { allowed: true, requiredApproval: true, approvedBy: 'policy-gate', prompt, formValues: fv };
    }

    throw new PolicyViolationError(`Action blocked pending human approval: ${reason}`);
  }
}
