/**
 * lib/tracer.js
 * 
 * Machine-readable JSONL execution trace logger.
 * Records step plans, tool calls, observations, policy approvals, and latencies.
 */

import fs from 'fs';
import path from 'path';

export class AgentTracer {
  constructor(runId = `run_${Date.now()}`) {
    this.runId = runId;
    this.runsDir = path.join(process.cwd(), 'runs');
    if (!fs.existsSync(this.runsDir)) {
      fs.mkdirSync(this.runsDir, { recursive: true });
    }
    this.traceFilePath = path.join(this.runsDir, `${this.runId}.jsonl`);
  }

  log(event, payload = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      runId: this.runId,
      event,
      ...payload,
    };
    fs.appendFileSync(this.traceFilePath, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  }

  getTracePath() {
    return this.traceFilePath;
  }

  readTrace() {
    if (!fs.existsSync(this.traceFilePath)) return [];
    return fs.readFileSync(this.traceFilePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }
}
