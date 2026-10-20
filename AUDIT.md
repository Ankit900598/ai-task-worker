# AUDIT.md — Phase 1 Codebase Audit

**Date**: 2026-10-19  
**Scope**: `automation_engine.js`, `lib/dom_extractor.js`, `lib/llm_client.js`

---

## 1. What the Agent Loop Actually Does Each Step

The loop in `automation_engine.js` runs up to `maxSteps` iterations with the following sequence:

1. **Observe (Inputs)**:
   - Calls `DOMExtractor.extractInteractiveState(page)`, which searches the DOM for candidate interactive tags (`a`, `button`, `input`, `select`, etc.), checks basic bounding-box visibility, attaches temporary `data-ai-id="N"` attributes, and constructs a JSON list of up to 75 elements plus a high-level text summary.
2. **Decide (LLM Call)**:
   - Constructs a prompt containing the goal, current URL, page title, element list, and prior action history.
   - Calls `LLMClient.decideNextAction()`, which invokes Azure OpenAI (`gpt-6.1-sol`) with JSON mode, falling back to AWS Bedrock (`kimi-k3`), or a local heuristic mock.
   - Parses the JSON decision: `{ action, targetId, value, pressEnter, reasoning }`.
3. **Act (Tool Execution)**:
   - Executes a hardcoded `switch(decision.action)` statement directly in the main loop:
     - `click`: `page.click('[data-ai-id="..."]')`
     - `type`: `page.fill(...)`
     - `press_key`: `page.keyboard.press(...)`
     - `scroll`: `page.mouse.wheel(...)`
     - `navigate`: `page.goto(...)`
     - `wait`: timer pause
     - `extract`: pushes value to in-memory array
4. **Stop Condition**:
   - `action === 'done'` sets `isDone = true` and breaks out.
   - `action === 'fail'` halts execution with an error explanation.
   - Reaching `maxSteps` exits with an incomplete warning.

---

## 2. Architecture Gap Analysis

| Component Required by SPEC §7 | Exists Today? | Current State / Notes |
| :--- | :---: | :--- |
| **Tool registry with risk tiers** | ❌ No | Actions are hardcoded in an imperative `switch` block in `automation_engine.js`. No `read`/`write`/`destructive` risk classifications exist. |
| **Policy engine & approval gate** | ❌ No | Any action (including state-modifying writes) executes immediately without policy inspection or interactive approval prompts showing exact field values. |
| **Error classes & idempotency rule** | ❌ No | Generic `try/catch` catches all errors as strings. No structured error hierarchy or state pre-check before retrying writes. |
| **State/memory with compaction** | ⚠️ Partial | A raw `history` array stores `{ step, action, targetId, value, urlAfterAction, reasoning }`. No fact extraction, no working memory, and no context compaction when history grows. |
| **Verify-before-finish guard** | ❌ No | The agent can return `action: "done"` at any point, even immediately after a write without reading back confirmation from the application. |
| **JSONL structured trace per run** | ❌ No | Console logs are printed with `console.log`. No machine-readable `.jsonl` trace file recording inputs, prompt tokens, actions, latencies, and tool calls. |
| **Eval harness with state checker** | ❌ No | Only a simple component test (`test_engine.js`) exists. No independent assertions on mock database/app state or repeated multi-run metrics. |

---

## 3. What to Keep vs. What to Rewrite

### What is Worth Keeping
1. **`lib/llm_client.js`**: Dual-provider integration (Azure OpenAI + AWS Bedrock) with failover is functional and resilient. Keep and enhance:
   - Normalize provider output into a single standard tool-calling format: `{ text, toolCalls: [{ id, name, args }], usage, provider, latencyMs }`.
   - Embed system instructions cleanly across both providers.
2. **`lib/dom_extractor.js`**: Simple, dependency-free element indexing. Can be streamlined into the `browser_observe` text representation specified in SPEC §7.3.

### What is Simpler to Rewrite
1. **The imperative `switch` in `automation_engine.js`**:
   - Replace with a formal **Tool Registry** where each tool exports `{ name, description, riskTier, parameters, execute }`.
   - Enforce an **Approval Gate** before any tool marked `riskTier: 'write'` or `destructive`.
2. **Unstructured `history` array**:
   - Replace with a structured **Agent State** (`facts`, `observations`, `plan`, `history`) with automatic compaction.
3. **The `done` action**:
   - Must be intercepted by a **Verification Guard**: if a write occurred since the last observe/read, the guard rejects the finish attempt and instructs the model to inspect and verify the outcome.

---

## 4. Line Budget Targets & Current Status

| Module | Target Budget | Current Lines | Status |
| :--- | :--- | :--- | :--- |
| **Agent core** (loop, state, policy, registry, verify, trace) | ≤ 400 lines | 219 lines (`automation_engine.js`) | Under budget; room for policy & trace |
| **Tools** (files, browser, human gate) | ≤ 200 lines | 0 lines (currently inlined in engine) | Clean modular extraction planned |
| **Mock app "Ledgerly"** | ≤ 250 lines | 0 lines (Phase 2 target) | Planned in `server.js` with `node:http` |
| **Eval harness + tasks** | ≤ 250 lines | 0 lines (Phase 4 target) | Planned in `evals/` |
