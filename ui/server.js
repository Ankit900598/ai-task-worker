/**
 * ui/server.js
 *
 * Minimal Live Operator Console for Autonomous AI Task Worker.
 * Built with node:http (zero external dependencies). Budget: <= 200 lines.
 * Features: Basic Auth, non-localhost password enforcement, single-run lock,
 * live JSONL trace timeline, interactive Approve/Deny gate, screenshots, past trace viewer.
 */

import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { TaskWorkerAgent, createBrowser } from '../automation_engine.js';
import { LedgerlyApp } from '../ledgerly/server.js';

const UI_PORT = parseInt(process.env.UI_PORT || '4000', 10);
const LEDGERLY_PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const UI_USER = process.env.UI_USER || 'admin';
const UI_PASS = process.env.UI_PASS || '';

if (!['127.0.0.1', 'localhost'].includes(HOST) && !UI_PASS) {
  console.error('❌ Refusing to bind UI to non-localhost without UI_PASS environment variable set.');
  process.exit(1);
}

const RUNS_DIR = path.join(process.cwd(), 'runs');
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

let activeRun = null; // { runId, goal, status, pendingApproval, resolveApproval, result, screenshot }

function checkAuth(req, res) {
  if (!UI_PASS) return true;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (u === UI_USER && p === UI_PASS) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="CentrAlign Operator UI"' });
  res.end('Authentication required');
  return false;
}

function readJson(req) {
  return new Promise(r => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } });
  });
}

async function startAgentRun(goal, startUrl) {
  const runId = `ui_${Date.now()}`;
  activeRun = { runId, goal, status: 'running', pendingApproval: null, resolveApproval: null, result: null, screenshot: null };
  const { browser, page } = await createBrowser({ headless: true });

  const agent = new TaskWorkerAgent({
    maxSteps: 10,
    maxTokensPerRun: 25000,
    autoApprove: false,
    approvalHandler: async (details) => {
      activeRun.status = 'waiting_approval';
      activeRun.pendingApproval = { reason: details.reason, formValues: details.formValues, prompt: details.prompt };
      const decision = await new Promise(resolve => { activeRun.resolveApproval = resolve; });
      activeRun.pendingApproval = null;
      activeRun.resolveApproval = null;
      activeRun.status = 'running';
      return decision;
    },
  });

  // Capture live screenshot after each browser tool call
  for (const name of ['browser_observe', 'browser_click', 'browser_navigate']) {
    const tool = agent.tools.get(name);
    const orig = tool.execute.bind(tool);
    tool.execute = async (args) => {
      const res = await orig(args);
      const snap = `${runId}_latest.png`;
      await page.screenshot({ path: path.join(RUNS_DIR, snap) }).catch(() => {});
      activeRun.screenshot = `/runs/${snap}?t=${Date.now()}`;
      return res;
    };
  }

  try {
    const res = await agent.run({ goal, startUrl, existingPage: page, runId });
    activeRun.status = 'finished';
    activeRun.result = {
      success: res.success,
      terminationReason: res.terminationReason,
      finishStatus: res.finishStatus,
      evidence: res.evidence,
      llmTurns: res.llmTurns,
      stepsTaken: res.stepsTaken,
    };
  } catch (err) {
    activeRun.status = 'error';
    activeRun.result = { error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

export function createUiServer() {
  return http.createServer(async (req, res) => {
    if (!checkAuth(req, res)) return;
    const url = new URL(req.url, `http://localhost:${UI_PORT}`);

    if (url.pathname === '/api/status' && req.method === 'GET') {
      const traceId = url.searchParams.get('runId') || activeRun?.runId;
      const traceFile = traceId ? path.join(RUNS_DIR, `${path.basename(traceId)}.jsonl`) : null;
      const trace = traceFile && fs.existsSync(traceFile)
        ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
        : [];
      const pastRuns = fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('.jsonl')).sort().reverse().slice(0, 25).map(f => f.replace('.jsonl', ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ activeRun: activeRun ? { ...activeRun, resolveApproval: undefined } : null, trace, pastRuns }));
    }

    if (url.pathname === '/api/run' && req.method === 'POST') {
      if (activeRun && ['running', 'waiting_approval'].includes(activeRun.status)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'A run is already in progress.' }));
      }
      const { goal, startUrl } = await readJson(req);
      startAgentRun(goal || 'Read invoices/inv_high_value.txt and enter it into Ledgerly.', startUrl || `http://localhost:${LEDGERLY_PORT}`);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ started: true, runId: activeRun.runId }));
    }

    if (url.pathname === '/api/approve' && req.method === 'POST') {
      const { approved } = await readJson(req);
      if (activeRun?.resolveApproval) activeRun.resolveApproval(Boolean(approved));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (url.pathname.startsWith('/runs/') && req.method === 'GET') {
      const file = path.join(RUNS_DIR, path.basename(url.pathname));
      if (fs.existsSync(file) && file.endsWith('.png')) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(fs.readFileSync(file));
      }
      res.writeHead(404);
      return res.end('Not found');
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>CentrAlign AI Worker Console</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #0f172a; color: #e2e8f0; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; max-width: 1300px; margin: 0 auto; }
  .card { background: #1e293b; padding: 16px; border-radius: 8px; border: 1px solid #334155; }
  input, select, button { padding: 8px 12px; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: #fff; }
  button { background: #2563eb; border: none; font-weight: 600; cursor: pointer; }
  .gate { background: #78350f; border: 2px solid #f59e0b; padding: 12px; border-radius: 8px; margin: 12px 0; }
  pre { background: #0f172a; padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 12px; max-height: 420px; }
  img { width: 100%; border-radius: 6px; border: 1px solid #334155; }
</style></head><body>
<div class="grid">
  <div class="card">
    <h2>🤖 Autonomous AI Task Worker</h2>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <input id="goal" style="flex:1" value='Read high-value invoice "invoices/inv_high_value.txt" and enter it into Ledgerly at http://localhost:${LEDGERLY_PORT}. Verify status before finishing.' />
      <button onclick="startRun()">Start Run</button>
    </div>
    <div id="gateBox"></div>
    <div id="reportBox"></div>
    <h3>📜 Step Timeline & Past Traces <select id="pastSelect" onchange="poll()"></select></h3>
    <pre id="timeline">Idle.</pre>
  </div>
  <div class="card">
    <h3>🖥️ Live Browser Screenshot (<a href="http://localhost:${LEDGERLY_PORT}" target="_blank" style="color:#60a5fa">Open Ledgerly</a>)</h3>
    <img id="snap" alt="No screenshot yet" />
  </div>
</div>
<script>
async function startRun() {
  document.getElementById('pastSelect').value = '';
  await fetch('/api/run', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ goal: document.getElementById('goal').value }) });
  poll();
}
async function decide(approved) {
  await fetch('/api/approve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ approved }) });
  poll();
}
async function poll() {
  const sel = document.getElementById('pastSelect').value;
  const r = await (await fetch('/api/status' + (sel ? '?runId=' + sel : ''))).json();
  const ps = document.getElementById('pastSelect');
  if (ps.options.length <= 1 && r.pastRuns) {
    ps.innerHTML = '<option value="">-- Live / Latest Run --</option>' + r.pastRuns.map(x => '<option value="'+x+'">'+x+'</option>').join('');
  }
  const ar = r.activeRun;
  document.getElementById('gateBox').innerHTML = ar?.pendingApproval ? \`<div class="gate"><strong>⚠️ APPROVAL GATE REQUIRED</strong><pre>\${ar.pendingApproval.prompt}</pre><button onclick="decide(true)" style="background:#16a34a;margin-right:8px">Approve Submit</button><button onclick="decide(false)" style="background:#dc2626">Deny</button></div>\` : '';
  document.getElementById('reportBox').innerHTML = ar?.result ? \`<pre>Status: \${ar.status} | Ended: \${ar.result.terminationReason || ''} (\${ar.result.finishStatus || ''})\\nEvidence: \${ar.result.evidence || ar.result.error || ''}</pre>\` : '';
  if (ar?.screenshot) document.getElementById('snap').src = ar.screenshot;
  document.getElementById('timeline').textContent = (r.trace || []).map((e, i) => \`[\${i+1}] \${e.event} \${e.name || ''} \${e.text || e.error || (e.result ? String(e.result).slice(0,120) : '')}\`).join('\\n') || 'No events.';
}
setInterval(poll, 1500); poll();
</script></body></html>`);
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const ledgerly = new LedgerlyApp(LEDGERLY_PORT);
  ledgerly.start().then(() => {
    createUiServer().listen(UI_PORT, HOST, () => console.log(`🖥️  Operator UI running on http://${HOST}:${UI_PORT}`));
  });
}
