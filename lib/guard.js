/**
 * lib/guard.js
 * 
 * Verification Guard and Untrusted Content Sanitizer.
 * Enforces rule: "Reject finish if a write happened since the last read-back/observe; requires evidence."
 */

import { VerificationError } from './state.js';

export class VerificationGuard {
  /**
   * Asserts whether the agent is legally permitted to complete the task.
   */
  static verifyFinish({ state, args }) {
    // Rule 1: A write occurred without an observation afterwards
    if (state.writesSinceLastObserve > 0) {
      throw new VerificationError(
        `Verification Guard Rejected: An action modified state (${state.writesSinceLastObserve} write(s) pending), but no observation/read-back was performed to verify the outcome in the application. You must inspect the screen or ledger before finishing.`
      );
    }

    // Rule 2: Evidence is required to finish
    const evidence = args?.evidence || args?.value;
    if (!evidence || String(evidence).trim().length < 5) {
      throw new VerificationError(
        `Verification Guard Rejected: Task completion requires verifiable proof/evidence in the "evidence" field.`
      );
    }

    return true;
  }

  /**
   * Encloses file or web text within strict untrusted content boundary markers.
   */
  static wrapUntrusted(source, content) {
    return `<UNTRUSTED_CONTENT source="${source}">\n${content}\n</UNTRUSTED_CONTENT>`;
  }
}
