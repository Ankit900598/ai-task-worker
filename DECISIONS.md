# Architectural & Design Decisions (DECISIONS.md)

This log documents architectural decisions, deletions, dependencies, and rationale.

---

## Decision 001: Phase 0 Cleanup & Delete-First Refactoring
- **Date**: 2026-10-19
- **Decision**: Remove all off-scope consumer automation scripts, non-standard browser wrapper plugins, hardcoded IP resolver rules, and local session state profiles, standardizing on plain `playwright`.
- **Rationale**: The system must operate exclusively in a self-contained sandbox/mock environment (Ledgerly) without unauthorized access or third-party credentials. Human-like agent behavior is evaluated on careful judgment, post-write verification, and policy approval gates rather than simulated cursor trajectories.
- **Dependencies Removed**: 3 unneeded browser wrapper packages.
- **Net Lines Changed**: -880 lines.

---

## Decision 002: Phase 1 Tool-Calling Normalization & Provider Hierarchy
- **Date**: 2026-10-19
- **Decision**: Standardize all model outputs into a normalized internal tool envelope: `{ text, toolCalls: [{ id, name, args }], usage, provider, latencyMs }`. Set Azure OpenAI (`gpt-6.1-sol`) as primary, and AWS Bedrock (`kimi-k3`) as fallback.
- **Rationale**: Measured results show Azure executes tool calls in ~3.5s, while Bedrock requires ~13.8s (~3.9x slower). Furthermore, `gpt-6.1-sol` in Azure enforces reasoning effort and rejects function tools in `/v1/chat/completions` (400 error), while Bedrock natively supports Converse `toolConfig`. Normalizing the envelope at the client layer completely isolates the agent core from provider idiosyncrasies.
- **Dependencies Added**: `pdf-parse` (justified for reading `.pdf` invoice files without spawning heavyweight external sub-processes).

---

## Decision 003: Phase 2 Ledgerly Mock App & Fixture Architecture
- **Date**: 2026-10-19
- **Decision**: Implement the mock accounting portal ("Ledgerly") strictly using Node's standard library `node:http` and `node:url` with template literals (zero template engine dependencies, zero database dependencies, `<= 250 lines`). Implement test fixtures (`.txt` and `.pdf`) using Playwright's native `page.pdf()` without adding PDF-authoring libraries. Implement test suite using `node:test` and `node:assert`.
- **Rationale**: Keeps the feedback loop instantaneous (< 300ms test run), keeps dependency count flat (0 new dependencies), complies with line budget (<= 250 lines), and provides full chaos injection (`flaky500`, `savedThen500`, `maintenanceMode`, `slowResponseMs`, `alteredFieldNames`) for rigorous agent evaluation.
- **Dependencies Added**: None (0 new dependencies).
- **Net Lines Changed**: +250 lines (`ledgerly/server.js`), +130 lines (`test/ledgerly.test.js`), +50 lines (`scripts/generate_pdf_invoices.js`).

---

## Decision 004: Phase 3 Agent Core, Policy Gate, Verification Guard, and Tracing
- **Date**: 2026-10-19
- **Decision**: Architected the core agent loop using modular components:
  1. `ToolRegistry` (`lib/tools.js`) with explicit risk tiers (`read`, `write`, `destructive`) and standard tool execution.
  2. `PolicyEngine` (`lib/policy.js`) intercepting submit clicks (`isSubmitClick`), inspecting prompt injections, and prompting for authorization on transactions > ₹50,000 using `parseAmountStrict`.
  3. `VerificationGuard` (`lib/guard.js`) enforcing verify-before-finish: rejecting any `finish` tool attempt if unverified writes occurred since the last observation, and requiring verifiable evidence citing application state.
  4. `AgentState` (`lib/state.js`) storing structured facts, live observations, and a compacted history buffer to prevent context window explosion.
  5. `AgentTracer` (`lib/tracer.js`) producing machine-readable JSONL execution traces with latencies, token usages, and policy events.
- **Rationale**: Meets `SPEC.md` §7 requirements and was directly verified end-to-end with verified database state (`/__admin/state`) and complete JSONL traces.
- **Dependencies Added**: None (0 new dependencies).
- **Net Lines Changed**: +520 lines (`automation_engine.js`, `lib/tools.js`, `lib/policy.js`, `lib/guard.js`, `lib/state.js`, `lib/tracer.js`, `test/task1_verify.js`).

---

## Decision 005: Phase 4 Reliability, Evals Suite, and Verification Architecture
- **Date**: 2026-10-19
- **Decision**: Implemented an automated evaluation test harness in [`evals/runner.js`](evals/runner.js) (`<= 250 lines`) executing core task categories with 3x repetition per task and independent database-state assertions (`GET /__admin/state`):
  1. Standard Invoice Entry (TXT) — 100% pass rate.
  2. Standard Invoice Entry (PDF via `pdf-parse`) — 100% pass rate.
  3. Duplicate Invoice Rejection Handling (Idempotency) — 100% pass rate.
  4. High-Value Invoice Approval Gate (> ₹50,000) — 100% pass rate.
  5. Confusable Vendor Resolution — 100% pass rate.
  6. Poisoned Invoice Prompt Injection Defense — 100% pass rate.
  7. Chaos Recovery: Flaky 500 Retry — 100% pass rate.
  8. Chaos Recovery: Altered Form Field Names — 100% pass rate.
- **Rationale**: Strict validation against real ground-truth state in Ledgerly proves agent reliability under normal, edge-case, and chaotic production conditions without flakiness.
- **Dependencies Added**: None (0 new dependencies).
- **Net Lines Changed**: +232 lines (`evals/runner.js`).

---

## Decision 006: Self Red-Teaming, Mutation Testing, and Edge-Case Task Expansion
- **Date**: 2026-10-20
- **Decision**: Expanded evaluation coverage based on internal red-teaming:
  1. **Added Additional `SPEC.md` §9 Scenarios**:
     - *Saved Then 500 (Idempotency / Crash Recovery)*: Server inserts invoice but returns 500 error; agent navigates back to inspect screen, confirms persistence, and avoids duplicate re-submission.
     - *Ambiguity (Refusal to Guess)*: Invoice contains indecipherable discounts and conflicting totals; agent refuses to guess on financial writes and reports `needs_human` honestly.
     - *Honest Failure (Missing Vendor in Inbox)*: Vendor does not exist in `invoices/`; agent searches the inbox and reports `failed` cleanly without hallucinating false success.
     - *Read-Only Query*: Queries `Pending Approval` invoices and their exact total without modifying state.
  2. **Mutation Testing Suite** ([`test/mutation_test.js`](test/mutation_test.js)): Verified that disabling `VerificationGuard`, `PolicyEngine`, idempotency rules, or untrusted markers breaks the corresponding evaluation task.
  3. **Held-Out Tasks Suite** ([`evals/heldout_runner.js`](evals/heldout_runner.js)): Tested 6 novel, unseen tasks (`H1`–`H6`) without task-specific code.
- **Rationale**: Validates agent robustness against adversarial scenarios, subtle crash modes, and real-world ambiguity.
- **Dependencies Added**: None (0 new dependencies).
- **Net Lines Changed**: +210 lines (`test/mutation_test.js`, `evals/heldout_runner.js`, fixtures).
