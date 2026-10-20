/**
 * lib/state.js
 * 
 * Structured agent memory, facts extraction, history compaction, and error hierarchy.
 */

// Error Classes
export class AgentError extends Error {
  constructor(message, code = 'AGENT_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class PolicyViolationError extends AgentError {
  constructor(message) {
    super(message, 'POLICY_VIOLATION');
  }
}

export class VerificationError extends AgentError {
  constructor(message) {
    super(message, 'VERIFICATION_FAILED');
  }
}

export class IdempotencyError extends AgentError {
  constructor(message) {
    super(message, 'IDEMPOTENCY_CONFLICT');
  }
}

export class AgentState {
  constructor(goal = '') {
    this.goal = goal;
    this.facts = {};
    this.formValues = {};
    this.elementMap = {};
    this.history = [];
    this.writesSinceLastObserve = 0;
    this.lastObservation = null;
    this.isDone = false;
    this.finishStatus = null;
    this.finalEvidence = null;
  }

  recordObservation(observationText, elementList = []) {
    this.lastObservation = observationText;
    this.writesSinceLastObserve = 0;
    if (Array.isArray(elementList)) {
      this.elementMap = {};
      for (const el of elementList) this.elementMap[el.id] = el;
    }
  }

  recordWrite() {
    this.writesSinceLastObserve += 1;
  }

  recordFormField(descriptor = '', text = '') {
    const d = String(descriptor).toLowerCase();
    const v = String(text);
    if (d.includes('due')) this.formValues.dueDate = v;
    else if (d.includes('date') || d.includes('issue')) this.formValues.date = v;
    else if (d.includes('amount') || d.includes('total')) this.formValues.amount = v;
    else if (d.includes('vendor') || d.includes('supplier')) this.formValues.vendor = v;
    else if (d.includes('note') || d.includes('memo')) this.formValues.notes = v;
    else if (d.includes('invoice') || d.includes('voucher') || d.includes('code')) this.formValues.invoiceId = v;
  }

  addFact(key, value) {
    this.facts[key] = value;
  }

  addStep(stepData) {
    this.history.push({
      step: this.history.length + 1,
      timestamp: new Date().toISOString(),
      ...stepData,
    });
  }

  /**
   * Compaction: Keeps the last 5 steps in full detail, and summarizes earlier steps.
   */
  getCompactedHistory() {
    if (this.history.length <= 6) {
      return this.history;
    }
    const recent = this.history.slice(-5);
    const older = this.history.slice(0, -5);
    const summary = older.map(s => `Step ${s.step}: [${s.action}] -> ${s.summary || 'done'}`).join('; ');
    return [
      { step: '1-compaction', summary: `Prior steps compacted: ${summary}` },
      ...recent,
    ];
  }
}
